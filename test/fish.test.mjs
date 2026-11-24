// Tests for the fish-memory adapter. Every test works on a fresh mkdtemp copy;
// the real ~/.dsh/fish-memory stores are only ever read, never written.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createFishAdapter,
  listStoreFiles,
  readStoreFile,
  writeStoreAtomic,
} from '../lib/adapters/fish.mjs'
import { createRegistry } from '../lib/adapters/registry.mjs'

// Optional sample store for a read-only smoke test. Point this at any real
// fish-memory JSON file to exercise the adapter against real data; the test
// always copies it into a temp dir first and skips when it is not set.
const REAL_FISH_STORE = process.env.DSH_FISH_STORE_SAMPLE || ''

function memory(id, text, extra = {}) {
  return {
    id,
    text,
    at: '2026-11-24T12:43:33.802Z',
    createdAt: '2026-11-24T12:43:33.802Z',
    category: 'event',
    importance: 0.5,
    emotion: null,
    tags: ['记忆', '测试'],
    source: '她自己记的',
    reinforcedAt: null,
    lastReinforcedDay: null,
    related: [],
    relatedAt: null,
    ...extra,
  }
}

function fixture() {
  return {
    version: 2,
    policy: { maxItems: 6, maxChars: 800 },
    memories: [
      memory('mm1', '第一条记忆：插件习惯评估'),
      memory('mm2', '第二条记忆：带“引号”和 emoji 🐋'),
      memory('mm3', '第三条记忆：尾巴摇摇'),
    ],
    traces: [{ id: 't1', at: '2026-11-24T12:43:33.802Z', hits: 2 }],
    deleted: [],
    purgeEpoch: 'epoch-1',
  }
}

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'mtd-fish-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

async function writeStore(dir, name, data, { old = true } = {}) {
  const path = join(dir, name)
  await mkdir(dir, { recursive: true })
  await writeFile(path, JSON.stringify(data, null, 2), 'utf8')
  if (old) await makeOld(path)
  return path
}

async function makeOld(path, seconds = 60) {
  const when = new Date(Date.now() - seconds * 1000)
  await utimes(path, when, when)
}

function collectingLogger() {
  const lines = { info: [], warn: [], error: [] }
  return {
    logger: {
      info: (...args) => lines.info.push(args.join(' ')),
      warn: (...args) => lines.warn.push(args.join(' ')),
      error: (...args) => lines.error.push(args.join(' ')),
    },
    lines,
  }
}

function backupStub() {
  const calls = []
  return {
    backupFile: async (path) => {
      calls.push(path)
      return `${path}.bak-test`
    },
    calls,
  }
}

test('fish: list reads every store file and maps the Entry contract', async (t) => {
  const dir = await tempDir(t)
  const first = await writeStore(dir, 'ws_test.json', fixture())
  const second = await writeStore(dir, 'session-test.json', {
    version: 2,
    policy: {},
    memories: [memory('s1', '会话记忆')],
    traces: [],
    deleted: [],
    purgeEpoch: '',
  })
  assert.deepEqual(await listStoreFiles(dir), [second, first])

  const adapter = createFishAdapter({ dir })
  const entries = await adapter.list()
  assert.equal(entries.length, 4)

  const entry = entries.find((item) => item.entryId === 'mm2')
  assert.ok(entry)
  assert.equal(entry.key, 'fish:mm2')
  assert.equal(entry.adapterId, 'fish')
  assert.equal(entry.track, null)
  assert.equal(entry.text, '第二条记忆：带“引号”和 emoji 🐋')
  assert.deepEqual(entry.tags, ['记忆', '测试'])
  assert.equal(entry.date, Date.parse('2026-11-24T12:43:33.802Z'))
  assert.match(entry.dateText, /^2026-11-2[34]$/)
  assert.equal(entry.path, first)
  assert.deepEqual(JSON.parse(entry.raw), fixture().memories[1])

  const description = await adapter.describe()
  assert.equal(description.path, dir)
  assert.equal(description.count, 4)
})

