// dsh-memory-tide — HTTP surface for the settings page
// Path: lib/routes.mjs
//
// Mounted at /memory-tide. Every response is { ok:true, data } or
// { ok:false, error }; only GET and POST are accepted; request bodies are
// capped at 1 MiB. Business failures use 4xx/5xx but still keep the envelope.

import { randomUUID } from 'node:crypto'

const PREFIX = '/memory-tide'
const API_PREFIX = '/memory-tide/api/'
const MAX_BODY_BYTES = 1024 * 1024

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
}

function send(res, status, payload, extraHeaders = {}) {
  let body
  try {
    body = Buffer.from(JSON.stringify(payload), 'utf8')
  } catch (error) {
    status = 500
    body = Buffer.from(JSON.stringify({ ok: false, error: `serialize failed: ${error?.message || error}` }), 'utf8')
  }
  try {
    res.writeHead(status, { ...JSON_HEADERS, 'content-length': body.length, ...extraHeaders })
    res.end(body)
  } catch {
    try {
      res.end()
    } catch {
      // The socket may already be gone; nothing useful can be done here.
    }
  }
}

function fail(res, status, error, extraHeaders) {
  return send(res, status, { ok: false, error: String(error?.message || error) }, extraHeaders)
}

function ok(res, data) {
  return send(res, 200, { ok: true, data })
}

