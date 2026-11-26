// dsh-memory-tide — board tests
// Path: test/board.test.mjs
// Run: node --test test/board.test.mjs

import test from 'node:test'
import assert from 'node:assert/strict'

import { listEntries, act } from '../lib/board.mjs'

const DAY = 86400000
const NOW = Date.UTC(2026, 10, 24, 12, 0, 0)

function makeEntry(adapterId, id, { text = '', date = null, tags = [], track = null, path = null } = {}) {
  return {
    key: `${adapterId}:${id}`,
    adapterId,
    entryId: id,
    date,
    dateText: date === null ? '' : new Date(date).toISOString().slice(0, 10),
    text,
    tags,
    track,
    raw: text,
    path,
  }
}

function makeAdapter(id, entries, { onAdd } = {}) {
  let list = entries.map((entry) => ({ ...entry }))
  const added = []
  return {
    id,
    label: `${id}-label`,
    kind: 'builtin',
    added,
    async describe() {
      return { path: `C:\\libs\\${id}`, count: list.length }
    },
    async list() {
      return list.map((entry) => ({ ...entry }))
    },
    async remove(targets) {
      const keys = new Set((targets || []).map((target) => target.key))
      const before = list.map((entry) => entry.key)
      list = list.filter((entry) => !keys.has(entry.key))
      const after = new Set(list.map((entry) => entry.key))
      return { removed: before.filter((key) => !after.has(key)), failed: [] }
    },
    async add(entry) {
      if (onAdd) {
        const result = onAdd(entry)
        if (result && result.ok === false) return result
      }
      added.push(entry)
      list.push({ ...entry })
      return { ok: true }
    },
  }
}

function makeRegistry(adapters) {
  const byId = new Map(adapters.map((adapter) => [adapter.id, adapter]))
  return {
    adapters: () => adapters,
    get: (id) => byId.get(id),
  }
}

function makeStore(initial = {}) {
  const archives = new Map() // `${tier}|${key}` -> entry
  for (const [tier, entries] of Object.entries(initial)) {
    for (const entry of entries) archives.set(`${tier}|${entry.key}`, { ...entry })
  }
  const calls = { backups: [], puts: [], removedArchives: [], saves: 0 }
  return {
    calls,
    archives,
    async saveState() {
      calls.saves += 1
    },
    async backupFile(path) {
      calls.backups.push(path)
      return `C:\\backup\\${path.split(/[\\/]/).pop()}`
    },
    async putArchive(entry, tier) {
      calls.puts.push({ key: entry.key, tier })
      archives.set(`${tier}|${entry.key}`, { ...entry })
    },
    async readArchive(key) {
      return archives.get(`hot|${key}`) ?? archives.get(`cold|${key}`) ?? null
    },
    async listArchive(tier) {
      return [...archives.entries()]
        .filter(([name]) => name.startsWith(`${tier}|`))
        .map(([, entry]) => ({ ...entry }))
    },
    async removeArchive(key, tier = 'hot') {
      calls.removedArchives.push({ key, tier })
      const tiers = tier === 'both' ? ['hot', 'cold'] : tier === 'cold' ? ['cold'] : ['hot']
      for (const name of tiers) archives.delete(`${name}|${key}`)
    },
  }
}

function makeState(items = {}) {
  return { version: 1, items: { ...items }, deny: [], lastSweepAt: 0, firstSweepDone: true }
}

function makeSettings(overrides = {}) {
  return {
    enabled: true,
    dryRun: false,
    mentions: { enabled: true, minSharedGrams: 2, protectKeywords: '勿删' },
    curve: { model: 'exponential', baseTtlDays: 7, growth: 2, survivalFloor: 0.1, maxTtlEnabled: true, maxTtlDays: 90 },
    archive: { archiveDays: 30, onExpiry: 'cold' },
    board: { pageSize: 100 },
    ...overrides,
  }
}

function setup() {
  const now = (offsetDays = 0) => Date.UTC(2026, 10, 5 + offsetDays, 0, 0, 0)
  const fishEntries = [
    makeEntry('fish', 'a', { text: '普通记忆 A', date: now(-4), tags: ['alpha'] }),
    makeEntry('fish', 'b', { text: '没有日期 B' }),
    makeEntry('fish', 'c', { text: '最近的 C', date: now(0), tags: ['习惯'] }),
  ]
  const evolveEntries = [makeEntry('evolve', 'm1', { text: 'typed memo ALPHA', date: now(-1), track: 'memory' })]
  const fish = makeAdapter('fish', fishEntries)
  const evolve = makeAdapter('evolve', evolveEntries)
  const archiveHot = [makeEntry('fish', 'd', { text: '已归档 D', date: now(-2), path: 'C:\\libs\\fish.json' })]
  const archiveCold = [makeEntry('fish', 'e', { text: '冷归档 E' })]
  const store = makeStore({ hot: archiveHot, cold: archiveCold })
  const state = makeState({
    'fish:c': { state: 'active', pinned: true, touches: 4, firstSeenAt: NOW - 2 * DAY },
    'evolve:m1': { state: 'active', pinned: false, touches: 0, firstSeenAt: NOW - 1 * DAY },
    'fish:d': { state: 'archived', archivedAt: NOW - DAY, expiresAt: NOW + 10 * DAY },
    'fish:e': { state: 'cold', archivedAt: NOW - 40 * DAY },
  })
  const registry = makeRegistry([fish, evolve])
  return { fish, evolve, store, state, registry, settings: makeSettings(), entries: { fishEntries, evolveEntries } }
}

