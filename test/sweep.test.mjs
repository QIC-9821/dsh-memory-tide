import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { sweep } from '../lib/sweep.mjs'
import * as store from '../lib/store.mjs'

const DAY = 86400000
const NOW = 1795000000000

// 所有落盘都指向临时目录，绝不碰真实 ~/.dsh。
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-tide-sweep-'))
process.env.DSH_MEMORY_TIDE_HOME = TMP

test.after(async () => {
  await fs.rm(TMP, { recursive: true, force: true })
})

async function resetStore() {
  await fs.rm(TMP, { recursive: true, force: true })
  await fs.mkdir(TMP, { recursive: true })
}

function baseSettings() {
  return {
    enabled: true,
    dryRun: false,
    curve: { baseTtlDays: 7, growth: 2, maxTtlEnabled: true, maxTtlDays: 90 },
    mentions: { enabled: true, minSharedGrams: 2, protectKeywords: '勿删,待确认,不要删除' },
    archive: { archiveDays: 30, onExpiry: 'cold' },
    sweep: { intervalMinutes: 30, onTurnEnd: true, startupDelaySec: 10 },
    adapters: { fish: { enabled: true, mode: 'archive', maxEntries: 300 } },
    customAdapters: [],
    discovery: { enabled: true, autoAdoptHighConfidence: false, deny: [] },
    board: { pageSize: 100 },
  }
}

function fishEntry(entryId, text, tags = [], over = {}) {
  return {
    key: `fish:${entryId}`,
    adapterId: 'fish',
    entryId,
    date: NOW,
    dateText: '2026-11-07',
    text,
    tags,
    track: null,
    raw: text,
    ...over,
  }
}

function fishItem(entryId, over = {}) {
  return {
    adapterId: 'fish',
    entryId,
    firstSeenAt: NOW - 100 * DAY,
    lastSeenAt: NOW - 100 * DAY,
    lastRecalledAt: 0,
    resetAt: 0,
    touches: 0,
    pinned: false,
    state: 'active',
    archivedAt: 0,
    expiresAt: 0,
    date: NOW,
    textHash: '',
    ...over,
  }
}

// 假适配器：entries 可增删，remove 结果可配置失败/延迟。
function makeAdapter(id, entries, overrides = {}) {
  const local = {
    entries: entries.map((e) => ({ ...e })),
    listCalls: 0,
    removeCalls: [],
  }
  const adapter = {
    id,
    label: id,
    kind: 'builtin',
    async list() {
      local.listCalls += 1
      if (overrides.listError) throw new Error(overrides.listError)
      return local.entries.map((e) => ({ ...e }))
    },
    async remove(list) {
      local.removeCalls.push(list.map((e) => e.key))
      if (overrides.onRemove) await overrides.onRemove()
      if (overrides.removeError) throw new Error(overrides.removeError)
      if (overrides.removeFail) return { removed: [], failed: list.map((e) => ({ key: e.key, error: 'boom' })) }
      const keys = new Set(list.map((e) => e.key))
      local.entries = local.entries.filter((e) => !keys.has(e.key))
      const removed = list.map((e) => e.key).filter((k) => !local.entries.some((e) => e.key === k))
      return { removed, failed: [] }
    },
  }
  return { adapter, local }
}

function reg(...adapters) {
  return { adapters: () => adapters }
}

function makeLogger(sink = []) {
  const push = (level) => (msg) => sink.push(`${level}: ${msg}`)
  return { info: push('info'), warn: push('warn'), error: push('error') }
}

