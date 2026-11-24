// Tests for the memory-evolve adapter, built on the real on-disk layout:
// root MEMORY.md/USER.md, projects/<hash>/KEY.md and MEMORY.md, daily/<date>.md.
// Every fixture lives in a mkdtemp directory — the real ~/.dsh/memories is never
// read or written by these tests.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  createEvolveAdapter,
  entryIdFor,
  isCanonical,
  parseEntries,
  serializeEntries,
  trackOfFile,
} from '../lib/adapters/evolve.mjs'

const A = '75ed6e6d05ef'
const B = '3ba2ce091923'
const SHARED = '共享文本：同一句话出现在好几个文件里'

const ROOT_MEMORY = '[2026-11-07] 根记忆一\n§\n[2026-11-07] ' + SHARED + '\n'
const ROOT_USER = '[2026-11-04] 用户档案\n§\n[2026-11-04] ' + SHARED + '\n'
const A_MEMORY = '[2026-11-06] 项目A记忆\n§\n[2026-11-06] ' + SHARED + '\n'
const B_MEMORY = '[2026-11-06] 项目B记忆\n§\n[2026-11-06] ' + SHARED + '\n'
const B_KEY = '[2026-11-05] 项目B关键事实\n§\n[2026-11-05] ' + SHARED + '\n'
const DAILY_24 = '[14:32] [default-workspace] 当天的记忆\n§\n[15:00] 另一条当天记忆\n'

const TRACKED_FILES = [
  'MEMORY.md',
  'USER.md',
  `projects/${A}/MEMORY.md`,
  `projects/${B}/MEMORY.md`,
  `projects/${B}/KEY.md`,
  'daily/2026-11-24.md',
]

const INTERFERENCE = {
  'MEMORY-archive.md': '[2020-01-01] 归档记忆\n',
  'USER-archive.md': '[2020-01-01] 归档用户\n',
  [`projects/${A}/KEY-archive.md`]: '[2020-01-01] 归档关键事实\n',
  [`projects/${A}/MEMORY.md.bak-snapshot`]: '旧快照\n',
  [`projects/${A}/TODOS.md`]: '- [ ] 这不是记忆轨\n',
  'MEMORY.md.bak-snapshot': '旧快照\n',
  'pc-status.md': '# pc status\n',
  'daily/2026-11-24.md.bak-snapshot': '旧快照\n',
  'daily/notes.md': '不是按天的文件\n',
  'SUGGESTIONS.jsonl': '',
}

function allTracks() {
  return { memory: true, user: true, key: true, project: true, daily: true }
}

function defaultSettings(tracks = {}) {
  return {
    adapters: {
      evolve: {
        tracks: {
          memory: true,
          key: true,
          user: false,
          project: false,
          daily: false,
          ...tracks,
        },
      },
    },
  }
}

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'mtd-evolve-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

async function put(dir, rel, text) {
  const file = join(dir, rel)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, text, 'utf8')
  return file
}

async function seed(dir) {
  await mkdir(dir, { recursive: true })
  await put(dir, 'MEMORY.md', ROOT_MEMORY)
  await put(dir, 'USER.md', ROOT_USER)
  await put(dir, `projects/${A}/MEMORY.md`, A_MEMORY)
  await put(dir, `projects/${B}/MEMORY.md`, B_MEMORY)
  await put(dir, `projects/${B}/KEY.md`, B_KEY)
  await put(dir, 'daily/2026-11-24.md', DAILY_24)
  for (const [rel, text] of Object.entries(INTERFERENCE)) await put(dir, rel, text)
}

function backupStub() {
  const calls = []
  return {
    backupFile: async (file) => {
      calls.push(file)
      return `${file}.bak-test`
    },
    calls,
  }
}

async function snapshot(dir, rels) {
  const map = new Map()
  for (const rel of rels) map.set(rel, await readFile(join(dir, rel), 'utf8'))
  return map
}