test('fish: a file modified less than 2s ago is busy and skipped', async (t) => {
  const dir = await tempDir(t)
  const fresh = await writeStore(dir, 'ws_fresh.json', {
    version: 2,
    policy: {},
    memories: [memory('fresh1', '刚写完')],
    traces: [],
    deleted: [],
    purgeEpoch: '',
  })
  await makeOld(fresh, 0.5)
  const old = await writeStore(dir, 'ws_old.json', {
    version: 2,
    policy: {},
    memories: [memory('old1', '早就写完了')],
    traces: [],
    deleted: [],
    purgeEpoch: '',
  })
  const { logger, lines } = collectingLogger()
  const adapter = createFishAdapter({ dir, logger })

  const busyOnly = await adapter.list()
  assert.deepEqual(
    busyOnly.map((entry) => entry.entryId),
    ['old1'],
  )
  assert.ok(lines.info.some((line) => line.includes('busy')))

  const busyEntry = {
    key: 'fish:fresh1',
    adapterId: 'fish',
    entryId: 'fresh1',
    path: fresh,
  }
  const refused = await adapter.remove([busyEntry])
  assert.deepEqual(refused.removed, [])
  assert.equal(refused.failed.length, 1)
  assert.match(refused.failed[0].error, /busy/)

  await makeOld(fresh)
  const afterWait = await adapter.list()
  assert.equal(afterWait.length, 2)
  assert.ok(afterWait.some((entry) => entry.path === old))
})

test('fish: files that fail the version/memories schema are skipped with a warning', async (t) => {
  const dir = await tempDir(t)
  await writeStore(dir, 'v1.json', {
    version: 1,
    memories: [memory('v1', '旧版本')],
  })
  await writeStore(dir, 'bad-memories.json', {
    version: 2,
    memories: { not: 'an array' },
  })
  const good = await writeStore(dir, 'good.json', {
    version: 2,
    policy: {},
    memories: [memory('good1', '好文件')],
    traces: [],
    deleted: [],
    purgeEpoch: '',
  })
  const { logger, lines } = collectingLogger()
  const adapter = createFishAdapter({ dir, logger })

  const entries = await adapter.list()
  assert.equal(entries.length, 1)
  assert.equal(entries[0].entryId, 'good1')
  assert.equal(entries[0].path, good)
  assert.ok(lines.warn.some((line) => line.includes('version')))
  assert.ok(lines.warn.some((line) => line.includes('memories')))
  assert.ok(lines.warn.every((line) => line.includes('does not match the fish-memory schema')))
})

test('fish: remove keeps every other entry byte-identical and never writes deleted[]', async (t) => {
  const dir = await tempDir(t)
  const data = fixture()
  const path = await writeStore(dir, 'ws_test.json', data)
  const beforeText = await readFile(path, 'utf8')
  assert.equal(beforeText.endsWith('\n'), false)
  const before = JSON.parse(beforeText)

  const { logger } = collectingLogger()
  const { backupFile, calls } = backupStub()
  const adapter = createFishAdapter({ dir, logger, backupFile })
  const entries = await adapter.list()
  const target = entries.find((entry) => entry.entryId === 'mm2')
  const result = await adapter.remove([target])

  assert.deepEqual(result.removed, ['fish:mm2'])
  assert.deepEqual(result.failed, [])
  assert.deepEqual(calls, [path])

  const afterText = await readFile(path, 'utf8')
  const after = JSON.parse(afterText)
  assert.equal(
    JSON.stringify(after.memories),
    JSON.stringify(before.memories.filter((item) => item.id !== 'mm2')),
  )
  assert.equal(
    after.memories.find((item) => item.id === 'mm1').text,
    '第一条记忆：插件习惯评估',
  )
  assert.deepEqual(after.traces, before.traces)
  assert.deepEqual(after.policy, before.policy)
  assert.deepEqual(after.deleted, [])
  assert.equal(after.purgeEpoch, 'epoch-1')
  assert.equal(afterText.endsWith('\n'), false, 'the original no-EOL style is preserved')

  await makeOld(path)
  const remaining = await adapter.list()
  assert.equal(remaining.length, 2)
  assert.ok(!remaining.some((entry) => entry.entryId === 'mm2'))
})

