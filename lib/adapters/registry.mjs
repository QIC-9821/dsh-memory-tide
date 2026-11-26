// Adapter registry — owns the built-in adapters (fish, evolve), the custom
// file adapters from settings.customAdapters, and third-party adapters that
// registered themselves at runtime.
//
// Custom adapters are loaded lazily: a missing or broken module only produces a
// logger.warn and is skipped, it never takes the plugin down (SPEC §7.3).

import { createFishAdapter } from './fish.mjs'
import { createEvolveAdapter } from './evolve.mjs'
import { resolveStandalonePath } from '../settings.mjs'

const CUSTOM_MODULES = Object.freeze({
  'file-md': './file-md.mjs',
  'file-json': './file-json.mjs',
})

const CUSTOM_FACTORY_NAMES = Object.freeze({
  'file-md': ['createFileMdAdapter', 'createAdapter', 'create', 'default'],
  'file-json': ['createFileJsonAdapter', 'createAdapter', 'create', 'default'],
})

function makeLogger(logger) {
  const target = logger || {}
  return {
    info: (...args) => target.info?.(...args),
    warn: (...args) => target.warn?.(...args),
    error: (...args) => target.error?.(...args),
  }
}

function entryKey(adapterId, entry) {
  if (entry?.key) return entry.key
  if (entry?.entryId != null) return `${adapterId}:${entry.entryId}`
  return `${adapterId}:(unknown)`
}

function normalizeList(adapter, value) {
  const entries = Array.isArray(value) ? value : []
  return entries
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      ...entry,
      adapterId: entry.adapterId || adapter.id,
      key: entryKey(entry.adapterId || adapter.id, entry),
      tags: Array.isArray(entry.tags) ? entry.tags : [],
    }))
}

function normalizeRemoval(value, requested) {
  const input = Array.isArray(requested) ? requested : []
  if (!value || typeof value !== 'object') {
    return {
      removed: [],
      failed: input.map((entry) => ({
        key: entryKey('adapter', entry),
        error: 'adapter returned no result',
      })),
    }
  }
  const removed = Array.isArray(value.removed) ? value.removed.map(String) : []
  const failed = Array.isArray(value.failed)
    ? value.failed.map((item) => ({
        key: String(item?.key ?? ''),
        error: String(item?.error ?? 'unknown error'),
      }))
    : []
  return { removed, failed }
}

/**
 * Wrap an externally supplied adapter so that one broken method cannot throw
 * into the sweep. Built-in adapters are already safe and are not wrapped.
 */
function guardAdapter(raw, log) {
  const describe =
    typeof raw.describe === 'function'
      ? async () => {
          try {
            const value = await raw.describe()
            return {
              path: typeof value?.path === 'string' ? value.path : '',
              count: Number.isFinite(value?.count) ? value.count : 0,
              missing: value?.missing === true,
            }
          } catch (error) {
            log.warn(`[memory-tide] adapter ${raw.id} describe failed: ${error.message}`)
            return { path: '', count: 0, missing: false }
          }
        }
      : async () => ({ path: '', count: 0, missing: false })

  return {
    ...raw,
    async describe() {
      return describe()
    },
    async list() {
      try {
        return normalizeList(raw, await raw.list())
      } catch (error) {
        log.warn(`[memory-tide] adapter ${raw.id} list failed: ${error.message}`)
        return []
      }
    },
    async remove(entries) {
      const requested = Array.isArray(entries) ? entries : []
      try {
        return normalizeRemoval(await raw.remove(requested), requested)
      } catch (error) {
        log.warn(`[memory-tide] adapter ${raw.id} remove failed: ${error.message}`)
        return {
          removed: [],
          failed: requested.map((entry) => ({
            key: entryKey(raw.id, entry),
            error: error.message,
          })),
        }
      }
    },
    async add(entry) {
      if (typeof raw.add !== 'function') {
        return { ok: false, error: `adapter "${raw.id}" does not support add` }
      }
      try {
        const value = await raw.add(entry)
        return value && typeof value === 'object'
          ? value
          : { ok: false, error: 'adapter returned no result' }
      } catch (error) {
        return { ok: false, error: error.message }
      }
    },
  }
}