test('evolve: canonical helpers and real-layout track detection', () => {
  assert.deepEqual(parseEntries(ROOT_MEMORY), ['[2026-11-07] 根记忆一', `[2026-11-07] ${SHARED}`])
  assert.equal(serializeEntries(parseEntries(ROOT_MEMORY)), ROOT_MEMORY)
  assert.equal(isCanonical(ROOT_MEMORY), true)
  assert.equal(isCanonical(''), true)
  assert.equal(isCanonical(ROOT_MEMORY.trimEnd()), false)

  const root = 'C:/memories'
  assert.equal(trackOfFile(root, 'C:/memories/MEMORY.md'), 'memory')
  assert.equal(trackOfFile(root, 'C:/memories/USER.md'), 'user')
  assert.equal(trackOfFile(root, `C:/memories/projects/${A}/KEY.md`), 'key')
  assert.equal(trackOfFile(root, `C:/memories/projects/${A}/MEMORY.md`), 'project')
  assert.equal(trackOfFile(root, 'C:/memories/daily/2026-11-24.md'), 'daily')
  assert.equal(trackOfFile(root, 'C:/memories/MEMORY-archive.md'), null)
  assert.equal(trackOfFile(root, 'C:/memories/daily/notes.md'), null)
  assert.equal(trackOfFile(root, `C:/memories/projects/${A}/TODOS.md`), null)
  assert.equal(trackOfFile(root, 'C:/somewhere/else/MEMORY.md'), null)

  const id = entryIdFor(root, `C:/memories/projects/${A}/KEY.md`, '[2026-11-05] 项目A关键事实')
  assert.match(id, new RegExp(`^projects/${A}/KEY\\.md#[0-9a-f]{8}$`))
})