test('fish: writeStoreAtomic refuses when the store changed since it was read', async (t) => {
  const dir = await tempDir(t)
  const path = await writeStore(dir, 'ws_test.json', fixture())
  const readMtime = (await stat(path)).mtimeMs
  const original = await readFile(path, 'utf8')

  // A second writer touches the file after we read it.
  await makeOld(path, 30)
  const refused = await writeStoreAtomic(path, original, { expectedMtimeMs: readMtime })
  assert.equal(refused.ok, false)
  assert.match(refused.error, /conflict/)
  assert.equal(await readFile(path, 'utf8'), original)

  const accepted = await writeStoreAtomic(path, original, {
    expectedMtimeMs: (await stat(path)).mtimeMs,
  })
  assert.equal(accepted.ok, true)
})

test('fish: add appends a fish-memory shaped object that list reads back', async (t) => {
  const dir = await tempDir(t)
  const path = await writeStore(dir, 'ws_test.json', fixture())
  const { logger } = collectingLogger()
  const { backupFile } = backupStub()
  const adapter = createFishAdapter({ dir, logger, backupFile })

  const when = Date.parse('2026-11-24T10:00:00.000Z')
  const added = await adapter.add({
    text: '恢复回来的一条记忆',
    date: when,
    tags: ['恢复', 7],
    entryId: 'restored1',
    path,
  })
  assert.equal(added.ok, true, added.error)

  await makeOld(path)
  const data = JSON.parse(await readFile(path, 'utf8'))
  const stored = data.memories.find((item) => item.id === 'restored1')
  assert.ok(stored)
  assert.equal(stored.text, '恢复回来的一条记忆')
  assert.equal(stored.category, 'note')
  assert.equal(stored.importance, 0.5)
  assert.equal(stored.emotion, null)
  assert.deepEqual(stored.tags, ['恢复'])
  assert.equal(stored.source, 'memory-tide')
  assert.equal(stored.at, new Date(when).toISOString())
  assert.equal(stored.createdAt, new Date(when).toISOString())
  assert.equal(data.memories.length, 4)

  const entries = await adapter.list()
  const roundTrip = entries.find((entry) => entry.entryId === 'restored1')
  assert.ok(roundTrip)
  assert.equal(roundTrip.text, '恢复回来的一条记忆')
  assert.equal(roundTrip.date, when)
  assert.deepEqual(roundTrip.tags, ['恢复'])
})

test('fish: add refuses when there is no store to restore into', async (t) => {
  const dir = await tempDir(t)
  const adapter = createFishAdapter({ dir })
  const result = await adapter.add({ text: '没有库' })
  assert.equal(result.ok, false)
  assert.match(result.error, /no fish-memory store file/)
})

test('fish: the real store sample is readable from a temporary copy', async (t) => {
  const dir = await tempDir(t)
  const path = join(dir, 'ws_real.json')
  if (!REAL_FISH_STORE) {
    t.skip('set DSH_FISH_STORE_SAMPLE to a real fish-memory JSON file to run this')
    return
  }
  try {
    await copyFile(REAL_FISH_STORE, path)
  } catch (error) {
    if (error.code === 'ENOENT') {
      t.skip('real fish store sample is not present on this machine')
      return
    }
    throw error
  }
  await makeOld(path)
  const before = await readFile(path, 'utf8')
  const beforeStat = await stat(path)
  const adapter = createFishAdapter({ dir })
  const entries = await adapter.list()

  assert.ok(entries.length >= 1)
  assert.ok(entries.every((entry) => entry.adapterId === 'fish'))
  const parsed = JSON.parse(before)
  for (const entry of entries) {
    const raw = JSON.parse(entry.raw)
    assert.deepEqual(raw, parsed.memories.find((item) => item.id === raw.id))
    assert.equal(entry.key, `fish:${entry.entryId}`)
  }
  assert.equal(await readFile(path, 'utf8'), before)
  assert.equal((await stat(path)).mtimeMs, beforeStat.mtimeMs)
})

