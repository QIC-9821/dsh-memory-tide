import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  DEFAULTS,
  defaultStandalonePath,
  resolveStandalonePath,
  sanitizeSettings,
} from '../lib/settings.mjs'
import { createRegistry } from '../lib/adapters/registry.mjs'

function collectingLogger() {
  const lines = { info: [], warn: [], error: [] }
  const wrap = (level) => (...args) => lines[level].push(args.join(' '))
  return { logger: { info: wrap('info'), warn: wrap('warn'), error: wrap('error') }, lines }
}

test('defaultStandalonePath 跟着 DSH_HOME 走，指向 memory-tide/MEMORY.md', () => {
  const saved = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = join('tmp', 'dsh-home')
    assert.equal(defaultStandalonePath(), join('tmp', 'dsh-home', 'memories', 'memory-tide', 'MEMORY.md'))
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
  }
})

test('resolveStandalonePath：path 留空回落默认，填了就用填的', () => {
  assert.equal(resolveStandalonePath({}), defaultStandalonePath())
  assert.equal(resolveStandalonePath({ standalone: { path: '   ' } }), defaultStandalonePath())
  assert.equal(resolveStandalonePath({ standalone: { path: '/tmp/notes.md' } }), '/tmp/notes.md')
})

test('sanitizeSettings：standalone 默认开启、格式只认 md、mode 只认 archive/delete', () => {
  const defaults = sanitizeSettings({}).settings
  assert.deepEqual(defaults.standalone, DEFAULTS.standalone)

  const custom = sanitizeSettings({
    standalone: { enabled: false, path: '/tmp/m.md', format: 'json', delimiter: 'blank', mode: 'nuke' },
  }).settings
  assert.equal(custom.standalone.enabled, false)
  assert.equal(custom.standalone.path, '/tmp/m.md')
  assert.equal(custom.standalone.format, 'md')
  assert.equal(custom.standalone.mode, 'archive')
})

test('registry：standalone 开启时生成一个独立记忆文件适配器', async () => {
  const dir = await import('node:fs/promises').then((fs) => fs.mkdtemp(join(process.env.TEMP || '.', 'tide-standalone-')))
  const fakeFileMd = {
    createFileMdAdapter: (config) => ({
      id: config.id,
      label: config.label,
      kind: 'file-md',
      describe: async () => ({ path: config.path, count: 0 }),
      list: async () => [],
      remove: async () => ({ removed: [], failed: [] }),
    }),
  }
  const { logger } = collectingLogger()
  const settings = {
    standalone: { enabled: true, path: join(dir, 'MEMORY.md'), format: 'md', delimiter: 'blank', mode: 'archive' },
  }
  const registry = createRegistry({
    settings,
    getSettings: () => settings,
    logger,
    loadAdapterModule: async (specifier) => {
      if (specifier === './file-md.mjs') return fakeFileMd
      throw new Error('not found')
    },
  })
  await registry.reload()
  const adapter = registry.get('standalone')
  assert.ok(adapter, 'standalone adapter should exist')
  assert.equal(adapter.label, '独立记忆文件')
  const described = await adapter.describe()
  assert.equal(described.path, join(dir, 'MEMORY.md'))
})

test('registry：standalone 关闭时不生成适配器', async () => {
  const fakeFileMd = {
    createFileMdAdapter: (config) => ({
      id: config.id,
      label: config.label,
      describe: async () => ({ path: '', count: 0 }),
      list: async () => [],
      remove: async () => ({ removed: [], failed: [] }),
    }),
  }
  const { logger } = collectingLogger()
  const settings = { standalone: { enabled: false, path: '', format: 'md', delimiter: 'blank', mode: 'archive' } }
  const registry = createRegistry({
    settings,
    getSettings: () => settings,
    logger,
    loadAdapterModule: async (specifier) => {
      if (specifier === './file-md.mjs') return fakeFileMd
      throw new Error('not found')
    },
  })
  await registry.reload()
  assert.equal(registry.get('standalone'), undefined)
})

test('sweep：standalone 配成 delete 时，过期条目直接从文件里删掉', async () => {
  const fs = await import('node:fs/promises')
  const { createFileMdAdapter } = await import('../lib/adapters/file-md.mjs')
  const { sweep } = await import('../lib/sweep.mjs')
  const dir = await fs.mkdtemp(join(process.env.TEMP || '.', 'tide-sweep-'))
  const file = join(dir, 'MEMORY.md')
  await fs.writeFile(file, '一条很旧的记忆\n', 'utf8')
  const adapter = createFileMdAdapter({ id: 'standalone', path: file, format: { delimiter: 'blank' } })
  const entries = await adapter.list()
  assert.equal(entries.length, 1)
  const entry = entries[0]
  const old = Date.parse('2026-01-01T00:00:00Z')
  const state = {
    items: {
      [entry.key]: {
        adapterId: 'standalone',
        entryId: entry.entryId,
        firstSeenAt: old,
        lastSeenAt: old,
        lastRecalledAt: 0,
        resetAt: 0,
        touches: 0,
        pinned: false,
        state: 'active',
        archivedAt: 0,
        expiresAt: 0,
        date: null,
        textHash: '',
      },
    },
  }
  const settings = {
    ...DEFAULTS,
    curve: { ...DEFAULTS.curve },
    standalone: { enabled: true, path: file, format: 'md', delimiter: 'blank', mode: 'delete' },
  }
  const report = await sweep({
    registry: { adapters: async () => [adapter] },
    state,
    settings,
    logger: null,
    now: Date.parse('2026-11-26T00:00:00Z'),
  })
  assert.equal(report.adapters[0].deleted, 1, JSON.stringify(report))
  assert.equal(report.adapters[0].archived, 0)
  assert.equal(Object.keys(state.items).length, 0)
  assert.equal((await fs.readFile(file, 'utf8')).trim(), '')
})