test('到期活跃条目：写 hot 归档并从 adapter 移除，state 转 archived', async () => {
  await resetStore()
  const f = makeAdapter('fish', [fishEntry('a', '陈旧的记忆条目')])
  const state = store.emptyState()
  state.items['fish:a'] = fishItem('a', { firstSeenAt: NOW - 30 * DAY })
  const logs = []
  const settings = baseSettings()

  const report = await sweep({ registry: reg(f.adapter), state, settings, logger: makeLogger(logs), now: NOW })
  const row = report.adapters[0]

  assert.equal(report.at, NOW)
  assert.equal(report.dryRun, false)
  assert.equal(row.id, 'fish')
  assert.equal(row.checked, 1)
  assert.equal(row.expired, 1)
  assert.equal(row.archived, 1)
  assert.equal(row.deleted, 0)
  assert.equal(row.failed, 0)
  assert.equal(f.local.entries.length, 0)

  const item = state.items['fish:a']
  assert.equal(item.state, 'archived')
  assert.equal(item.archivedAt, NOW)
  assert.equal(item.expiresAt, NOW + 30 * DAY)

  const hot = await store.listArchive('hot')
  assert.equal(hot.length, 1)
  assert.equal(hot[0].key, 'fish:a')
  assert.equal(hot[0].text, '陈旧的记忆条目')
  assert.equal(hot[0].tombstone.cause, 'decay')
  assert.equal(hot[0].tombstone.actor, 'sweep')
  assert.equal(hot[0].tombstone.at, NOW)
  assert.equal(hot[0].tombstone.idleDays, 30)
  assert.ok(hot[0].tombstone.ttlDays > 0)
  assert.ok(logs.some((l) => l.includes('fish') && l.includes('archived=1')))
})

test('dryRun：只统计，不写归档、不改 state、不动 adapter', async () => {
  await resetStore()
  const f = makeAdapter('fish', [fishEntry('a', '陈旧的记忆条目')])
  const state = store.emptyState()
  state.items['fish:a'] = fishItem('a', { firstSeenAt: NOW - 30 * DAY })
  const settings = baseSettings()

  const report = await sweep({ registry: reg(f.adapter), state, settings, logger: makeLogger(), now: NOW, dryRun: true })
  const row = report.adapters[0]

  assert.equal(report.dryRun, true)
  assert.equal(row.checked, 1)
  assert.equal(row.expired, 1)
  assert.equal(row.archived, 1)
  assert.equal(f.local.entries.length, 1)
  assert.equal(state.items['fish:a'].state, 'active')
  assert.equal(state.items['fish:a'].archivedAt, 0)
  assert.equal(state.items['fish:a'].lastSeenAt, NOW - 100 * DAY)
  assert.equal(await store.readArchive('fish:a'), null)
  assert.deepEqual(await store.listArchive('hot'), [])
})

test('mode=delete：到期条目硬删，state item 一起删', async () => {
  await resetStore()
  const f = makeAdapter('fish', [fishEntry('a', '到期就删')])
  const state = store.emptyState()
  state.items['fish:a'] = fishItem('a', { firstSeenAt: NOW - 30 * DAY })
  const settings = baseSettings()
  settings.adapters.fish.mode = 'delete'

  const report = await sweep({ registry: reg(f.adapter), state, settings, logger: makeLogger(), now: NOW })
  const row = report.adapters[0]

  assert.equal(row.deleted, 1)
  assert.equal(row.archived, 0)
  assert.equal(f.local.entries.length, 0)
  assert.equal('fish:a' in state.items, false)
  assert.deepEqual(await store.listArchive('hot'), [])
})

test('首次见到的条目：初始化 firstSeenAt，不立即到期', async () => {
  await resetStore()
  const f = makeAdapter('fish', [fishEntry('n', '刚刚出现的新记忆')])
  const state = store.emptyState()
  const settings = baseSettings()

  const report = await sweep({ registry: reg(f.adapter), state, settings, logger: makeLogger(), now: NOW })

  assert.equal(report.adapters[0].checked, 1)
  assert.equal(report.adapters[0].archived, 0)
  assert.equal(f.local.entries.length, 1)
  const item = state.items['fish:n']
  assert.equal(item.firstSeenAt, NOW)
  assert.equal(item.lastSeenAt, NOW)
  assert.equal(item.state, 'active')
  assert.equal(item.touches, 0)
})

test('pinned / 保护词 / 冷归档 都跳过', async () => {
  await resetStore()
  const f = makeAdapter('fish', [
    fishEntry('p', '置顶的老条目'),
    fishEntry('k', '这条勿删请保留'),
    fishEntry('c', '已经冷归档的条目'),
  ])
  const state = store.emptyState()
  state.items['fish:p'] = fishItem('p', { pinned: true, firstSeenAt: NOW - 300 * DAY })
  state.items['fish:k'] = fishItem('k', { firstSeenAt: NOW - 300 * DAY })
  state.items['fish:c'] = fishItem('c', { state: 'cold', archivedAt: NOW - 300 * DAY, expiresAt: NOW - 300 * DAY })

  const report = await sweep({ registry: reg(f.adapter), state, settings: baseSettings(), logger: makeLogger(), now: NOW })
  const row = report.adapters[0]

  assert.equal(row.checked, 3)
  assert.equal(row.expired, 0)
  assert.equal(row.archived, 0)
  assert.equal(row.cooled, 0)
  assert.equal(f.local.entries.length, 3)
  assert.equal(state.items['fish:p'].pinned, true)
  assert.equal(state.items['fish:k'].state, 'active')
  assert.equal(state.items['fish:c'].state, 'cold')
})