test('listEntries merges live and archive, sorts date desc with null last', async () => {
  const { registry, state, settings, store } = setup()
  const result = await listEntries({ registry, state, settings, store })

  assert.equal(result.total, 6)
  assert.equal(result.page, 1)
  assert.equal(result.pageSize, 100)
  assert.deepEqual(
    result.rows.map((row) => row.key),
    ['fish:c', 'evolve:m1', 'fish:d', 'fish:a', 'fish:b', 'fish:e'],
  )

  const byKey = new Map(result.rows.map((row) => [row.key, row]))
  assert.equal(byKey.get('fish:c').source, 'live')
  assert.equal(byKey.get('fish:c').state, 'active')
  assert.equal(byKey.get('fish:c').pinned, true)
  assert.equal(byKey.get('fish:c').touches, 4)
  assert.equal(byKey.get('fish:d').source, 'archive')
  assert.equal(byKey.get('fish:d').state, 'archived')
  assert.equal(byKey.get('fish:d').adapterLabel, 'fish-label')
  assert.equal(byKey.get('fish:d').expiresAt, NOW + 10 * DAY)

  // 活跃条目的倒计时必须按当前曲线现算（而不是沿用 state 里恒为 0 的 expiresAt）
  assert.equal(byKey.get('fish:c').expiresAt, null) // pinned：永不自动过期
  const expected = NOW - 1 * DAY + 7 * Math.log2(10) * DAY
  assert.ok(Math.abs(byKey.get('evolve:m1').expiresAt - expected) < 1)
  // 还没被清扫登记的新条目：用条目日期当起点，也要能给出倒计时
  const entryDateA = Date.UTC(2026, 10, 1, 0, 0, 0) // setup 里 now(-4)
  const expectedA = entryDateA + 7 * Math.log2(10) * DAY
  assert.ok(Math.abs(byKey.get('fish:a').expiresAt - expectedA) < 1)
  assert.equal(byKey.get('fish:b').expiresAt, null) // 既没 state 也没日期 → 不编造倒计时
  assert.equal(byKey.get('fish:e').state, 'cold')
  assert.equal(byKey.get('fish:b').date, null)
  assert.equal(byKey.get('fish:b').dateText, '')
  assert.equal(byKey.get('evolve:m1').track, 'memory')
})

test('listEntries filters by state, adapter and q, and paginates', async () => {
  const { registry, state, settings, store } = setup()

  const archived = await listEntries({ registry, state, settings, store, query: { state: 'archived' } })
  assert.deepEqual(archived.rows.map((row) => row.key), ['fish:d'])

  const cold = await listEntries({ registry, state, settings, store, query: { state: 'cold' } })
  assert.deepEqual(cold.rows.map((row) => row.key), ['fish:e'])

  const onlyEvolve = await listEntries({ registry, state, settings, store, query: { adapter: 'evolve' } })
  assert.deepEqual(onlyEvolve.rows.map((row) => row.key), ['evolve:m1'])

  const byText = await listEntries({ registry, state, settings, store, query: { q: 'alpha' } })
  assert.deepEqual(byText.rows.map((row) => row.key).sort(), ['evolve:m1', 'fish:a'].sort())

  const byTag = await listEntries({ registry, state, settings, store, query: { q: '习惯' } })
  assert.deepEqual(byTag.rows.map((row) => row.key), ['fish:c'])

  const keyTrack = await listEntries({ registry, state, settings, store, query: { track: 'key' } })
  assert.deepEqual(keyTrack.rows, [])
  const memoryTrack = await listEntries({ registry, state, settings, store, query: { track: 'memory' } })
  assert.deepEqual(memoryTrack.rows.map((row) => row.key), ['evolve:m1'])

  // 「已置顶」筛的是置顶标记，不是 state 字段（置顶条目本身仍是 active）
  const pinnedOnly = await listEntries({ registry, state, settings, store, query: { state: 'pinned' } })
  assert.deepEqual(pinnedOnly.rows.map((row) => row.key), ['fish:c'])

  const page1 = await listEntries({ registry, state, settings, store, query: { page: 1, pageSize: 2 } })
  assert.deepEqual(page1.rows.map((row) => row.key), ['fish:c', 'evolve:m1'])
  const page2 = await listEntries({ registry, state, settings, store, query: { page: 2, pageSize: 2 } })
  assert.deepEqual(page2.rows.map((row) => row.key), ['fish:d', 'fish:a'])
  const page3 = await listEntries({ registry, state, settings, store, query: { page: 3, pageSize: 2 } })
  assert.deepEqual(page3.rows.map((row) => row.key), ['fish:b', 'fish:e'])
  assert.equal(page3.total, 6)
})

