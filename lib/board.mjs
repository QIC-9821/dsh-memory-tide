// dsh-memory-tide — memory board (host side)
//
// Reads live entries from adapters (read-only) and archived entries from the
// archive store, merges them, and exposes the manual operations the settings
// page needs. Path: lib/board.mjs
//
// The store module lives in core-engine's lane. It is imported lazily so this
// file can be unit-tested with a fake store before store.mjs exists; production
// callers may also pass `store` explicitly.

import { ttlDays, lastActivity } from './curve.mjs'
import { makeTombstone, resolveTombstone, sourceTombstone } from './tombstone.mjs'

const DAY_MS = 86400000
const ALLOWED_OPS = new Set(['archive', 'delete', 'restore', 'pin', 'unpin'])

let defaultStorePromise = null

function loadDefaultStore() {
  if (!defaultStorePromise) {
    defaultStorePromise = import('./store.mjs').catch((error) => {
      defaultStorePromise = null
      throw error
    })
  }
  return defaultStorePromise
}

async function resolveStore(store) {
  return store ?? loadDefaultStore()
}

// A key may sit in hot/ or cold/. store.removeArchive(key) defaults to hot, so
// clear the cold copy too; an implementation that ignores the tier argument
// simply removes hot twice, which is harmless.
async function dropArchive(stateRepo, key) {
  try {
    await stateRepo.removeArchive(key)
  } catch {
    // already gone
  }
  try {
    await stateRepo.removeArchive(key, 'cold')
  } catch {
    // already gone
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

function formatDate(ts) {
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function archiveDays(settings) {
  const raw = Number(settings?.archive?.archiveDays)
  return Number.isFinite(raw) && raw >= 0 ? raw : 30
}

function makeRow(entry, { source, state, item, adapterLabel, curve }) {
  const date = Number.isFinite(entry?.date) ? entry.date : null
  // 活跃条目没有落盘的过期时间（expiresAt 只在归档后表示「热归档到期」），
  // 面板上的「还有几天」必须按当前曲线现算，否则一律显示成「无上限」。
  let expiresAt = null
  if (state === 'active') {
    if (item && item.pinned !== true) {
      const last = lastActivity(item)
      if (last > 0) expiresAt = last + ttlDays(item.touches, curve) * DAY_MS
    } else if (!item && date !== null) {
      // 刚写入、还没被下一轮清扫登记的记忆没有 state 条目：以条目自带日期
      // 当「第一次见到」，否则面板会把它误标成「无上限」。
      expiresAt = date + ttlDays(0, curve) * DAY_MS
    }
  } else if (Number.isFinite(item?.expiresAt) && item.expiresAt > 0) {
    expiresAt = item.expiresAt
  }
  return {
    key: entry.key,
    adapterId: entry.adapterId || String(entry.key).split(':')[0] || '',
    adapterLabel: adapterLabel || entry.adapterId || '',
    entryId: entry.entryId || '',
    date,
    dateText: entry.dateText || (date === null ? '' : formatDate(date)),
    text: typeof entry.text === 'string' ? entry.text : '',
    tags: Array.isArray(entry.tags) ? entry.tags.map(String) : [],
    track: entry.track ?? null,
    state,
    pinned: item?.pinned === true,
    expiresAt,
    touches: Number.isFinite(item?.touches) ? item.touches : 0,
    source,
    // 潮汐自己收走的归档带完整墓碑；源插件自己的归档只知道「讲的是哪句」。
    tombstone:
      source === 'archive'
        ? resolveTombstone(entry.tombstone, entry)
        : source === 'source-archive'
          ? sourceTombstone(entry)
          : null,
  }
}

function compareRows(a, b) {
  const da = a.date === null ? -Infinity : a.date
  const db = b.date === null ? -Infinity : b.date
  if (da !== db) return db - da
  if (a.key === b.key) return 0
  return a.key < b.key ? -1 : 1
}

function paginate(pageSize, page) {
  const size = Number.isFinite(pageSize) ? Math.min(500, Math.max(1, Math.trunc(pageSize))) : 100
  const index = Number.isFinite(page) ? Math.max(1, Math.trunc(page)) : 1
  return { pageSize: size, page: index }
}

/**
 * List live + archived entries.
 *
 * @param {object} args
 * @param {object} args.registry adapter registry (adapters(), get(id))
 * @param {object} args.state    state document authored by store.loadState()
 * @param {object} args.settings effective settings
 * @param {object} [args.query]  { state, adapter, q, page, pageSize }
 * @param {object} [args.store]  archive store namespace (optional; defaults to ./store.mjs)
 * @returns {Promise<{total:number,page:number,pageSize:number,rows:object[]}>}
 */
export async function listEntries({ registry, state, settings, query = {}, store = null }) {
  const stateRepo = await resolveStore(store)
  const items = state?.items && typeof state.items === 'object' ? state.items : {}
  const adapters = safeAdapters(registry)
  const labelByAdapter = new Map()
  for (const adapter of adapters) {
    if (adapter?.id) labelByAdapter.set(adapter.id, adapter.label || adapter.id)
  }

  const rows = []
  const seen = new Set()

  for (const adapter of adapters) {
    let entries = []
    try {
      entries = await adapter.list()
    } catch {
      entries = []
    }
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!entry?.key || seen.has(entry.key)) continue
      seen.add(entry.key)
      rows.push(
        makeRow(entry, {
          source: 'live',
          state: 'active',
          item: items[entry.key],
          adapterLabel: adapter.label || adapter.id,
          curve: settings?.curve,
        }),
      )
    }
  }

  for (const adapter of adapters) {
    if (typeof adapter.listArchived !== 'function') continue
    let sourceArchived = []
    try {
      sourceArchived = await adapter.listArchived()
    } catch {
      sourceArchived = []
    }
    for (const entry of Array.isArray(sourceArchived) ? sourceArchived : []) {
      if (!entry?.key || seen.has(entry.key)) continue
      seen.add(entry.key)
      rows.push(
        makeRow(entry, {
          source: 'source-archive',
          state: 'archived',
          item: items[entry.key],
          adapterLabel: adapter.label || adapter.id,
          curve: settings?.curve,
        }),
      )
    }
  }

  for (const tier of ['hot', 'cold']) {
    let archived = []
    try {
      archived = await stateRepo.listArchive(tier)
    } catch {
      archived = []
    }
    for (const entry of Array.isArray(archived) ? archived : []) {
      if (!entry?.key || seen.has(entry.key)) continue
      seen.add(entry.key)
      const item = items[entry.key]
      const rowState = tier === 'cold' || item?.state === 'cold' ? 'cold' : 'archived'
      rows.push(
        makeRow(entry, {
          source: 'archive',
          state: rowState,
          item,
          adapterLabel: labelByAdapter.get(entry.adapterId) || entry.adapterId || '',
          curve: settings?.curve,
        }),
      )
    }
  }

  const stateFilter = typeof query.state === 'string' && query.state && query.state !== 'all' ? query.state : ''
  const adapterFilter = typeof query.adapter === 'string' ? query.adapter.trim() : ''
  const trackFilter = typeof query.track === 'string' ? query.track.trim() : ''
  const q = typeof query.q === 'string' ? query.q.trim().toLowerCase() : ''

  const filtered = rows.filter((row) => {
    if (stateFilter === 'pinned') {
      // 「已置顶」是置顶标记，不是一种状态：置顶的条目 state 仍然是 active。
      if (!row.pinned) return false
    } else if (stateFilter && row.state !== stateFilter) {
      return false
    }
    if (adapterFilter && row.adapterId !== adapterFilter) return false
    if (trackFilter && row.track !== trackFilter) return false
    if (q) {
      const inText = row.text.toLowerCase().includes(q)
      const inTags = row.tags.some((tag) => String(tag).toLowerCase().includes(q))
      if (!inText && !inTags) return false
    }
    return true
  })

  filtered.sort(compareRows)

  const fallbackSize = Number(settings?.board?.pageSize) || 100
  const { pageSize, page } = paginate(
    query.pageSize === undefined || query.pageSize === null || query.pageSize === '' ? fallbackSize : Number(query.pageSize),
    query.page === undefined || query.page === null || query.page === '' ? 1 : Number(query.page),
  )
  const start = (page - 1) * pageSize
  return {
    total: filtered.length,
    page,
    pageSize,
    rows: filtered.slice(start, start + pageSize),
  }
}

function deriveIds(key) {
  const text = String(key)
  const index = text.indexOf(':')
  if (index < 0) return { adapterId: '', entryId: text }
  return { adapterId: text.slice(0, index), entryId: text.slice(index + 1) }
}

function ensureItem(state, key, entry, now) {
  if (!state.items || typeof state.items !== 'object') state.items = {}
  let item = state.items[key]
  if (item && typeof item === 'object') {
    if (entry && item.date === undefined) item.date = entry.date ?? null
    return item
  }
  const ids = deriveIds(key)
  item = {
    adapterId: entry?.adapterId || ids.adapterId,
    entryId: entry?.entryId || ids.entryId,
    firstSeenAt: now,
    lastSeenAt: now,
    lastRecalledAt: 0,
    resetAt: now,
    touches: 0,
    pinned: false,
    state: 'active',
    archivedAt: 0,
    expiresAt: 0,
    date: Number.isFinite(entry?.date) ? entry.date : null,
    textHash: null,
  }
  state.items[key] = item
  return item
}

function normalizeRemoveResult(result, keys) {
  const removed = Array.isArray(result?.removed) ? result.removed : []
  const failed = Array.isArray(result?.failed) ? result.failed : []
  if (failed.length) return { ok: false, error: String(failed[0]?.error || 'remove failed') }
  // An adapter that reports nothing is treated as success only when it removed
  // every requested key; otherwise keep the per-key error explicit.
  if (!removed.length && keys.length) {
    const missing = keys.filter((key) => !removed.includes(key))
    if (missing.length === keys.length) return { ok: false, error: 'remove failed' }
  }
  return { ok: true }
}

/**
 * Apply a manual operation to a batch of keys.
 *
 * Manual operations intentionally ignore the forgetting curve and protect
 * keywords; they always back up the third-party file before writing.
 *
 * @param {object} args
 * @param {string} args.op one of archive|delete|restore|pin|unpin
 * @param {string[]} args.keys entry keys
 * @returns {Promise<{results: Array<{key:string,ok:boolean,error?:string}>}>}
 */
export async function act({ registry, state, settings, op, keys, store = null, now = Date.now() }) {
  const stateRepo = await resolveStore(store)
  const requested = Array.isArray(keys) ? keys : []
  const keyList = requested.map((key) => String(key ?? '')).filter(Boolean)

  if (!ALLOWED_OPS.has(op)) {
    return {
      results: requested.map((key) => ({ key: String(key ?? ''), ok: false, error: `unknown op: ${op}` })),
    }
  }
  if (!keyList.length) return { results: [] }
  if (!state.items || typeof state.items !== 'object') state.items = {}

  const adapters = safeAdapters(registry)
  const live = new Map()
  for (const adapter of adapters) {
    let entries = []
    try {
      entries = await adapter.list()
    } catch {
      entries = []
    }
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (entry?.key && !live.has(entry.key)) live.set(entry.key, { entry, adapter })
    }
  }

  const sourceArchived = new Map()
  for (const adapter of adapters) {
    if (typeof adapter.listArchived !== 'function') continue
    let entries = []
    try {
      entries = await adapter.listArchived()
    } catch {
      entries = []
    }
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (entry?.key && !sourceArchived.has(entry.key)) sourceArchived.set(entry.key, { entry, adapter })
    }
  }

  const results = []
  const backedUp = new Set()
  let dirty = false

  const backup = async (entry) => {
    if (!entry?.path || backedUp.has(entry.path) || typeof stateRepo.backupFile !== 'function') return
    backedUp.add(entry.path)
    await stateRepo.backupFile(entry.path)
  }

  for (const key of keyList) {
    try {
      const hit = live.get(key)
      const item = state.items[key]

      if (op === 'pin' || op === 'unpin') {
        const archived = hit ? null : await stateRepo.readArchive(key)
        if (!hit && !archived && !item) {
          results.push({ key, ok: false, error: 'not found' })
          continue
        }
        const target = ensureItem(state, key, hit?.entry ?? archived ?? null, now)
        target.pinned = op === 'pin'
        dirty = true
        results.push({ key, ok: true })
        continue
      }

      if (op === 'archive') {
        const archived = await stateRepo.readArchive(key)
        if (!hit) {
          if (archived || item) {
            results.push({ key, ok: true, note: 'already archived' })
          } else {
            results.push({ key, ok: false, error: 'not found' })
          }
          continue
        }
        await backup(hit.entry)
        // 墓碑跟着归档条目落盘：本地算「为什么被收走」，不花 token。
        const tombstone = makeTombstone({
          at: now,
          actor: 'manual',
          cause: 'manual',
          entry: hit.entry,
          item,
          curve: settings?.curve,
        })
        await stateRepo.putArchive({ ...hit.entry, tombstone }, 'hot')
        let removal
        try {
          removal = await hit.adapter.remove([hit.entry])
        } catch (error) {
          removal = { removed: [], failed: [{ key, error: String(error?.message || error) }] }
        }
        const normalized = normalizeRemoveResult(removal, [key])
        if (!normalized.ok) {
          // Roll the fresh archive back so hot/ and the live files stay in sync.
          if (!archived && typeof stateRepo.removeArchive === 'function') {
            await stateRepo.removeArchive(key).catch(() => {})
          }
          results.push({ key, ok: false, error: normalized.error })
          continue
        }
        const target = ensureItem(state, key, hit.entry, now)
        target.state = 'archived'
        target.archivedAt = now
        target.expiresAt = now + archiveDays(settings) * DAY_MS
        target.date = Number.isFinite(hit.entry.date) ? hit.entry.date : target.date
        target.lastSeenAt = now
        dirty = true
        results.push({ key, ok: true })
        continue
      }

      if (op === 'delete') {
        const archived = await stateRepo.readArchive(key)
        if (!hit && !archived && sourceArchived.has(key)) {
          results.push({ key, ok: false, error: 'source-archived entries can only be restored' })
          continue
        }
        if (!hit && !archived && !item) {
          results.push({ key, ok: true, note: 'already gone' })
          continue
        }
        if (hit) {
          await backup(hit.entry)
          let removal
          try {
            removal = await hit.adapter.remove([hit.entry])
          } catch (error) {
            removal = { removed: [], failed: [{ key, error: String(error?.message || error) }] }
          }
          const normalized = normalizeRemoveResult(removal, [key])
          if (!normalized.ok) {
            results.push({ key, ok: false, error: normalized.error })
            continue
          }
        }
        if (typeof stateRepo.removeArchive === 'function') await dropArchive(stateRepo, key)
        if (state.items[key]) {
          delete state.items[key]
          dirty = true
        } else if (!hit) {
          dirty = true
        }
        results.push({ key, ok: true })
        continue
      }

      // restore
      const fromSource = !hit ? sourceArchived.get(key) : null
      if (fromSource) {
        if (typeof fromSource.adapter.unarchive !== 'function') {
          results.push({ key, ok: false, error: 'adapter does not support restoring its own archive' })
          continue
        }
        let restoreResult
        try {
          restoreResult = await fromSource.adapter.unarchive(fromSource.entry)
        } catch (error) {
          restoreResult = { ok: false, error: String(error?.message || error) }
        }
        if (restoreResult && restoreResult.ok === false) {
          results.push({ key, ok: false, error: String(restoreResult.error || 'restore failed') })
          continue
        }
        if (state.items[key]) {
          delete state.items[key]
          dirty = true
        }
        results.push({ key, ok: true })
        continue
      }

      const archived = await stateRepo.readArchive(key)
      if (!archived) {
        results.push({ key, ok: false, error: 'archive not found' })
        continue
      }
      let adapter = null
      try {
        adapter = registry?.get?.(archived.adapterId)
      } catch {
        adapter = null
      }
      if (!adapter) adapter = adapters.find((candidate) => candidate.id === archived.adapterId) || null
      if (!adapter || typeof adapter.add !== 'function') {
        results.push({ key, ok: false, error: 'adapter does not support restore' })
        continue
      }
      let addResult
      try {
        addResult = await adapter.add(archived)
      } catch (error) {
        addResult = { ok: false, error: String(error?.message || error) }
      }
      if (addResult && addResult.ok === false) {
        results.push({ key, ok: false, error: String(addResult.error || 'restore failed') })
        continue
      }
      if (typeof stateRepo.removeArchive === 'function') await dropArchive(stateRepo, key)
      const target = ensureItem(state, key, archived, now)
      target.state = 'active'
      target.archivedAt = 0
      target.expiresAt = 0
      target.resetAt = now
      target.lastSeenAt = now
      if (Number.isFinite(archived.date)) target.date = archived.date
      dirty = true
      results.push({ key, ok: true })
    } catch (error) {
      results.push({ key, ok: false, error: String(error?.message || error) })
    }
  }

  if (dirty && typeof stateRepo.saveState === 'function') await stateRepo.saveState(state)
  return { results }
}