test('归档期满 onExpiry=cold：hot 转 cold，墓碑跟着抄过去', async () => {
  await resetStore()
  const entry = fishEntry('a', '已经归档一阵子的条目')
  const tombstone = {
    v: 1,
    at: NOW - 60 * DAY,
    actor: 'sweep',
    cause: 'decay',
    preview: '已经归档一阵子的条目',
    lastActiveAt: NOW - 90 * DAY,
    idleDays: 30,
    touches: 1,
    ttlDays: 21,
  }
  await store.putArchive({ ...entry, tombstone }, 'hot')
  const f = makeAdapter('fish', [entry])
  const state = store.emptyState()
  state.items['fish:a'] = fishItem('a', { state: 'archived', archivedAt: NOW - 60 * DAY, expiresAt: NOW - 1 })

  const report = await sweep({ registry: reg(f.adapter), state, settings: baseSettings(), logger: makeLogger(), now: NOW })
  const row = report.adapters[0]

  assert.equal(row.expired, 1)
  assert.equal(row.cooled, 1)
  assert.equal(row.failed, 0)
  assert.equal(state.items['fish:a'].state, 'cold')
  assert.deepEqual(await store.listArchive('hot'), [])
  const cold = await store.listArchive('cold')
  assert.equal(cold.length, 1)
  assert.equal(cold[0].key, 'fish:a')
  assert.equal(cold[0].tombstone.preview, '已经归档一阵子的条目')
  assert.equal(cold[0].tombstone.cause, 'decay')
})

test('归档期满 onExpiry=delete：删 hot 归档、删 item、adapter 里还在就再删一次', async () => {
  await resetStore()
  const entry = fishEntry('a', '归档也要删掉')
  await store.putArchive(entry, 'hot')
  const f = makeAdapter('fish', [entry])
  const state = store.emptyState()
  state.items['fish:a'] = fishItem('a', { state: 'archived', archivedAt: NOW - 60 * DAY, expiresAt: NOW - 1 })
  const settings = baseSettings()
  settings.archive.onExpiry = 'delete'

  const report = await sweep({ registry: reg(f.adapter), state, settings, logger: makeLogger(), now: NOW })
  const row = report.adapters[0]

  assert.equal(row.expired, 1)
  assert.equal(row.deleted, 1)
  assert.equal(f.local.entries.length, 0)
  assert.equal('fish:a' in state.items, false)
  assert.deepEqual(await store.listArchive('hot'), [])
})

test('maxEntries 硬上限：touches 少、lastActivity 旧的先被归档', async () => {
  await resetStore()
  const f = makeAdapter('fish', [
    fishEntry('a', '最近常提到的'),
    fishEntry('b', '偶尔提到的'),
    fishEntry('c', '很久没提的'),
  ])
  const state = store.emptyState()
  state.items['fish:a'] = fishItem('a', { touches: 5, resetAt: NOW - 1000 })
  state.items['fish:b'] = fishItem('b', { touches: 3, resetAt: NOW - 2000 })
  state.items['fish:c'] = fishItem('c', { touches: 0, resetAt: NOW - 3000 })
  const settings = baseSettings()
  settings.adapters.fish.maxEntries = 2

  const report = await sweep({ registry: reg(f.adapter), state, settings, logger: makeLogger(), now: NOW })
  const row = report.adapters[0]

  assert.equal(row.expired, 0)
  assert.equal(row.archived, 1)
  assert.equal(state.items['fish:a'].state, 'active')
  assert.equal(state.items['fish:b'].state, 'active')
  assert.equal(state.items['fish:c'].state, 'archived')
  assert.deepEqual(f.local.entries.map((e) => e.entryId), ['a', 'b'])
})

