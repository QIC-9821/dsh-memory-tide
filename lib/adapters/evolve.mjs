// dsh-memory-evolve adapter — Markdown memory tracks in their real on-disk shape.
//
// Layout inside ~/.dsh/memories (SPEC §7.2 superseded by the observed layout):
//   memory  -> MEMORY.md
//   user    -> USER.md
//   key     -> projects/<hash>/KEY.md      (one per project, may be many/missing)
//   project -> projects/<hash>/MEMORY.md   (one per project, may be many/missing)
//   daily   -> daily/YYYY-MM-DD.md         (one file per day)
//
// Entries inside a file are separated by "\n§\n"; an optional "[YYYY-MM-DD]"
// prefix belongs to the entry and is shown as its date, never repeated inside
// `text`. A daily entry without a date prefix takes the date from its file name.
//
// An entry id must be unique across projects and days, so it carries the path
// of its file relative to the memory root:
//   "projects/75ed6e6d05ef/KEY.md#1a2b3c4d"   "daily/2026-11-24.md#9f8e7d6c"
// The adapter also exposes `file` (absolute path) and `track` on every entry.
//
// Only tracks explicitly enabled in settings.adapters.evolve.tracks are read or
// written (USER.md is protected by default). Writes are serialized by
// ~/.dsh/memories/.memory.lock (O_EXCL, 5 s wait, 10 s stale takeover) and
// guarded by a canonical-form check, so a file edited outside memory-tide is
// reported instead of being overwritten.

import { existsSync } from 'node:fs'
import { copyFile, mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'

export const EVOLVE_ADAPTER_ID = 'evolve'
export const ENTRY_DELIMITER = '\n§\n'
export const TRACK_FILES = Object.freeze({
  memory: 'MEMORY.md',
  user: 'USER.md',
  key: 'projects/<hash>/KEY.md',
  project: 'projects/<hash>/MEMORY.md',
  daily: 'daily/YYYY-MM-DD.md',
})
export const TRACK_ORDER = Object.freeze(['memory', 'key', 'user', 'project', 'daily'])
export const DEFAULT_TRACKS = Object.freeze({
  memory: true,
  key: true,
  user: false,
  project: false,
  daily: false,
})

export const LOCK_FILE = '.memory.lock'
export const LOCK_TIMEOUT_MS = 5000
export const STALE_LOCK_MS = 10000
export const LOCK_RETRY_MS = 25
export const ENTRY_HASH_LENGTH = 8

const DATE_PREFIX = /^\[(\d{4}-\d{2}-\d{2})(?:[ T][^\]]*)?\]\s*/
const DAILY_FILE = /^(\d{4}-\d{2}-\d{2})\.md$/
const heldLocks = new Set()

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function parseEntries(text) {
  return String(text ?? '')
    .split(ENTRY_DELIMITER)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
}

export function serializeEntries(blocks) {
  return blocks.join(ENTRY_DELIMITER) + '\n'
}

/** True when a file is already in the exact shape serializeEntries() produces. */
export function isCanonical(text) {
  const source = String(text ?? '')
  if (source.trim() === '') return true
  return serializeEntries(parseEntries(source)) === source
}

/** Legacy helper: content hash alone (16 hex chars). */
export function entryIdOf(raw) {
  return createHash('sha1').update(String(raw ?? ''), 'utf8').digest('hex').slice(0, 16)
}

function digest8(raw) {
  return createHash('sha1').update(String(raw ?? ''), 'utf8').digest('hex').slice(0, ENTRY_HASH_LENGTH)
}

/** Path relative to the memory root, always with "/" separators; null if outside. */
export function toRelPath(root, file) {
  const rel = relative(root, file)
  if (!rel || rel === '' || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith('../')) {
    return null
  }
  return rel.split(sep).join('/')
}

/** Entry id for one block: relative file path + content hash (SPEC §7.2 revised). */
export function entryIdFor(root, file, raw) {
  const rel = toRelPath(root, file)
  if (!rel) return null
  return `${rel}#${digest8(raw)}`
}

/** Which track a real-layout file belongs to (null for anything else). */
export function trackOfFile(root, file) {
  const rel = toRelPath(root, file)
  if (!rel) return null
  if (rel === 'MEMORY.md') return 'memory'
  if (rel === 'USER.md') return 'user'
  const parts = rel.split('/')
  if (parts.length === 3 && parts[0] === 'projects' && parts[2] === 'KEY.md') return 'key'
  if (parts.length === 3 && parts[0] === 'projects' && parts[2] === 'MEMORY.md') return 'project'
  if (parts.length === 2 && parts[0] === 'daily' && DAILY_FILE.test(parts[1])) return 'daily'
  return null
}