test('registry: built-ins plus custom adapters, with failures skipped safely', async (t) => {
  const dir = await tempDir(t)
  const { logger, lines } = collectingLogger()
  const fakeFileMd = {
    createFileMdAdapter: (config) => ({
      id: config.id,
      label: config.label || 'custom notes',
      kind: 'file-md',
      describe: async () => ({ path: config.path, count: 1 }),
      list: async () => [
        {
          key: `${config.id}:n1`,
          adapterId: config.id,
          entryId: 'n1',
          date: null,
          dateText: '',
          text: 'custom entry',
          tags: [],
          track: null,
          raw: 'custom entry',
        },
      ],
      remove: async () => ({ removed: [], failed: [] }),
      add: async () => ({ ok: true }),
    }),
  }
  const registry = createRegistry({
    settings: {
      customAdapters: [
        { id: 'custom:notes', type: 'file-md', label: 'Notes', path: join(dir, 'notes.md') },
        { id: 'custom:broken', type: 'file-json' },
        { id: 'custom:unknown', type: 'nope' },
      ],
    },
    logger,
    loadAdapterModule: async (specifier) => {
      if (specifier === './file-md.mjs') return fakeFileMd
      throw new Error('module not found')
    },
  })

  const builtins = registry.adapters()
  assert.deepEqual(
    builtins.map((adapter) => adapter.id).sort(),
    ['evolve', 'fish'],
  )
  assert.equal(registry.get('fish').kind, 'builtin')

  await registry.reload()
  assert.ok(registry.get('custom:notes'))
  assert.equal(registry.get('custom:notes').label, 'Notes')
  const listed = await registry.get('custom:notes').list()
  assert.equal(listed.length, 1)
  assert.equal(registry.get('custom:broken'), undefined)
  assert.equal(registry.get('custom:unknown'), undefined)
  assert.ok(lines.warn.some((line) => line.includes('custom:broken')))
  assert.ok(lines.warn.some((line) => line.includes('unsupported type')))

  const source = registry.registerSource({
    id: 'third-party',
    label: 'Third party',
    list: async () => [
      {
        entryId: 'x1',
        date: null,
        dateText: '',
        text: 'third',
        tags: [],
        track: null,
        raw: 'third',
      },
    ],
    remove: async () => ({ removed: ['third-party:x1'], failed: [] }),
  })
  assert.equal(source.id, 'third-party')
  assert.equal((await registry.get('third-party').list())[0].key, 'third-party:x1')
  assert.equal(registry.unregisterSource('third-party'), true)
  assert.equal(registry.get('third-party'), undefined)

  // A broken registered adapter must not throw into the sweep.
  registry.registerSource({
    id: 'explodes',
    label: 'Explodes',
    list: async () => {
      throw new Error('boom')
    },
    remove: async () => {
      throw new Error('boom')
    },
  })
  assert.deepEqual(await registry.get('explodes').list(), [])
  const removal = await registry.get('explodes').remove([
    { key: 'explodes:1', entryId: '1' },
  ])
  assert.deepEqual(removal.removed, [])
  assert.equal(removal.failed[0].key, 'explodes:1')
  assert.match(removal.failed[0].error, /boom/)
})

test('fish: readStoreFile reports a missing file without throwing', async (t) => {
  const dir = await tempDir(t)
  const state = await readStoreFile(join(dir, 'nope.json'))
  assert.equal(state.ok, false)
  assert.equal(state.missing, true)
})