test('adapter.remove 失败：state 保持 active、hot 归档回滚、记 failed', async () => {
  await resetStore()
  const f = makeAdapter('fish', [fishEntry('a', '删不掉的条目')], { removeFail: true })
  const state = store.emptyState()
  state.items['fish:a'] = fishItem('a', { firstSeenAt: NOW - 30 * DAY })

  const report = await sweep({ registry: reg(f.adapter), state, settings: baseSettings(), logger: makeLogger(), now: NOW })
  const row = report.adapters[0]

  assert.equal(row.failed, 1)
  assert.equal(row.archived, 0)
  assert.equal(state.items['fish:a'].state, 'active')
  assert.equal(f.local.entries.length, 1)
  assert.ok(report.warnings.some((w) => w.includes('boom')))
  assert.deepEqual(await store.listArchive('hot'), [])
})

test('adapter.list 抛错：只记 failed + warning，不中断其它适配器', async () => {
  await resetStore()
  const bad = makeAdapter('fish', [], { listError: 'disk on fire' })
  const goodEntry = fishEntry('g', '正常条目')
  const good = makeAdapter('good', [{ ...goodEntry, key: 'good:g', adapterId: 'good' }])
  const state = store.emptyState()

  const report = await sweep({
    registry: reg(bad.adapter, good.adapter),
    state,
    settings: baseSettings(),
    logger: makeLogger(),
    now: NOW,
  })

  assert.equal(report.adapters.length, 2)
  assert.equal(report.adapters[0].id, 'fish')
  assert.equal(report.adapters[0].failed, 1)
  assert.equal(report.adapters[1].id, 'good')
  assert.equal(report.adapters[1].checked, 1)
  assert.ok(report.warnings.some((w) => w.includes('disk on fire')))
})

test('settings.adapters[id].enabled=false 的适配器直接跳过', async () => {
  await resetStore()
  const f = makeAdapter('fish', [fishEntry('a', '不该被碰')])
  const state = store.emptyState()
  state.items['fish:a'] = fishItem('a', { firstSeenAt: NOW - 30 * DAY })
  const settings = baseSettings()
  settings.adapters.fish.enabled = false

  const report = await sweep({ registry: reg(f.adapter), state, settings, logger: makeLogger(), now: NOW })

  assert.equal(report.adapters.length, 0)
  assert.equal(f.local.listCalls, 0)
  assert.equal(f.local.entries.length, 1)
})

test('自定义适配器默认 enabled，mode 取 customAdapters 里的值', async () => {
  await resetStore()
  const entry = {
    key: 'custom:note:abc',
    adapterId: 'custom:note',
    entryId: 'abc',
    date: NOW,
    dateText: '2026-11-07',
    text: '自定义来源的旧条目',
    tags: [],
    track: null,
  }
  const a = makeAdapter('custom:note', [entry])
  const state = store.emptyState()
  state.items['custom:note:abc'] = {
    ...fishItem('abc'),
    adapterId: 'custom:note',
    entryId: 'abc',
    firstSeenAt: NOW - 30 * DAY,
  }
  const settings = baseSettings()
  settings.customAdapters = [
    { id: 'custom:note', type: 'file-md', label: '笔记', path: 'C:\\tmp\\note.md', mode: 'delete', format: {} },
  ]

  const report = await sweep({ registry: reg(a.adapter), state, settings, logger: makeLogger(), now: NOW })

  assert.equal(report.adapters[0].id, 'custom:note')
  assert.equal(report.adapters[0].deleted, 1)
  assert.equal(a.local.entries.length, 0)
  assert.equal('custom:note:abc' in state.items, false)
})

test('整个 sweep 串行：remove 不会并发', async () => {
  await resetStore()
  let concurrent = 0
  let maxConcurrent = 0
  const f = makeAdapter('fish', [
    fishEntry('a', '旧条目 a'),
    fishEntry('b', '旧条目 b'),
    fishEntry('c', '旧条目 c'),
  ], {
    onRemove: async () => {
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise((r) => setTimeout(r, 5))
      concurrent -= 1
    },
  })
  const state = store.emptyState()
  for (const id of ['a', 'b', 'c']) {
    state.items[`fish:${id}`] = fishItem(id, { firstSeenAt: NOW - 30 * DAY })
  }

  const report = await sweep({ registry: reg(f.adapter), state, settings: baseSettings(), logger: makeLogger(), now: NOW })

  assert.equal(report.adapters[0].archived, 3)
  assert.equal(maxConcurrent, 1)
  assert.equal(state.items['fish:a'].state, 'archived')
})