/**
 * Acquire the memory lock and run `fn`. A lock held in this process is
 * re-entrant; across processes the file is created with O_EXCL and taken over
 * once its mtime is older than STALE_LOCK_MS.
 */
export async function withLock(dir, fn, options = {}) {
  const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS
  const staleMs = options.staleMs ?? STALE_LOCK_MS
  const retryMs = options.retryMs ?? LOCK_RETRY_MS
  const lockPath = options.lockPath || join(dir, LOCK_FILE)
  const key = lockPath
  if (heldLocks.has(key)) return fn()

  await mkdir(dir, { recursive: true })
  const deadline = Date.now() + timeoutMs
  while (true) {
    let handle = null
    try {
      handle = await open(lockPath, 'wx')
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8')
      } finally {
        await handle.close()
      }
      break
    } catch (error) {
      if (handle) await handle.close().catch(() => {})
      if (error.code !== 'EEXIST') throw error
    }
    // Somebody holds the lock: take it over only when it is stale.
    try {
      const info = await stat(lockPath)
      if (Date.now() - info.mtimeMs > staleMs) {
        await unlink(lockPath).catch(() => {})
        continue
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      continue
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${lockPath}`)
    }
    await sleep(retryMs)
  }

  heldLocks.add(key)
  try {
    return await fn()
  } finally {
    heldLocks.delete(key)
    await unlink(lockPath).catch(() => {})
  }
}

function localDateText(ms) {
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function dateFromYmd(ymd) {
  const [year, month, day] = ymd.split('-').map(Number)
  const d = new Date(year, month - 1, day)
  return Number.isNaN(d.getTime()) ? null : d.getTime()
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

async function writeAtomic(path, text) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`
  try {
    await writeFile(temp, text, 'utf8')
    await rename(temp, path)
  } catch (error) {
    await unlink(temp).catch(() => {})
    return { ok: false, error: `write failed: ${error.message}` }
  }
  try {
    const verify = await readFile(path, 'utf8')
    if (verify !== text) return { ok: false, error: 'conflict: file changed while writing' }
  } catch (error) {
    return { ok: false, error: `verify failed: ${error.message}` }
  }
  return { ok: true }
}

export function createEvolveAdapter(options = {}) {
  const { settings, logger } = options
  const log = makeLogger(logger)
  const dir = options.dir || join(dshHome(), 'memories')
  const injectedBackup = typeof options.backupFile === 'function' ? options.backupFile : null
  const backup = (file) =>
    injectedBackup ? injectedBackup(file) : resolveBackup().then((fn) => fn(file))
  const lockOptions = {
    lockPath: options.lockPath,
    timeoutMs: options.lockTimeoutMs,
    staleMs: options.staleLockMs,
    retryMs: options.lockRetryMs,
  }

  const tracks = () => {
    const configured = settings?.adapters?.evolve?.tracks
    const merged = { ...DEFAULT_TRACKS }
    if (configured && typeof configured === 'object') {
      for (const track of TRACK_ORDER) {
        if (typeof configured[track] === 'boolean') merged[track] = configured[track]
      }
    }
    return merged
  }
  const isEnabled = (track) => tracks()[track] === true
  const trackEnabled = (track) => Boolean(track) && isEnabled(track)

  async function filesForTrack(track) {
    if (track === 'memory') return [join(dir, 'MEMORY.md')]
    if (track === 'user') return [join(dir, 'USER.md')]
    if (track === 'key' || track === 'project') {
      const projectsDir = join(dir, 'projects')
      let dirents
      try {
        dirents = await readdir(projectsDir, { withFileTypes: true })
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return []
        throw error
      }
      const name = track === 'key' ? 'KEY.md' : 'MEMORY.md'
      return dirents
        .filter((dirent) => dirent.isDirectory() && dirent.name !== '.git')
        .map((dirent) => join(projectsDir, dirent.name, name))
        .sort()
    }
    if (track === 'daily') {
      const dailyDir = join(dir, 'daily')
      let dirents
      try {
        dirents = await readdir(dailyDir, { withFileTypes: true })
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return []
        throw error
      }
      return dirents
        .filter((dirent) => dirent.isFile() && DAILY_FILE.test(dirent.name))
        .map((dirent) => join(dailyDir, dirent.name))
        .sort()
    }
    return []
  }

  function parseBlock(block, track, file) {
    let text = block
    let dateText = ''
    let date = null
    const match = DATE_PREFIX.exec(block)
    if (match) {
      dateText = match[1]
      date = dateFromYmd(dateText)
      text = block.slice(match[0].length)
    } else if (track === 'daily') {
      // A daily file is that day: its blocks only carry [HH:MM] times.
      const byFile = DAILY_FILE.exec(basename(file))
      if (byFile) {
        dateText = byFile[1]
        date = dateFromYmd(dateText)
      }
    }
    const entryId = entryIdFor(dir, file, block)
    return {
      key: `${EVOLVE_ADAPTER_ID}:${entryId}`,
      adapterId: EVOLVE_ADAPTER_ID,
      entryId,
      date,
      dateText,
      text,
      tags: [],
      track,
      raw: block,
      file,
      // `path` is kept because the board backs files up through entry.path.
      path: file,
    }
  }

  async function list() {
    const state = tracks()
    const entries = []
    for (const track of TRACK_ORDER) {
      if (state[track] !== true) continue
      for (const file of await filesForTrack(track)) {
        let text
        try {
          text = await readFile(file, 'utf8')
        } catch (error) {
          if (error.code === 'ENOENT') continue
          log.warn(`[memory-tide:evolve] cannot read ${file}: ${error.message}`)
          continue
        }
        for (const block of parseEntries(text)) entries.push(parseBlock(block, track, file))
      }
    }
    return entries
  }

  async function describe() {
    const entries = await list()
    return { path: dir, count: entries.length, missing: !existsSync(dir) }
  }

  async function remove(entries) {
    const input = Array.isArray(entries) ? entries : []
    const result = { removed: [], failed: [] }
    const byFile = new Map()
    for (const entry of input) {
      const key = entry?.key || `${EVOLVE_ADAPTER_ID}:${entry?.entryId ?? '(unknown)'}`
      const file = typeof entry?.file === 'string' && entry.file ? entry.file : entry?.path
      if (typeof file !== 'string' || !file) {
        result.failed.push({ key, error: 'entry is missing its source file' })
        continue
      }
      const track = trackOfFile(dir, file)
      if (!track || !TRACK_FILES[track]) {
        result.failed.push({ key, error: `cannot determine evolve track for ${file}` })
        continue
      }
      if (!trackEnabled(track)) {
        result.failed.push({ key, error: `track "${track}" is disabled in settings` })
        continue
      }
      if (!byFile.has(file)) byFile.set(file, [])
      byFile.get(file).push({ ...entry, __key: key, __file: file, __track: track })
    }

    for (const [file, group] of byFile) {
      const keys = group.map((entry) => entry.__key)
      try {
        await withLock(
          dir,
          async () => {
            let text
            try {
              text = await readFile(file, 'utf8')
            } catch (error) {
              if (error.code === 'ENOENT') {
                result.removed.push(...keys)
                return
              }
              throw error
            }
            if (!isCanonical(text)) {
              // Keep a copy of the surprising file, then refuse the write.
              try {
                await backup(file)
              } catch (error) {
                log.warn(`[memory-tide:evolve] backup of ${file} failed: ${error.message}`)
              }
              const rel = toRelPath(dir, file) || file
              throw new Error(
                `drift guard: ${rel} was changed outside memory-tide and is not in canonical form; refusing to write`,
              )
            }
            const blocks = parseEntries(text)
            const wantedIds = new Set(
              group
                .map((entry) => entry.entryId || entryIdFor(dir, file, entry.raw ?? ''))
                .filter(Boolean),
            )
            const wantedRaw = new Set(
              group.map((entry) => entry.raw).filter((raw) => typeof raw === 'string'),
            )
            const kept = blocks.filter(
              (block) => !wantedIds.has(entryIdFor(dir, file, block)) && !wantedRaw.has(block),
            )
            if (kept.length === blocks.length) {
              result.removed.push(...keys)
              return
            }
            try {
              await backup(file)
            } catch (error) {
              log.warn(`[memory-tide:evolve] backup of ${file} failed: ${error.message}`)
            }
            const written = await writeAtomic(file, serializeEntries(kept))
            if (!written.ok) throw new Error(written.error)
            result.removed.push(...keys)
          },
          lockOptions,
        )
      } catch (error) {
        for (const key of keys) result.failed.push({ key, error: error.message })
      }
    }
    return result
  }

  function resolveTarget(entry) {
    const file =
      typeof entry?.file === 'string' && entry.file.trim()
        ? entry.file
        : typeof entry?.path === 'string' && entry.path.trim()
          ? entry.path
          : null
    if (!file) {
      return { error: 'add requires entry.file: the target memory file is needed to restore into' }
    }
    const track = trackOfFile(dir, file)
    if (!track || !TRACK_FILES[track]) {
      return { file, error: `${file} is not an evolve memory track file` }
    }
    if (!trackEnabled(track)) {
      return { file, track, error: `track "${track}" is disabled in settings` }
    }
    return { file, track }
  }

  async function add(entry) {
    const target = resolveTarget(entry)
    if (target.error) return { ok: false, error: target.error }
    const { file } = target
    let raw = typeof entry?.raw === 'string' ? entry.raw.trim() : ''
    if (!raw) {
      const text = typeof entry?.text === 'string' ? entry.text.trim() : ''
      if (!text) return { ok: false, error: 'entry text is empty' }
      raw = entry.dateText ? `[${entry.dateText}] ${text}` : text
    }
    try {
      await withLock(
        dir,
        async () => {
          let text = ''
          try {
            text = await readFile(file, 'utf8')
          } catch (error) {
            if (error.code !== 'ENOENT') throw error
          }
          const body = text.replace(/\n+$/, '')
          const next = body === '' ? `${raw}\n` : `${body}${ENTRY_DELIMITER}${raw}\n`
          try {
            await backup(file)
          } catch (error) {
            log.warn(`[memory-tide:evolve] backup of ${file} failed: ${error.message}`)
          }
          const written = await writeAtomic(file, next)
          if (!written.ok) throw new Error(written.error)
        },
        lockOptions,
      )
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error.message }
    }
  }

  // 就地改写某一条记忆的正文；保留原来的 [YYYY-MM-DD] 或 [HH:MM] 前缀。
  async function update(entry, newText) {
    const text = typeof newText === 'string' ? newText.trim() : ''
    if (!text) return { ok: false, error: 'entry text is empty' }
    const file =
      typeof entry?.file === 'string' && entry.file
        ? entry.file
        : typeof entry?.path === 'string'
          ? entry.path
          : null
    if (!file) return { ok: false, error: 'entry is missing its source file' }
    const track = trackOfFile(dir, file)
    if (!track || !TRACK_FILES[track]) {
      return { ok: false, error: `cannot determine evolve track for ${file}` }
    }
    if (!trackEnabled(track)) {
      return { ok: false, error: `track "${track}" is disabled in settings` }
    }

    try {
      await withLock(
        dir,
        async () => {
          let fileText = ''
          try {
            fileText = await readFile(file, 'utf8')
          } catch (error) {
            if (error.code !== 'ENOENT') throw error
          }
          if (fileText && !isCanonical(fileText)) {
            try {
              await backup(file)
            } catch (error) {
              log.warn(`[memory-tide:evolve] backup of ${file} failed: ${error.message}`)
            }
            const rel = toRelPath(dir, file) || file
            throw new Error(
              `drift guard: ${rel} was changed outside memory-tide and is not in canonical form; refusing to write`,
            )
          }

          const blocks = parseEntries(fileText)
          const wantedId = entry.entryId || entryIdFor(dir, file, entry.raw ?? '')
          const index = blocks.findIndex(
            (block) => entryIdFor(dir, file, block) === wantedId || block === entry.raw,
          )
          if (index < 0) throw new Error('entry not found')

          const original = blocks[index]
          const prefix = DATE_PREFIX.exec(original)?.[0] ?? ''
          blocks[index] = prefix ? `${prefix}${text}` : text

          try {
            await backup(file)
          } catch (error) {
            log.warn(`[memory-tide:evolve] backup of ${file} failed: ${error.message}`)
          }
          const written = await writeAtomic(file, serializeEntries(blocks))
          if (!written.ok) throw new Error(written.error)
        },
        lockOptions,
      )
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error.message }
    }
  }

  return {
    id: EVOLVE_ADAPTER_ID,
    label: 'memory-evolve',
    kind: 'builtin',
    memoryDir: dir,
    tracks,
    files: TRACK_FILES,
    trackOfFile: (file) => trackOfFile(dir, file),
    describe,
    list,
    remove,
    add,
    update,
  }
}