test('listEntries keeps empty results sane when adapters throw or state is empty', async () => {
  const broken = {
    id: 'broken',
    label: 'broken',
    async describe() {
      throw new Error('no describe')
    },
    async list() {
      throw new Error('no list')
    },
  }
  const result = await listEntries({
    registry: makeRegistry([broken]),
    state: makeState({}),
    settings: makeSettings(),
    store: makeStore(),
  })
  assert.deepEqual(result, { total: 0, page: 1, pageSize: 100, rows: [] })
})

test('act pin/unpin creates the state item and saves once per batch', async () => {
  const fish = makeAdapter('fish', [makeEntry('fish', 'a', { text: 'A', date: NOW })])
  const store = makeStore()
  const state = makeState()

  const pinned = await act({
    registry: makeRegistry([fish]),
    state,
    settings: makeSettings(),
    op: 'pin',
    keys: ['fish:a'],
    store,
    now: NOW,
  })
  assert.deepEqual(pinned.results, [{ key: 'fish:a', ok: true }])
  assert.equal(state.items['fish:a'].pinned, true)
  assert.equal(state.items['fish:a'].state, 'active')
  assert.equal(store.calls.saves, 1)

  const unpinned = await act({
    registry: makeRegistry([fish]),
    state,
    settings: makeSettings(),
    op: 'unpin',
    keys: ['fish:a'],
    store,
    now: NOW,
  })
  assert.deepEqual(unpinned.results, [{ key: 'fish:a', ok: true }])
  assert.equal(state.items['fish:a'].pinned, false)
  assert.equal(store.calls.saves, 2)
})

test('act archive backs up, writes hot archive and removes the live entry', async () => {
  const path = 'C:\\libs\\fish.json'
  const entry = makeEntry('fish', 'a', { text: '勿删 但手动归档', date: NOW, path })
  const fish = makeAdapter('fish', [entry])
  const store = makeStore()
  const state = makeState()

  const result = await act({
    registry: makeRegistry([fish]),
    state,
    settings: makeSettings(),
    op: 'archive',
    keys: ['fish:a'],
    store,
    now: NOW,
  })

  assert.deepEqual(result.results, [{ key: 'fish:a', ok: true }])
  assert.deepEqual(store.calls.backups, [path])
  assert.deepEqual(store.calls.puts, [{ key: 'fish:a', tier: 'hot' }])
  assert.equal((await fish.list()).length, 0)
  assert.equal(state.items['fish:a'].state, 'archived')
  assert.equal(state.items['fish:a'].archivedAt, NOW)
  assert.equal(state.items['fish:a'].expiresAt, NOW + 30 * DAY)
  assert.equal(store.calls.saves, 1)
})

test('act delete hard-deletes live + archive and clears state', async () => {
  const path = 'C:\\libs\\fish.json'
  const entry = makeEntry('fish', 'a', { text: 'A', date: NOW, path })
  const fish = makeAdapter('fish', [entry])
  const store = makeStore({ hot: [entry] })
  const state = makeState({ 'fish:a': { state: 'archived', touches: 2 } })

  const result = await act({
    registry: makeRegistry([fish]),
    state,
    settings: makeSettings(),
    op: 'delete',
    keys: ['fish:a'],
    store,
    now: NOW,
  })

  assert.deepEqual(result.results, [{ key: 'fish:a', ok: true }])
  assert.deepEqual(store.calls.backups, [path])
  assert.equal((await fish.list()).length, 0)
  assert.equal(await store.readArchive('fish:a'), null)
  assert.ok(store.calls.removedArchives.some((call) => call.key === 'fish:a' && call.tier === 'cold'))
  assert.equal(state.items['fish:a'], undefined)
})

