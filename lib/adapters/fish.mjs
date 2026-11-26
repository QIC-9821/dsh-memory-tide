// fish-memory adapter — reads and edits the JSON stores of dsh-fish-memory.
//
// The store is one JSON document per file:
//   { version: 2, policy: {...}, memories: [...], traces: [...], deleted: [], ... }
//
// Rules implemented here (SPEC §7.1):
//   * every *.json in the store directory takes part;
//   * a file without `version === 2` / an array `memories` is skipped with a warning;
//   * a file written less than 2 s ago is "busy" and is skipped while listing/removing;
//   * remove deletes the matching objects from `memories` and never touches `deleted`;
//   * writes go through a backup, a same-directory .tmp-<pid> file and a rename, and
//     a stat conflict check protects against a concurrent writer;
//   * add appends an object that matches the fish-memory schema.

import { existsSync } from 'node:fs'
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

export const FISH_ADAPTER_ID = 'fish'
export const FISH_BUSY_MS = 2000

const ADAPTER_LABEL = 'fish-memory'

function makeLogger(logger) {
  const target = logger || {}
  return {
    info: (...args) => target.info?.(...args),
    warn: (...args) => target.warn?.(...args),
    error: (...args) => target.error?.(...args),
  }
}

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function localDateText(ms) {
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function schemaProblem(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'root is not an object'
  if (data.version !== 2) return `version is ${JSON.stringify(data.version)}, expected 2`
  if (!Array.isArray(data.memories)) return 'memories is not an array'
  return null
}

function detectIndent(text) {
  const match = text.match(/\n([ \t]+)"/)
  if (!match) return 2
  return match[1].includes('\t') ? '\t' : match[1].length
}

function detectEol(text) {
  if (text.endsWith('\r\n')) return '\r\n'
  if (text.endsWith('\n')) return '\n'
  return ''
}

function serializeStore(data, style) {
  return JSON.stringify(data, null, style?.indent ?? 2) + (style?.eol ?? '')
}

function blankStore() {
  return { version: 2, policy: {}, memories: [], traces: [], deleted: [], purgeEpoch: '' }
}

function keyOf(entry) {
  return entry?.key || `${FISH_ADAPTER_ID}:${entry?.entryId ?? '(unknown)'}`
}

export async function listStoreFiles(dir) {
  let dirents
  try {
    dirents = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return []
    throw error
  }
  return dirents
    .filter((dirent) => dirent.isFile() && dirent.name.endsWith('.json') && !dirent.name.startsWith('.'))
    .map((dirent) => join(dir, dirent.name))
    .sort()
}

/**
 * Read and validate one store file. Never throws for the ordinary cases: the
 * caller receives { ok: false, error, busy | missing } instead.
 */
export async function readStoreFile(path, logger) {
  const log = makeLogger(logger)
  let info
  try {
    info = await stat(path)
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: false, error: 'missing', missing: true }
    return { ok: false, error: `stat failed: ${error.message}` }
  }
  if (Date.now() - info.mtimeMs < FISH_BUSY_MS) {
    return { ok: false, error: 'busy', busy: true, mtimeMs: info.mtimeMs }
  }
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    return { ok: false, error: `read failed: ${error.message}` }
  }
  let data
  try {
    data = JSON.parse(text)
  } catch (error) {
    log.warn(`[memory-tide:fish] ${basename(path)} is not valid JSON: ${error.message}`)
    return { ok: false, error: 'invalid JSON', text }
  }
  const problem = schemaProblem(data)
  if (problem) {
    log.warn(`[memory-tide:fish] ${basename(path)} does not match the fish-memory schema: ${problem}`)
    return { ok: false, error: `schema mismatch: ${problem}`, text }
  }
  return {
    ok: true,
    data,
    text,
    mtimeMs: info.mtimeMs,
    indent: detectIndent(text),
    eol: detectEol(text),
  }
}

/**
 * Atomically replace a store file. `expectedMtimeMs` is the mtime captured when
 * the file was read; a different value means somebody else wrote in between and
 * the write is refused as a conflict (the next sweep retries).
 */
export async function writeStoreAtomic(path, text, options = {}) {
  const { expectedMtimeMs } = options
  await mkdir(dirname(path), { recursive: true })

  if (expectedMtimeMs != null) {
    let info
    try {
      info = await stat(path)
    } catch (error) {
      if (error.code !== 'ENOENT') return { ok: false, error: `stat failed: ${error.message}` }
    }
    if (!info || Math.abs(info.mtimeMs - expectedMtimeMs) > 0.001) {
      return { ok: false, error: 'conflict: store file changed since it was read' }
    }
  }

  const temp = `${path}.tmp-${process.pid}`
  try {
    await writeFile(temp, text, 'utf8')
    await rename(temp, path)
  } catch (error) {
    await unlink(temp).catch(() => {})
    return { ok: false, error: `write failed: ${error.message}` }
  }

  try {
    const verify = await readFile(path, 'utf8')
    if (verify !== text) return { ok: false, error: 'conflict: store file changed while writing' }
  } catch (error) {
    return { ok: false, error: `verify failed: ${error.message}` }
  }
  return { ok: true }
}

function backupStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  )
}

/** Fallback for the shared store backup: ~/.dsh/memory-tide/backup/<stamp>/<name>. */
async function defaultBackupFile(file) {
  try {
    await stat(file)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  const root = join(dshHome(), 'memory-tide', 'backup')
  const today = localDateText(Date.now())
  let dirents = []
  try {
    dirents = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const sameDay = dirents
    .filter((dirent) => dirent.isDirectory() && dirent.name.startsWith(today))
    .map((dirent) => dirent.name)
    .sort()
    .reverse()
  for (const name of sameDay) {
    const candidate = join(root, name, basename(file))
    try {
      await stat(candidate)
      return candidate
    } catch {
      // keep looking for today's copy
    }
  }
  const dir = join(root, backupStamp())
  await mkdir(dir, { recursive: true })
  const destination = join(dir, basename(file))
  await copyFile(file, destination)
  return destination
}

// The shared store owns the one backup policy for the plugin; the adapter only
// keeps its own copy so a broken/absent store module cannot block a sweep.
let sharedBackupPromise
async function resolveBackup() {
  if (!sharedBackupPromise) {
    sharedBackupPromise = (async () => {
      try {
        const store = await import('../store.mjs')
        if (typeof store.backupFile === 'function') return store.backupFile
      } catch {
        // fall through to the local copy
      }
      return defaultBackupFile
    })()
  }
  return sharedBackupPromise
}

export function createFishAdapter(options = {}) {
  const { settings, logger } = options
  const log = makeLogger(logger)
  const storeDir = options.dir || join(dshHome(), 'fish-memory')
  const injectedBackup = typeof options.backupFile === 'function' ? options.backupFile : null
  const backup = (file) =>
    injectedBackup ? injectedBackup(file) : resolveBackup().then((fn) => fn(file))

  async function list() {
    const files = await listStoreFiles(storeDir)
    const entries = []
    for (const file of files) {
      const state = await readStoreFile(file, log)
      if (!state.ok) {
        if (state.missing) continue
        if (state.busy) {
          log.info(`[memory-tide:fish] ${basename(file)} is busy (modified less than 2s ago), skipped`)
        }
        // readStoreFile already warned for schema/JSON problems.
        continue
      }
      for (const memory of state.data.memories) {
        if (!memory || typeof memory !== 'object' || memory.id == null || memory.id === '') {
          log.warn(`[memory-tide:fish] ${basename(file)} has a memory without an id, skipped`)
          continue
        }
        const ms = toMs(memory.createdAt ?? memory.at)
        entries.push({
          key: `${FISH_ADAPTER_ID}:${memory.id}`,
          adapterId: FISH_ADAPTER_ID,
          entryId: String(memory.id),
          date: ms,
          dateText: ms == null ? '' : localDateText(ms),
          text: typeof memory.text === 'string' ? memory.text : '',
          tags: Array.isArray(memory.tags) ? memory.tags.filter((tag) => typeof tag === 'string') : [],
          track: null,
          raw: JSON.stringify(memory),
          path: file,
        })
      }
    }
    return entries
  }

  async function describe() {
    const files = await listStoreFiles(storeDir)
    const entries = await list()
    return {
      path: files.length === 1 ? files[0] : storeDir,
      count: entries.length,
      missing: !existsSync(storeDir),
    }
  }

  async function remove(entries) {
    const list0 = Array.isArray(entries) ? entries : []
    const result = { removed: [], failed: [] }
    const byPath = new Map()
    for (const entry of list0) {
      if (!entry || entry.entryId == null || entry.entryId === '') {
        result.failed.push({ key: keyOf(entry), error: 'entry has no entryId' })
        continue
      }
      if (!entry.path) {
        result.failed.push({ key: keyOf(entry), error: 'entry is missing its source path' })
        continue
      }
      if (!byPath.has(entry.path)) byPath.set(entry.path, [])
      byPath.get(entry.path).push(entry)
    }

    for (const [file, group] of byPath) {
      const keys = group.map(keyOf)
      const state = await readStoreFile(file, log)
      if (!state.ok) {
        if (state.missing) {
          result.removed.push(...keys)
          continue
        }
        const error = state.busy
          ? 'busy: store file was modified less than 2s ago'
          : state.error
        for (const key of keys) result.failed.push({ key, error })
        continue
      }
      const ids = new Set(group.map((entry) => String(entry.entryId)))
      const memories = state.data.memories
      const kept = memories.filter((memory) => !ids.has(String(memory?.id)))
      if (kept.length === memories.length) {
        // Already gone (a concurrent sweep or the plugin itself): not an error.
        result.removed.push(...keys)
        continue
      }
      const next = serializeStore({ ...state.data, memories: kept }, state)
      try {
        await backup(file)
      } catch (error) {
        log.warn(`[memory-tide:fish] backup of ${basename(file)} failed: ${error.message}`)
      }
      const written = await writeStoreAtomic(file, next, { expectedMtimeMs: state.mtimeMs })
      if (!written.ok) {
        for (const key of keys) result.failed.push({ key, error: written.error })
        continue
      }
      result.removed.push(...keys)
    }
    return result
  }

  async function pickTargetFile() {
    const files = await listStoreFiles(storeDir)
    if (files.length <= 1) return files[0] || null
    const ranked = []
    for (const file of files) {
      try {
        ranked.push({ file, mtimeMs: (await stat(file)).mtimeMs })
      } catch {
        // a store that vanished meanwhile simply does not compete
      }
    }
    ranked.sort((a, b) => b.mtimeMs - a.mtimeMs)
    return ranked[0]?.file || files[0]
  }

  function newMemoryId(preferred, memories) {
    const taken = new Set(memories.map((memory) => String(memory?.id)))
    if (typeof preferred === 'string' && preferred && !taken.has(preferred)) return preferred
    let id
    do {
      id = `mt${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
    } while (taken.has(id))
    return id
  }

  async function add(entry) {
    if (!entry || typeof entry.text !== 'string' || entry.text.trim() === '') {
      return { ok: false, error: 'entry text is empty' }
    }
    const file = entry.path || (await pickTargetFile())
    if (!file) return { ok: false, error: 'no fish-memory store file found' }

    const state = await readStoreFile(file, log)
    if (!state.ok && !state.missing) {
      return {
        ok: false,
        error: state.busy ? 'busy: store file was modified less than 2s ago' : state.error,
      }
    }
    const data = state.ok ? state.data : blankStore()
    const when = toMs(entry.date) ?? Date.now()
    const iso = new Date(when).toISOString()
    const tags = Array.isArray(entry.tags)
      ? entry.tags.filter((tag) => typeof tag === 'string')
      : []
    const memory = {
      id: newMemoryId(entry.entryId, data.memories),
      text: entry.text,
      at: iso,
      createdAt: iso,
      category: 'note',
      importance: 0.5,
      emotion: null,
      tags,
      source: 'memory-tide',
    }
    data.memories.push(memory)
    const style = state.ok ? state : { indent: 2, eol: '' }
    const next = serializeStore(data, style)
    try {
      await backup(file)
    } catch (error) {
      log.warn(`[memory-tide:fish] backup of ${basename(file)} failed: ${error.message}`)
    }
    const written = await writeStoreAtomic(file, next, {
      expectedMtimeMs: state.ok ? state.mtimeMs : undefined,
    })
    if (!written.ok) return { ok: false, error: written.error }
    return { ok: true, entryId: memory.id }
  }

  // 就地改写某条记忆的正文；写前做 mtime 冲突检查，不碰 deleted[]。
  async function update(entry, newText) {
    const text = typeof newText === 'string' ? newText.trim() : ''
    if (!text) return { ok: false, error: 'entry text is empty' }
    const file = entry?.path
    if (!file) return { ok: false, error: 'entry is missing its source path' }
    const state = await readStoreFile(file, log)
    if (!state.ok) {
      return {
        ok: false,
        error: state.missing
          ? 'file not found'
          : state.busy
            ? 'busy: store file was modified less than 2s ago'
            : state.error,
      }
    }
    const id = String(entry.entryId)
    const index = state.data.memories.findIndex((memory) => String(memory?.id) === id)
    if (index < 0) return { ok: false, error: 'entry not found' }
    const memories = state.data.memories.slice()
    memories[index] = { ...memories[index], text, editedAt: new Date().toISOString() }
    const next = serializeStore({ ...state.data, memories }, state)
    try {
      await backup(file)
    } catch (error) {
      log.warn(`[memory-tide:fish] backup of ${basename(file)} failed: ${error.message}`)
    }
    const written = await writeStoreAtomic(file, next, { expectedMtimeMs: state.mtimeMs })
    if (!written.ok) return { ok: false, error: written.error }
    return { ok: true }
  }

  return {
    id: FISH_ADAPTER_ID,
    label: ADAPTER_LABEL,
    kind: 'builtin',
    storeDir,
    describe,
    list,
    remove,
    add,
    update,
  }
}
