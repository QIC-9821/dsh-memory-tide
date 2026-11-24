// 状态、归档、备份与日志的落盘层。
import { readFile, writeFile, rename, mkdir, readdir, unlink, stat, copyFile } from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { settingsPath } from './settings.mjs'

const MAX_LOG_LINES = 2000
const ledgerCache = new Map()

export function storeRoot() {
  // 与 settingsPath 同目录（~/.dsh/memory-tide）
  return path.dirname(settingsPath())
}

function statePath() {
  return path.join(storeRoot(), 'state.json')
}

function archiveDir(tier) {
  return path.join(storeRoot(), 'archive', tier)
}

function archivePath(key, tier) {
  return path.join(archiveDir(tier), `${encodeURIComponent(key)}.json`)
}

function logPath() {
  return path.join(storeRoot(), 'logs', 'sweep.log')
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

async function exists(p) {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

async function writeTextAtomic(file, text) {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, file)
}

function pad(n) {
  return String(n).padStart(2, '0')
}

function dayStamp(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function tsStamp(d) {
  return `${dayStamp(d)}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
}

export function emptyState() {
  return { version: 1, items: {}, deny: [], lastSweepAt: 0, firstSweepDone: false }
}

export async function loadState() {
  try {
    const raw = JSON.parse(await readFile(statePath(), 'utf8'))
    if (!isPlainObject(raw)) return emptyState()
    const state = emptyState()
    if (isPlainObject(raw.items)) state.items = raw.items
    if (Array.isArray(raw.deny)) state.deny = raw.deny.filter((x) => typeof x === 'string')
    if (typeof raw.lastSweepAt === 'number' && Number.isFinite(raw.lastSweepAt)) state.lastSweepAt = raw.lastSweepAt
    state.firstSweepDone = raw.firstSweepDone === true
    return state
  } catch {
    return emptyState()
  }
}

export async function saveState(state) {
  await writeTextAtomic(statePath(), JSON.stringify(state, null, 2) + '\n')
}

// 同一天、同一文件只备份一次；文件不存在返回 null。
let backupChain = Promise.resolve()

export function backupFile(filePath) {
  const run = backupChain.then(() => doBackupFile(filePath))
  backupChain = run.then(
    () => {},
    () => {},
  )
  return run
}

async function doBackupFile(filePath) {
  if (typeof filePath !== 'string' || !filePath) return null
  const abs = path.resolve(filePath)
  let st
  try {
    st = await stat(abs)
  } catch {
    return null
  }
  if (!st.isFile()) return null

  const day = dayStamp(new Date())
  const ledgerFile = path.join(storeRoot(), 'backup', '.index.json')
  let ledger = ledgerCache.get(ledgerFile)
  if (!ledger) {
    ledger = {}
    try {
      const parsed = JSON.parse(await readFile(ledgerFile, 'utf8'))
      if (isPlainObject(parsed)) ledger = parsed
    } catch {
      // 没有账本就从空开始
    }
    ledgerCache.set(ledgerFile, ledger)
  }

  const key = `${day}|${abs}`
  const known = ledger[key]
  if (typeof known === 'string' && (await exists(known))) return known
  if (known !== undefined) delete ledger[key]

  let dir = path.join(storeRoot(), 'backup', tsStamp(new Date()))
  let n = 2
  const base = dir
  while (await exists(dir)) dir = `${base}-${n++}`
  const dest = path.join(dir, path.basename(abs))
  await mkdir(dir, { recursive: true })
  await copyFile(abs, dest)
  ledger[key] = dest
  await writeTextAtomic(ledgerFile, JSON.stringify(ledger, null, 2) + '\n')
  return dest
}

export async function putArchive(entry, tier) {
  if (!isPlainObject(entry) || typeof entry.key !== 'string' || !entry.key) {
    throw new Error('putArchive: entry.key 缺失')
  }
  const t = tier === 'cold' ? 'cold' : 'hot'
  await writeTextAtomic(archivePath(entry.key, t), JSON.stringify(entry, null, 2) + '\n')
}

export async function readArchive(key) {
  if (typeof key !== 'string' || !key) return null
  for (const tier of ['hot', 'cold']) {
    try {
      const entry = JSON.parse(await readFile(archivePath(key, tier), 'utf8'))
      if (isPlainObject(entry)) return entry
    } catch {
      // 该层没有就换下一层
    }
  }
  return null
}

export async function listArchive(tier) {
  if (tier !== 'hot' && tier !== 'cold') return []
  let names
  try {
    names = await readdir(archiveDir(tier))
  } catch {
    return []
  }
  const out = []
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue
    try {
      const entry = JSON.parse(await readFile(path.join(archiveDir(tier), name), 'utf8'))
      if (isPlainObject(entry) && typeof entry.key === 'string') out.push(entry)
    } catch {
      // 坏文件跳过
    }
  }
  return out
}

// tier 默认 hot（SPEC §8 的冷却流程只清 hot）；传 "cold" 或 "both" 可清其它层。
export async function removeArchive(key, tier = 'hot') {
  if (typeof key !== 'string' || !key) return
  const tiers = tier === 'both' ? ['hot', 'cold'] : tier === 'cold' ? ['cold'] : ['hot']
  for (const t of tiers) {
    try {
      await unlink(archivePath(key, t))
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err
    }
  }
}

// 日志写入串行化，避免并发读改写丢行。
let logChain = Promise.resolve()

export function appendLog(line) {
  const run = logChain.then(() => doAppendLog(line))
  logChain = run.then(
    () => {},
    () => {},
  )
  return run
}

async function doAppendLog(line) {
  const file = logPath()
  let lines = []
  try {
    const text = await readFile(file, 'utf8')
    lines = text.split(/\r?\n/).filter((l) => l.length > 0)
  } catch (err) {
    if (err?.code !== 'ENOENT') return
  }
  const body = String(line ?? '').replace(/\r?\n/g, ' ')
  lines.push(`${new Date().toISOString()} ${body}`)
  if (lines.length > MAX_LOG_LINES) lines = lines.slice(-MAX_LOG_LINES)
  await writeTextAtomic(file, lines.join('\n') + '\n')
}

export async function readLog(lines = 50) {
  const n = typeof lines === 'number' && Number.isFinite(lines) ? Math.max(0, Math.floor(lines)) : 50
  if (n === 0) return []
  try {
    const text = await readFile(logPath(), 'utf8')
    return text.split(/\r?\n/).filter((l) => l.length > 0).slice(-n)
  } catch {
    return []
  }
}
