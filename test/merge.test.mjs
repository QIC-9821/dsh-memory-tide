import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMerges } from '../lib/merge.mjs'
import { createFileMdAdapter } from '../lib/adapters/file-md.mjs'
import { createEvolveAdapter } from '../lib/adapters/evolve.mjs'

const silent = { info() {}, warn() {}, error() {} }

test('file-md：近似重复合成一条，删掉旧条并写入日期标记', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tide-merge-'))
  try {
    const file = join(dir, 'MEMORY.md')
    await writeFile(
      file,
      '[2026-11-20] 7点有一个计划要出门，记得带伞\n§\n[2026-11-26] 10点有一个计划要出门，记得带伞\n',
      'utf8',
    )

    const adapter = createFileMdAdapter({
      path: file,
      format: { delimiter: '\n§\n', dateRegex: '^\\[(\\d{4}-\\d{2}-\\d{2})\\]\\s*' },
    })
    const registry = { adapters: () => [adapter], get: (id) => (id === adapter.id ? adapter : null) }
    const settings = {
      adapters: {},
      customAdapters: [],
      mentions: { protectKeywords: '' },
      merge: { enabled: true, mode: 'reconcile', threshold: 0.6, minChars: 5, dateTrailCount: 3 },
    }
    const state = { items: {} }

    const preview = await applyMerges({ registry, settings, state, dryRun: true })
    assert.equal(preview.groups.length, 1)
    assert.equal(preview.applied, 0)
    assert.equal((await adapter.list()).length, 2)

    const real = await applyMerges({ registry, settings, state, dryRun: false })
    assert.equal(real.applied, 1)
    assert.equal(real.removedEntries, 1)

    const entries = await adapter.list()
    assert.equal(entries.length, 1)
    assert.ok(entries[0].text.includes('10点'), entries[0].text)
    assert.ok(!entries[0].text.includes('7点'), entries[0].text)
    assert.ok(entries[0].text.includes('〔合并日期：'), entries[0].text)

    const disk = await readFile(file, 'utf8')
    assert.ok(disk.includes('10点有一个计划要出门'), disk)
    assert.ok(!disk.includes('7点'), disk)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('evolve：update 保留原日期前缀', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tide-evolve-'))
  try {
    const file = join(dir, 'MEMORY.md')
    await writeFile(file, '[2026-11-20] 7点有一个计划要出门，记得带伞\n', 'utf8')
    const adapter = createEvolveAdapter({
      dir,
      logger: silent,
      settings: { adapters: { evolve: { tracks: { memory: true } } } },
    })
    const [entry] = await adapter.list()
    assert.ok(entry, 'expected one evolve entry')
    const res = await adapter.update(entry, '10点有一个计划要出门')
    assert.ok(res.ok, res.error)

    const disk = await readFile(file, 'utf8')
    assert.ok(disk.includes('[2026-11-20] 10点有一个计划要出门'), disk)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