async function readBody(req, limit = MAX_BODY_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > limit) {
      const error = new Error(`request body exceeds ${limit} bytes`)
      error.code = 'E_BODY_TOO_LARGE'
      throw error
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

async function readJson(req, limit = MAX_BODY_BYTES) {
  const body = await readBody(req, limit)
  if (!body.length) return {}
  const text = body.toString('utf8').trim()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch (error) {
    const wrapped = new Error(`invalid JSON body: ${error?.message || error}`)
    wrapped.code = 'E_BAD_JSON'
    throw wrapped
  }
}

function safeAdapters(registry) {
  try {
    const list = registry?.adapters?.()
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

async function resolveBoard(deps) {
  if (deps?.board && typeof deps.board.listEntries === 'function' && typeof deps.board.act === 'function') {
    return deps.board
  }
  return import('./board.mjs')
}

async function resolveSaveSettings(deps) {
  if (typeof deps?.saveSettings === 'function') return deps.saveSettings
  const mod = await import('./settings.mjs')
  return mod.saveSettings
}

async function resolveReadLog(deps) {
  if (typeof deps?.readLog === 'function') return deps.readLog
  if (typeof deps?.stateRepo?.readLog === 'function') return deps.stateRepo.readLog
  const mod = await import('./store.mjs')
  return mod.readLog
}

function normalizeSaved(result) {
  if (result && typeof result === 'object' && result.settings && typeof result.settings === 'object') {
    return { settings: result.settings, warnings: Array.isArray(result.warnings) ? result.warnings : [] }
  }
  return { settings: result && typeof result === 'object' ? result : {}, warnings: [] }
}

function clampInt(value, fallback, min, max) {
  if (value === null || value === undefined || value === '') return fallback
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

/**
 * Build the request handler handed to webServer.register().
 * Exported separately so tests can drive it without a host ctx.
 */
export function createHandler(deps = {}) {
  const logger = deps.logger ?? { info() {}, warn() {}, error() {} }
  const getSettings = () =>
    typeof deps.getSettings === 'function' ? deps.getSettings() : deps.settings ?? {}
  const getState = () => (typeof deps.getState === 'function' ? deps.getState() : deps.state)

  async function buildStatePayload() {
    const settings = getSettings()
    const state = getState()
    const adapters = []
    let active = 0

    for (const adapter of safeAdapters(deps.registry)) {
      if (!adapter?.id) continue
      let info = {}
      let count = 0
      try {
        info = (await adapter.describe?.()) ?? {}
      } catch (error) {
        logger.warn(`describe(${adapter.id}) failed: ${error?.message || error}`)
      }
      try {
        const list = await adapter.list()
        count = Array.isArray(list) ? list.length : 0
      } catch (error) {
        logger.warn(`list(${adapter.id}) failed: ${error?.message || error}`)
      }
      active += count
      adapters.push({
        id: adapter.id,
        label: adapter.label || adapter.id,
        path: typeof info?.path === 'string' ? info.path : '',
        count,
        enabled: settings?.adapters?.[adapter.id]?.enabled !== false,
      })
    }

    let archived = 0
    let cold = 0
    const items = state?.items && typeof state.items === 'object' ? state.items : {}
    for (const item of Object.values(items)) {
      if (item?.state === 'archived') archived += 1
      else if (item?.state === 'cold') cold += 1
    }

    return {
      settings,
      stats: { active, archived, cold },
      adapters,
      lastSweepAt: state?.lastSweepAt ?? 0,
      firstSweepDone: state?.firstSweepDone === true,
      firstRunReport:
        typeof deps.getFirstRunReport === 'function' ? deps.getFirstRunReport() : deps.firstRunReport ?? null,
    }
  }

  const routes = {
    state: {
      method: 'GET',
      async handle() {
        return { status: 200, data: await buildStatePayload() }
      },
    },

    settings: {
      method: 'POST',
      async handle(req) {
        const body = await readJson(req)
        const patch = body?.patch
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
          return { status: 400, error: 'patch object is required' }
        }
        const save = await resolveSaveSettings(deps)
        const saved = normalizeSaved(await save(patch))
        deps.settings = saved.settings
        try {
          await deps.onSettingsApplied?.(saved.settings)
        } catch (error) {
          logger.warn(`onSettingsApplied failed: ${error?.message || error}`)
        }
        return { status: 200, data: { settings: saved.settings, warnings: saved.warnings } }
      },
    },

    entries: {
      method: 'GET',
      async handle(_req, url) {
        const board = await resolveBoard(deps)
        const settings = getSettings()
        const query = {
          state: url.searchParams.get('state') || 'all',
          adapter: url.searchParams.get('adapter') || '',
          q: url.searchParams.get('q') || '',
          page: clampInt(url.searchParams.get('page'), 1, 1, Number.MAX_SAFE_INTEGER),
          pageSize: clampInt(
            url.searchParams.get('pageSize'),
            Number(settings?.board?.pageSize) || 100,
            1,
            500,
          ),
        }
        const result = await board.listEntries({
          registry: deps.registry,
          state: getState(),
          settings,
          query,
          store: deps.stateRepo ?? deps.store ?? null,
        })
        return { status: 200, data: result }
      },
    },

    action: {
      method: 'POST',
      async handle(req) {
        const body = await readJson(req)
        const op = typeof body?.op === 'string' ? body.op : ''
        const allowed = ['archive', 'delete', 'restore', 'pin', 'unpin']
        if (!allowed.includes(op)) {
          return { status: 400, error: `op must be one of: ${allowed.join(', ')}` }
        }
        if (!Array.isArray(body?.keys)) {
          return { status: 400, error: 'keys must be an array' }
        }
        if (body.keys.length > 10000) {
          return { status: 400, error: 'too many keys (max 10000)' }
        }
        const board = await resolveBoard(deps)
        const result = await board.act({
          registry: deps.registry,
          state: getState(),
          settings: getSettings(),
          op,
          keys: body.keys.map((key) => String(key)),
          store: deps.stateRepo ?? deps.store ?? null,
        })
        return { status: 200, data: { results: result?.results ?? [] } }
      },
    },

    sweep: {
      method: 'POST',
      async handle(req) {
        const body = await readJson(req)
        const dryRun = body?.dryRun === true
        if (typeof deps.sweep !== 'function') {
          return { status: 500, error: 'sweep is unavailable' }
        }
        const report = await deps.sweep({ dryRun })
        return { status: 200, data: { report } }
      },
    },

    scan: {
      method: 'POST',
      async handle() {
        const scan = typeof deps.scan === 'function' ? deps.scan : (await import('./discovery.mjs')).scan
        const result = await scan({ settings: getSettings(), logger })
        return {
          status: 200,
          data: {
            found: Array.isArray(result?.found) ? result.found : [],
            skipped: Array.isArray(result?.skipped) ? result.skipped : [],
          },
        }
      },
    },

    adopt: {
      method: 'POST',
      async handle(req) {
        const body = await readJson(req)
        const settings = getSettings()
        let patch = null

        if (body?.deny !== undefined) {
          if (!Array.isArray(body.deny)) return { status: 400, error: 'deny must be an array of paths' }
          const current = Array.isArray(settings?.discovery?.deny) ? settings.discovery.deny : []
          const next = [...new Set([...current, ...body.deny.map((path) => String(path).trim()).filter(Boolean)])]
          patch = { discovery: { ...(settings?.discovery ?? {}), deny: next } }
        } else if (body?.adapter && typeof body.adapter === 'object' && !Array.isArray(body.adapter)) {
          const candidate = body.adapter
          const rawPath = String(candidate.path || '').trim()
          if (!rawPath) return { status: 400, error: 'adapter.path is required' }
          const type = candidate.type || candidate.kind || candidate.suggested?.type
          if (type !== 'file-md' && type !== 'file-json') {
            return { status: 400, error: 'adapter.type must be file-md or file-json' }
          }
          const current = Array.isArray(settings?.customAdapters) ? settings.customAdapters : []
          const id =
            typeof candidate.id === 'string' && candidate.id.startsWith('custom:')
              ? candidate.id
              : `custom:${randomUUID()}`
          const label = String(
            candidate.label || candidate.name || rawPath.split(/[\\/]/).pop() || 'custom',
          )
          const format =
            candidate.format && typeof candidate.format === 'object'
              ? candidate.format
              : candidate.suggested?.format && typeof candidate.suggested.format === 'object'
                ? candidate.suggested.format
                : {}
          const next = current
            .filter((adapter) => adapter?.id !== id)
            .concat([{ id, type, label, path: rawPath, mode: 'archive', format }])
          patch = { customAdapters: next }
        } else {
          return { status: 400, error: 'adapter or deny is required' }
        }

        const save = await resolveSaveSettings(deps)
        const saved = normalizeSaved(await save(patch))
        deps.settings = saved.settings
        try {
          await deps.onSettingsApplied?.(saved.settings)
        } catch (error) {
          logger.warn(`onSettingsApplied failed: ${error?.message || error}`)
        }
        return { status: 200, data: { settings: saved.settings } }
      },
    },

    log: {
      method: 'GET',
      async handle(_req, url) {
        const lines = clampInt(url.searchParams.get('lines'), 50, 1, 2000)
        const readLog = await resolveReadLog(deps)
        const result = await readLog(lines)
        const list = Array.isArray(result)
          ? result
          : Array.isArray(result?.lines)
            ? result.lines
            : typeof result === 'string'
              ? result.split(/\r?\n/).filter(Boolean)
              : []
        return { status: 200, data: { lines: list } }
      },
    },
  }

  async function handle(req, res) {
    const method = String(req?.method || 'GET').toUpperCase()
    let url
    try {
      url = new URL(req?.url || '/', 'http://127.0.0.1')
    } catch {
      return fail(res, 400, 'invalid request url')
    }
    const path = url.pathname

    if (!path.startsWith(`${PREFIX}/`) && path !== PREFIX) {
      return fail(res, 404, 'not found')
    }

    if (method !== 'GET' && method !== 'POST') {
      return fail(res, 405, `method ${method} is not allowed`, { allow: 'GET, POST' })
    }

    if (!path.startsWith(API_PREFIX)) {
      return fail(res, 404, `unknown api: ${path.slice(PREFIX.length)}`)
    }

    let action = path.slice(API_PREFIX.length)
    if (action.endsWith('/')) action = action.slice(0, -1)
    let decoded = action
    try {
      decoded = decodeURIComponent(action)
    } catch {
      return fail(res, 400, 'invalid path encoding')
    }

    const route = Object.prototype.hasOwnProperty.call(routes, decoded) ? routes[decoded] : null
    if (!route) return fail(res, 404, `unknown api: ${decoded}`)
    if (route.method !== method) {
      return fail(res, 405, `method ${method} is not allowed for ${decoded}`, { allow: route.method })
    }

    try {
      const outcome = await route.handle(req, url)
      if (outcome.error !== undefined) return fail(res, outcome.status || 400, outcome.error)
      return ok(res, outcome.data)
    } catch (error) {
      if (error?.code === 'E_BODY_TOO_LARGE') return fail(res, 413, error)
      if (error?.code === 'E_BAD_JSON') return fail(res, 400, error)
      logger.error(`api ${decoded} failed: ${error?.stack || error?.message || error}`)
      return fail(res, 500, error)
    }
  }

  return { handle, routes }
}

/**
 * Mount the API on the web server.
 *
 * @param {object} ctx cordis host context
 * @param {{settings:object,registry:object,state:object,stateRepo:object,
 *          sweep:Function,scan:Function,board:object,logger:object,
 *          paths?:object,saveSettings?:Function}} deps
 */
export function registerRoutes(ctx, deps = {}) {
  const logger = deps.logger ?? { info() {}, warn() {}, error() {} }
  const handler = createHandler(deps)
  const mount = (host) => {
    try {
      const webServer = host?.webServer ?? host?.get?.('webServer')
      if (!webServer || typeof webServer.register !== 'function') {
        logger.warn('webServer.register is unavailable; HTTP API not mounted')
        return
      }
      return webServer.register({ kind: 'prefix', path: PREFIX, handler: handler.handle })
    } catch (error) {
      logger.warn(`web route registration failed: ${error?.message || error}`)
      return undefined
    }
  }

  try {
    if (typeof ctx?.inject === 'function') {
      ctx.inject(['webServer'], (webCtx) => {
        try {
          if (typeof webCtx?.effect === 'function') {
            webCtx.effect(() => mount(webCtx), 'dsh-memory-tide: web routes')
          } else {
            mount(webCtx)
          }
        } catch (error) {
          logger.warn(`web route effect failed: ${error?.message || error}`)
        }
      })
    } else {
      mount(ctx)
    }
  } catch (error) {
    logger.warn(`web route injection failed: ${error?.message || error}`)
  }

  return handler
}