test('act restore re-adds the entry and keeps touches/resetAt semantics', async () => {
  const entry = makeEntry('fish', 'r', { text: '要恢复的', date: NOW, path: 'C:\\libs\\fish.json' })
  const fish = makeAdapter('fish', [])
  const store = makeStore({ cold: [entry] })
  const state = makeState({ 'fish:r': { state: 'cold', touches: 3, pinned: true } })

  const result = await act({
    registry: makeRegistry([fish]),
    state,
    settings: makeSettings(),
    op: 'restore',
    keys: ['fish:r'],
    store,
    now: NOW,
  })

  assert.deepEqual(result.results, [{ key: 'fish:r', ok: true }])
  assert.equal(fish.added.length, 1)
  assert.equal(fish.added[0].key, 'fish:r')
  assert.equal(await store.readArchive('fish:r'), null)
  const item = state.items['fish:r']
  assert.equal(item.state, 'active')
  assert.equal(item.touches, 3)
  assert.equal(item.pinned, true)
  assert.equal(item.resetAt, NOW)
  assert.equal(item.expiresAt, 0)
})

test('act restore reports an adapter without add support', async () => {
  const entry = makeEntry('fish', 'r', { text: 'x', date: NOW })
  const fish = makeAdapter('fish', [])
  fish.add = undefined
  const store = makeStore({ hot: [entry] })
  const state = makeState()

  const result = await act({
    registry: makeRegistry([fish]),
    state,
    settings: makeSettings(),
    op: 'restore',
    keys: ['fish:r'],
    store,
    now: NOW,
  })

  assert.equal(result.results[0].ok, false)
  assert.match(result.results[0].error, /restore/)
  assert.ok(await store.readArchive('fish:r'))
})

test('act returns per-key results for mixed batches and unknown ops', async () => {
  const fish = makeAdapter('fish', [makeEntry('fish', 'a', { text: 'A', date: NOW })])
  const store = makeStore()
  const state = makeState()

  const mixed = await act({
    registry: makeRegistry([fish]),
    state,
    settings: makeSettings(),
    op: 'pin',
    keys: ['fish:a', 'fish:missing'],
    store,
    now: NOW,
  })
  assert.equal(mixed.results.length, 2)
  assert.equal(mixed.results[0].ok, true)
  assert.equal(mixed.results[1].ok, false)
  assert.match(mixed.results[1].error, /not found/)

  const unknown = await act({
    registry: makeRegistry([fish]),
    state,
    settings: makeSettings(),
    op: 'explode',
    keys: ['fish:a'],
    store,
    now: NOW,
  })
  assert.equal(unknown.results[0].ok, false)
  assert.match(unknown.results[0].error, /unknown op/)
})

test('listEntries surfaces source archives and act restores them', async () => {
  const sourceEntry = {
    key: 'evolve-archive:MEMORY.md#1234abcd',
    adapterId: 'evolve',
    entryId: 'MEMORY.md#1234abcd',
    date: Date.UTC(2026, 10, 20),
    dateText: '2026-11-20',
    text: '源归档的一条',
    raw: '[2026-11-20] 源归档的一条',
    tags: ['源归档'],
    archived: true,
    file: 'C:\\mem\\MEMORY.md',
    archiveFile: 'C:\\mem\\MEMORY-archive.md',
    path: 'C:\\mem\\MEMORY-archive.md',
  }
  const restored = []
  const evolve = {
    id: 'evolve',
    label: 'memory-evolve',
    async list() {
      return []
    },
    async listArchived() {
      return [sourceEntry]
    },
    async unarchive(entry) {
      restored.push(entry.key)
      return { ok: true }
    },
    async add() {
      return { ok: true }
    },
    async remove() {
      return { removed: [], failed: [] }
    },
  }
  const store = makeStore()
  const state = makeState()
  const board = await listEntries({
    registry: makeRegistry([evolve]),
    state,
    settings: makeSettings(),
    store,
  })
  assert.equal(board.total, 1)
  assert.equal(board.rows[0].source, 'source-archive')
  assert.equal(board.rows[0].state, 'archived')

  const archivedOnly = await listEntries({
    registry: makeRegistry([evolve]),
    state,
    settings: makeSettings(),
    query: { state: 'archived' },
    store,
  })
  assert.equal(archivedOnly.total, 1)

  const restore = await act({
    registry: makeRegistry([evolve]),
    state,
    settings: makeSettings(),
    op: 'restore',
    keys: [sourceEntry.key],
    store,
    now: NOW,
  })
  assert.equal(restore.results[0].ok, true)
  assert.deepEqual(restored, [sourceEntry.key])

  const deleted = await act({
    registry: makeRegistry([evolve]),
    state,
    settings: makeSettings(),
    op: 'delete',
    keys: [sourceEntry.key],
    store,
    now: NOW,
  })
  assert.equal(deleted.results[0].ok, false)
  assert.match(deleted.results[0].error, /restored/)
})