export function createRegistry(options = {}) {
  const { logger } = options
  const log = makeLogger(logger)
  // settings 会被保存操作替换成新对象，所以通过 getter 取「当前设置」。
  const currentSettings = () =>
    typeof options.getSettings === 'function' ? options.getSettings() : options.settings
  const loadModule =
    typeof options.loadAdapterModule === 'function'
      ? options.loadAdapterModule
      : (specifier) => import(specifier)

  const sources = new Map()
  let builtins = []
  let customs = []
  let queue = Promise.resolve()

  function rebuildBuiltins() {
    const settings = currentSettings()
    builtins = [
      createFishAdapter({ settings, logger: log }),
      createEvolveAdapter({ settings, logger: log }),
    ]
  }

  async function loadCustom(item) {
    const label = item.label || item.id
    const settings = currentSettings()
    const specifier = CUSTOM_MODULES[item.type]
    if (!specifier) {
      log.warn(`[memory-tide] custom adapter "${label}" skipped: unsupported type "${item.type}"`)
      return null
    }
    let module
    try {
      module = await loadModule(specifier, item)
    } catch (error) {
      log.warn(
        `[memory-tide] custom adapter "${label}" skipped: cannot load ${specifier} (${error.message})`,
      )
      return null
    }
    const names = CUSTOM_FACTORY_NAMES[item.type] || []
    const factory = names.map((name) => module?.[name]).find((value) => typeof value === 'function')
    if (!factory) {
      log.warn(
        `[memory-tide] custom adapter "${label}" skipped: ${specifier} exports no adapter factory`,
      )
      return null
    }
    let adapter
    try {
      // The bundled file adapters take a flat config object (id/path/label/...),
      // so the settings item is spread at the top level; factories written in the
      // { config, settings, logger } style still find everything they need.
      adapter = await factory({ ...item, config: item, item, settings, logger: log })
    } catch (error) {
      log.warn(`[memory-tide] custom adapter "${label}" skipped: factory failed (${error.message})`)
      return null
    }
    if (!adapter && item) {
      // Tolerate a positional factory signature: factory(config, context).
      try {
        adapter = await factory(item, { settings, logger: log })
      } catch (error) {
        log.warn(
          `[memory-tide] custom adapter "${label}" skipped: factory failed (${error.message})`,
        )
        return null
      }
    }
    if (!adapter || typeof adapter !== 'object') {
      log.warn(`[memory-tide] custom adapter "${label}" skipped: factory returned no adapter`)
      return null
    }
    if (typeof adapter.list !== 'function' || typeof adapter.remove !== 'function') {
      log.warn(
        `[memory-tide] custom adapter "${label}" skipped: adapter has no list/remove methods`,
      )
      return null
    }
    const normalized = {
      ...adapter,
      id: item.id || adapter.id,
      label: adapter.label || label,
      kind: adapter.kind || item.type,
    }
    return guardAdapter(normalized, log)
  }

  function adapters() {
    const seen = new Set()
    const out = []
    for (const adapter of [...builtins, ...customs, ...sources.values()]) {
      if (!adapter || !adapter.id || seen.has(adapter.id)) continue
      seen.add(adapter.id)
      out.push(adapter)
    }
    return out
  }

  function get(id) {
    if (id == null) return undefined
    return adapters().find((adapter) => adapter.id === id)
  }

  async function runReload() {
    rebuildBuiltins()
    const settings = currentSettings()
    const items = Array.isArray(settings?.customAdapters) ? settings.customAdapters.slice() : []
    // 独立记忆文件：不装任何记忆插件时，潮汐也能清扫这一个文件。
    const standalone = settings?.standalone
    if (standalone && standalone.enabled !== false) {
      items.unshift({
        id: 'standalone',
        type: 'file-md',
        label: '独立记忆文件',
        path: resolveStandalonePath(settings),
        mode: standalone.mode === 'delete' ? 'delete' : 'archive',
        format: { delimiter: standalone.delimiter || 'blank' },
      })
    }
    const loaded = []
    for (const item of items) {
      if (!item || typeof item !== 'object' || !item.id) continue
      const adapter = await loadCustom(item)
      if (adapter) loaded.push(adapter)
    }
    customs = loaded
    return adapters()
  }

  function reload() {
    const next = queue.then(runReload, runReload)
    queue = next.catch(() => {})
    return next
  }

  function registerSource(source) {
    if (!source || typeof source !== 'object') {
      throw new TypeError('[memory-tide] registerSource expects an adapter object')
    }
    if (typeof source.id !== 'string' || !source.id) {
      throw new TypeError('[memory-tide] registerSource: adapter.id must be a non-empty string')
    }
    if (typeof source.list !== 'function' || typeof source.remove !== 'function') {
      throw new TypeError('[memory-tide] registerSource: adapter must implement list() and remove()')
    }
    const adapter = guardAdapter(
      {
        ...source,
        label: source.label || source.id,
        kind: source.kind || 'builtin',
      },
      log,
    )
    sources.set(adapter.id, adapter)
    return adapter
  }

  function unregisterSource(id) {
    if (id == null) return false
    return sources.delete(String(id))
  }

  rebuildBuiltins()
  // Load the custom adapters in the background; adapters() stays synchronous.
  reload().catch((error) => {
    log.warn(`[memory-tide] initial adapter load failed: ${error.message}`)
  })

  return { adapters, get, reload, registerSource, unregisterSource }
}