test('evolve: list covers every real track, ignores archives and junk', async (t) => {
  const dir = await tempDir(t)
  await seed(dir)
  const adapter = createEvolveAdapter({ dir, settings: defaultSettings(allTracks()) })

  const entries = await adapter.list()
  assert.equal(entries.length, 12)
  const byTrack = (track) => entries.filter((entry) => entry.track === track)
  assert.equal(byTrack('memory').length, 2)
  assert.equal(byTrack('user').length, 2)
  assert.equal(byTrack('key').length, 2)
  assert.equal(byTrack('project').length, 4, 'two project files, two entries each')
  assert.equal(byTrack('daily').length, 2)

  for (const entry of entries) {
    assert.equal(entry.adapterId, 'evolve')
    assert.equal(entry.key, `evolve:${entry.entryId}`)
    assert.equal(entry.path, entry.file)
    assert.ok(entry.file.startsWith(dir))
    assert.ok(await stat(entry.file))
  }
  assert.ok(entries.every((entry) => /^[0-9a-f]{8}$/.test(entry.entryId.slice(-8))))

  const ids = new Set(entries.map((entry) => entry.entryId))
  assert.equal(ids.size, entries.length, 'every entry id is unique across files')
  const shared = entries.filter((entry) => entry.text === SHARED)
  assert.equal(shared.length, 5, 'the same text in five files stays five distinct entries')
  assert.equal(new Set(shared.map((entry) => entry.entryId)).size, 5)

  const rootShared = entries.find((entry) => entry.text === SHARED && entry.file === join(dir, 'MEMORY.md'))
  assert.ok(rootShared)
  assert.match(rootShared.entryId, /^MEMORY\.md#[0-9a-f]{8}$/)
  const keyShared = entries.find((entry) => entry.track === 'key' && entry.text === SHARED)
  assert.match(keyShared.entryId, new RegExp(`^projects/${B}/KEY\\.md#[0-9a-f]{8}$`))
  assert.match(keyShared.key, new RegExp(`^evolve:projects/${B}/KEY\\.md#[0-9a-f]{8}$`))

  const daily = byTrack('daily')
  for (const entry of daily) {
    assert.equal(entry.dateText, '2026-11-24', 'a daily entry takes its date from the file name')
    assert.equal(entry.date, new Date(2026, 10, 24).getTime())
    assert.match(entry.text, /^\[1[45]:\d{2}\]/)
    assert.match(entry.entryId, /^daily\/2026-11-24\.md#[0-9a-f]{8}$/)
  }
  assert.ok(daily.some((entry) => entry.text.includes('当天的记忆')))

  const files = new Set(entries.map((entry) => entry.file))
  assert.ok(!files.has(join(dir, 'MEMORY-archive.md')))
  assert.ok(!files.has(join(dir, 'USER-archive.md')))
  assert.ok(!files.has(join(dir, `projects/${A}/TODOS.md`)))
  assert.ok(!files.has(join(dir, 'daily/notes.md')))
  assert.ok(!files.has(join(dir, 'pc-status.md')))
  assert.ok(![...files].some((file) => file.includes('.bak')))

  const description = await adapter.describe()
  assert.equal(description.path, dir)
  assert.equal(description.count, 12)
})

test('evolve: remove rewrites only the target file, byte for byte', async (t) => {
  const dir = await tempDir(t)
  await seed(dir)
  const before = await snapshot(dir, TRACKED_FILES)
  const { backupFile, calls } = backupStub()
  const adapter = createEvolveAdapter({
    dir,
    settings: defaultSettings(allTracks()),
    backupFile,
  })
  const entries = await adapter.list()
  const target = entries.find(
    (entry) => entry.track === 'project' && entry.file === join(dir, `projects/${B}/MEMORY.md`) && entry.text === SHARED,
  )
  assert.ok(target)
  const result = await adapter.remove([target])
  assert.deepEqual(result.removed, [target.key])
  assert.deepEqual(result.failed, [])
  assert.deepEqual(calls, [join(dir, `projects/${B}/MEMORY.md`)])

  assert.equal(await readFile(join(dir, `projects/${B}/MEMORY.md`), 'utf8'), '[2026-11-06] 项目B记忆\n')
  for (const rel of TRACKED_FILES) {
    if (rel === `projects/${B}/MEMORY.md`) continue
    assert.equal(await readFile(join(dir, rel), 'utf8'), before.get(rel), `${rel} must stay byte-identical`)
  }
  assert.equal(await readFile(join(dir, 'MEMORY-archive.md'), 'utf8'), INTERFERENCE['MEMORY-archive.md'])

  const remaining = await adapter.list()
  assert.equal(remaining.length, 11)
  assert.ok(!remaining.some((entry) => entry.key === target.key))
})

test('evolve: a non-canonical file is reported as drift and never overwritten', async (t) => {
  const dir = await tempDir(t)
  await seed(dir)
  const drifted = '[2026-11-06] 项目A记忆\n§\n[2026-11-06] ' + SHARED
  const file = await put(dir, `projects/${A}/MEMORY.md`, drifted)
  const { backupFile } = backupStub()
  const adapter = createEvolveAdapter({
    dir,
    settings: defaultSettings(allTracks()),
    backupFile,
  })
  const entries = await adapter.list()
  const target = entries.find((entry) => entry.file === file && entry.text === SHARED)
  assert.ok(target)

  const result = await adapter.remove([target])
  assert.deepEqual(result.removed, [])
  assert.equal(result.failed.length, 1)
  assert.match(result.failed[0].error, /drift guard/)
  assert.equal(await readFile(file, 'utf8'), drifted)
  await assert.rejects(stat(join(dir, '.memory.lock')))
})

test('evolve: disabled tracks are never listed, removed or restored', async (t) => {
  const dir = await tempDir(t)
  await seed(dir)
  const adapter = createEvolveAdapter({ dir, settings: defaultSettings() })

  const entries = await adapter.list()
  assert.deepEqual(new Set(entries.map((entry) => entry.track)), new Set(['memory', 'key']))
  assert.equal(entries.length, 4)

  const userEntry = {
    key: 'evolve:USER.md#deadbeef',
    adapterId: 'evolve',
    entryId: 'USER.md#deadbeef',
    track: 'user',
    raw: ROOT_USER.split('\n§\n')[0],
    file: join(dir, 'USER.md'),
  }
  const removal = await adapter.remove([userEntry])
  assert.deepEqual(removal.removed, [])
  assert.match(removal.failed[0].error, /track "user" is disabled/)

  const userAdd = await adapter.add({ file: join(dir, 'USER.md'), text: '不该写进去' })
  assert.equal(userAdd.ok, false)
  assert.match(userAdd.error, /track "user" is disabled/)

  const projectAdd = await adapter.add({
    file: join(dir, `projects/C/MEMORY.md`),
    text: '项目轨默认关闭',
  })
  assert.equal(projectAdd.ok, false)
  assert.match(projectAdd.error, /track "project" is disabled/)
  await assert.rejects(stat(join(dir, 'projects/C')))

  assert.equal(await readFile(join(dir, 'USER.md'), 'utf8'), ROOT_USER)

  const noFile = await adapter.add({ track: 'memory', text: '没有目标文件' })
  assert.equal(noFile.ok, false)
  assert.match(noFile.error, /requires entry\.file/)

  const archive = await adapter.add({ file: join(dir, 'MEMORY-archive.md'), text: '归档不是记忆轨' })
  assert.equal(archive.ok, false)
  assert.match(archive.error, /not an evolve memory track file/)
  assert.equal(await readFile(join(dir, 'MEMORY-archive.md'), 'utf8'), INTERFERENCE['MEMORY-archive.md'])
})

test('evolve: add restores into entry.file, creating projects/daily paths when missing', async (t) => {
  const dir = await tempDir(t)
  await seed(dir)
  const { backupFile, calls } = backupStub()
  const adapter = createEvolveAdapter({
    dir,
    settings: defaultSettings(allTracks()),
    backupFile,
  })

  // Restore a deleted root entry verbatim.
  const rootEntries = (await adapter.list()).filter((entry) => entry.file === join(dir, 'MEMORY.md'))
  const first = rootEntries.find((entry) => entry.text === '根记忆一')
  await adapter.remove([first])
  const restored = await adapter.add({ file: first.file, raw: first.raw })
  assert.equal(restored.ok, true, restored.error)
  const afterRestore = await readFile(first.file, 'utf8')
  assert.equal(afterRestore, '[2026-11-07] ' + SHARED + '\n§\n[2026-11-07] 根记忆一\n')
  assert.ok((await adapter.list()).some((entry) => entry.entryId === first.entryId && entry.file === first.file))

  // A project file that does not exist yet: entry.file defines the hash directory.
  const newProject = await adapter.add({
    file: join(dir, `projects/C/MEMORY.md`),
    raw: '[2026-11-06] C项目的第一条记忆',
  })
  assert.equal(newProject.ok, true, newProject.error)
  assert.equal(await readFile(join(dir, 'projects/C/MEMORY.md'), 'utf8'), '[2026-11-06] C项目的第一条记忆\n')
  const projectEntry = (await adapter.list()).find((entry) => entry.text === 'C项目的第一条记忆')
  assert.ok(projectEntry)
  assert.equal(projectEntry.track, 'project')
  assert.match(projectEntry.entryId, /^projects\/C\/MEMORY\.md#[0-9a-f]{8}$/)

  // A daily file that does not exist yet.
  const newDay = await adapter.add({
    file: join(dir, 'daily/2026-11-25.md'),
    text: '新的一天',
    dateText: '2026-11-25',
  })
  assert.equal(newDay.ok, true, newDay.error)
  assert.equal(await readFile(join(dir, 'daily/2026-11-25.md'), 'utf8'), '[2026-11-25] 新的一天\n')
  const dayEntry = (await adapter.list()).find((entry) => entry.text === '新的一天')
  assert.ok(dayEntry)
  assert.equal(dayEntry.dateText, '2026-11-25')
  assert.equal(dayEntry.track, 'daily')

  // Restore into an existing project KEY file.
  const keyEntry = (await adapter.list()).find((entry) => entry.track === 'key')
  const keyFile = keyEntry.file
  await adapter.remove([keyEntry])
  const keyRestore = await adapter.add({ file: keyFile, raw: keyEntry.raw })
  assert.equal(keyRestore.ok, true, keyRestore.error)
  assert.ok((await adapter.list()).some((entry) => entry.entryId === keyEntry.entryId))

  // Every write went through the backup hook, and the target files stay canonical.
  assert.ok(calls.includes(join(dir, 'MEMORY.md')))
  assert.ok(calls.includes(join(dir, 'projects/C/MEMORY.md')))
  assert.ok(calls.includes(join(dir, 'daily/2026-11-25.md')))
  for (const rel of ['MEMORY.md', 'projects/C/MEMORY.md', 'daily/2026-11-25.md', `projects/${B}/KEY.md`]) {
    assert.equal(isCanonical(await readFile(join(dir, rel), 'utf8')), true, `${rel} stays canonical`)
  }
})

test('evolve: the memory lock waits, times out and takes over a stale lock', async (t) => {
  const dir = await tempDir(t)
  await seed(dir)
  const lockPath = join(dir, '.memory.lock')
  const { backupFile } = backupStub()
  await writeFile(lockPath, JSON.stringify({ pid: 999999, at: Date.now() }), 'utf8')

  const adapter = createEvolveAdapter({
    dir,
    settings: defaultSettings(),
    backupFile,
    lockTimeoutMs: 150,
    lockRetryMs: 10,
  })
  const entries = await adapter.list()
  const blocked = await adapter.remove([entries[0]])
  assert.deepEqual(blocked.removed, [])
  assert.match(blocked.failed[0].error, /timed out/)
  assert.equal(await readFile(join(dir, 'MEMORY.md'), 'utf8'), ROOT_MEMORY)

  const old = new Date(Date.now() - 30_000)
  await utimes(lockPath, old, old)
  const takeover = await adapter.remove([entries[0]])
  assert.deepEqual(takeover.failed, [])
  assert.deepEqual(takeover.removed, [entries[0].key])
  await assert.rejects(stat(lockPath))
  assert.equal(isCanonical(await readFile(join(dir, 'MEMORY.md'), 'utf8')), true)
})
