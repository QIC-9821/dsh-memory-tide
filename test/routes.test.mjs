// dsh-memory-tide — routes tests
// Path: test/routes.test.mjs
// Run: node --test test/routes.test.mjs
//
// Drives the prefix handler through a fake cordis ctx; no HTTP server, no
// real store, no real adapter.

import test from 'node:test'
import assert from 'node:assert/strict'

import { registerRoutes } from '../lib/routes.mjs'

function makeEntry(adapterId, id, { text = '', date = null, tags = [] } = {}) {
  return {
    key: `${adapterId}:${id}`,
    adapterId,
    entryId: id,
    date,
    dateText: date === null ? '' : new Date(date).toISOString().slice(0, 10),
    text,
    tags,
    track: null,
    raw: text,
  }
}

function makeReq(method, url, body) {
  const chunks =
    body === undefined
      ? []
      : [Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')]
  return {
    method,
    url,
    headers: {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    ended: false,
    writeHead(status, headers) {
      this.statusCode = status
      Object.assign(this.headers, headers || {})
    },
    end(chunk) {
      this.ended = true
      if (chunk !== undefined && chunk !== null) {
        this.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      }
    },
  }
}

async function call(handler, method, url, body) {
  const request = makeReq(method, url, body)
  const response = makeRes()
  await handler(request, response)
  let json = null
  if (response.body) json = JSON.parse(response.body)
  return { status: response.statusCode, headers: response.headers, json, raw: response.body }
}

function mount(deps) {
  const registered = []
  const injected = []
  const ctx = {
    inject(services, callback) {
      injected.push(services)
      callback({
        effect(body) {
          return body()
        },
        webServer: {
          register(options) {
            registered.push(options)
            return () => {}
          },
        },
      })
    },
  }

  registerRoutes(ctx, deps)

  assert.deepEqual(injected, [['webServer']])
  assert.equal(registered.length, 1)
  assert.equal(registered[0].kind, 'prefix')
  assert.equal(registered[0].path, '/memory-tide')
  assert.equal(typeof registered[0].handler, 'function')
  return registered[0].handler
}

function makeDeps() {
  const calls = { sweep: [], scans: 0, saved: [], applied: [], listEntries: [], act: [], logLines: null }
  const entries = [
    makeEntry('fish', 'a', { text: 'A', tags: ['alpha'] }),
    makeEntry('fish', 'b', { text: 'B' }),
  ]
  const fish = {
    id: 'fish',
    label: 'Fish Memory',
    async describe() {
      return { path: 'C:\\libs\\fish.json', count: entries.length }
    },
    async list() {
      return entries
    },
  }
  const registry = { adapters: () => [fish], get: (id) => (id === 'fish' ? fish : undefined) }
  const state = {
    version: 1,
    items: {
      'fish:x': { state: 'archived' },
      'fish:y': { state: 'cold' },
      'fish:z': { state: 'active' },
    },
    lastSweepAt: 1234,
    firstSweepDone: true,
  }
  const settings = {
    enabled: true,
    board: { pageSize: 100 },
    adapters: { fish: { enabled: true } },
    discovery: { enabled: true, deny: ['C:\\old'] },
    customAdapters: [],
  }
  const board = {
    async listEntries(args) {
      calls.listEntries.push(args)
      return { total: 2, page: args.query.page, pageSize: args.query.pageSize, rows: [] }
    },
    async act(args) {
      calls.act.push(args)
      return { results: args.keys.map((key) => ({ key, ok: true })) }
    },
  }
  const deps = {
    settings,
    registry,
    state,
    board,
    logger: { info() {}, warn() {}, error() {} },
    stateRepo: {
      async readLog(lines) {
        calls.logLines = lines
        return ['line1', 'line2']
      },
    },
    saveSettings: async (patch) => {
      calls.saved.push(patch)
      return { settings: { ...settings, ...patch }, warnings: ['w'] }
    },
    scan: async () => {
      calls.scans += 1
      return {
        found: [{ path: 'C:\\memory\\notes.md', kind: 'file-md', confidence: 0.9, count: 12 }],
        skipped: [{ path: 'C:\\x.txt', reason: 'not a memory store' }],
      }
    },
    sweep: async (options) => {
      calls.sweep.push(options)
      return { at: 99, dryRun: options?.dryRun === true, adapters: [], warnings: [] }
    },
    getFirstRunReport: () => ({ dryRun: true, adapters: [] }),
    onSettingsApplied: async (next) => {
      calls.applied.push(next)
    },
  }
  return { deps, calls, entries }
}

test('mounts on /memory-tide through ctx.inject([webServer])', () => {
  const { deps } = makeDeps()
  const handler = mount(deps)
  assert.equal(typeof handler, 'function')
})

test('GET /api/state reports settings, stats and adapters', async () => {
  const { deps } = makeDeps()
  const handler = mount(deps)
  const res = await call(handler, 'GET', '/memory-tide/api/state')

  assert.equal(res.status, 200)
  assert.equal(res.json.ok, true)
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
  const data = res.json.data
  assert.deepEqual(data.stats, { active: 2, archived: 1, cold: 1 })
  assert.deepEqual(data.adapters, [
    { id: 'fish', label: 'Fish Memory', path: 'C:\\libs\\fish.json', count: 2, enabled: true },
  ])
  assert.equal(data.lastSweepAt, 1234)
  assert.equal(data.firstSweepDone, true)
  assert.deepEqual(data.firstRunReport, { dryRun: true, adapters: [] })
  assert.equal(data.settings.enabled, true)
})

test('POST /api/settings saves a patch and reports warnings', async () => {
  const { deps, calls } = makeDeps()
  const handler = mount(deps)
  const res = await call(handler, 'POST', '/memory-tide/api/settings', {
    patch: { enabled: false, curve: { baseTtlDays: 3 } },
  })

  assert.equal(res.status, 200)
  assert.equal(res.json.data.settings.enabled, false)
  assert.deepEqual(res.json.data.warnings, ['w'])
  assert.deepEqual(calls.saved[0], { enabled: false, curve: { baseTtlDays: 3 } })
  assert.equal(calls.applied.length, 1)
  assert.equal(calls.applied[0].enabled, false)
})

test('POST /api/settings rejects a missing patch', async () => {
  const { deps } = makeDeps()
  const handler = mount(deps)
  const res = await call(handler, 'POST', '/memory-tide/api/settings', {})
  assert.equal(res.status, 400)
  assert.equal(res.json.ok, false)
  assert.match(res.json.error, /patch/)
})

test('GET /api/entries forwards filters and paging to the board', async () => {
  const { deps, calls } = makeDeps()
  const handler = mount(deps)
  const res = await call(
    handler,
    'GET',
    '/memory-tide/api/entries?state=archived&adapter=fish&q=alpha&page=2&pageSize=50',
  )

  assert.equal(res.status, 200)
  assert.deepEqual(res.json.data, { total: 2, page: 2, pageSize: 50, rows: [] })
  const args = calls.listEntries[0]
  assert.equal(args.settings.enabled, true)
  assert.deepEqual(args.query, { state: 'archived', adapter: 'fish', q: 'alpha', page: 2, pageSize: 50 })
})

test('GET /api/entries applies defaults and clamps pageSize', async () => {
  const { deps, calls } = makeDeps()
  const handler = mount(deps)
  await call(handler, 'GET', '/memory-tide/api/entries')
  assert.deepEqual(calls.listEntries[0].query, { state: 'all', adapter: '', q: '', page: 1, pageSize: 100 })

  await call(handler, 'GET', '/memory-tide/api/entries?pageSize=9999&page=0')
  assert.equal(calls.listEntries[1].query.pageSize, 500)
  assert.equal(calls.listEntries[1].query.page, 1)
})

test('POST /api/action validates op/keys and returns per-key results', async () => {
  const { deps, calls } = makeDeps()
  const handler = mount(deps)

  const ok = await call(handler, 'POST', '/memory-tide/api/action', { op: 'pin', keys: ['fish:a', 'fish:b'] })
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.json.data.results, [
    { key: 'fish:a', ok: true },
    { key: 'fish:b', ok: true },
  ])
  assert.equal(calls.act[0].op, 'pin')

  const badOp = await call(handler, 'POST', '/memory-tide/api/action', { op: 'nuke', keys: ['fish:a'] })
  assert.equal(badOp.status, 400)
  assert.match(badOp.json.error, /op must be one of/)

  const badKeys = await call(handler, 'POST', '/memory-tide/api/action', { op: 'pin', keys: 'fish:a' })
  assert.equal(badKeys.status, 400)
  assert.match(badKeys.json.error, /keys/)
})

test('POST /api/sweep runs a dry run when asked', async () => {
  const { deps, calls } = makeDeps()
  const handler = mount(deps)

  const dry = await call(handler, 'POST', '/memory-tide/api/sweep', { dryRun: true })
  assert.equal(dry.status, 200)
  assert.equal(dry.json.data.report.dryRun, true)
  assert.deepEqual(calls.sweep, [{ dryRun: true }])

  const wet = await call(handler, 'POST', '/memory-tide/api/sweep', {})
  assert.equal(wet.json.data.report.dryRun, false)
  assert.deepEqual(calls.sweep[1], { dryRun: false })
})

test('POST /api/scan returns found and skipped lists', async () => {
  const { deps, calls } = makeDeps()
  const handler = mount(deps)
  const res = await call(handler, 'POST', '/memory-tide/api/scan')

  assert.equal(res.status, 200)
  assert.equal(calls.scans, 1)
  assert.equal(res.json.data.found.length, 1)
  assert.equal(res.json.data.found[0].path, 'C:\\memory\\notes.md')
  assert.equal(res.json.data.skipped.length, 1)
})

test('POST /api/adopt appends deny paths without duplicates', async () => {
  const { deps, calls } = makeDeps()
  const handler = mount(deps)
  const res = await call(handler, 'POST', '/memory-tide/api/adopt', { deny: ['C:\\old', 'C:\\new ', ''] })

  assert.equal(res.status, 200)
  assert.equal(calls.saved.length, 1)
  assert.deepEqual(calls.saved[0].discovery.deny, ['C:\\old', 'C:\\new'])
  assert.equal(res.json.data.settings.discovery.deny.length, 2)
})

test('POST /api/adopt registers a custom adapter', async () => {
  const { deps, calls } = makeDeps()
  const handler = mount(deps)
  const res = await call(handler, 'POST', '/memory-tide/api/adopt', {
    adapter: { path: 'C:\\mem\\notes.md', type: 'file-md', label: 'My notes' },
  })

  assert.equal(res.status, 200)
  const added = calls.saved[0].customAdapters
  assert.equal(added.length, 1)
  assert.match(added[0].id, /^custom:/)
  assert.equal(added[0].type, 'file-md')
  assert.equal(added[0].path, 'C:\\mem\\notes.md')
  assert.equal(added[0].label, 'My notes')
  assert.equal(added[0].mode, 'archive')

  const invalid = await call(handler, 'POST', '/memory-tide/api/adopt', {
    adapter: { path: 'C:\\mem\\x.txt', type: 'txt' },
  })
  assert.equal(invalid.status, 400)
})

test('GET /api/log clamps the line count', async () => {
  const { deps, calls } = makeDeps()
  const handler = mount(deps)
  const res = await call(handler, 'GET', '/memory-tide/api/log?lines=7')
  assert.equal(res.status, 200)
  assert.deepEqual(res.json.data.lines, ['line1', 'line2'])
  assert.equal(calls.logLines, 7)

  await call(handler, 'GET', '/memory-tide/api/log?lines=-3')
  assert.equal(calls.logLines, 1)
})

test('unknown paths 404, wrong methods 405, bad bodies 400/413', async () => {
  const { deps } = makeDeps()
  const handler = mount(deps)

  const unknown = await call(handler, 'GET', '/memory-tide/api/nope')
  assert.equal(unknown.status, 404)
  assert.equal(unknown.json.ok, false)

  const outside = await call(handler, 'GET', '/other/api/state')
  assert.equal(outside.status, 404)

  const otherVerb = await call(handler, 'DELETE', '/memory-tide/api/state')
  assert.equal(otherVerb.status, 405)
  assert.equal(otherVerb.headers.allow, 'GET, POST')

  const wrongVerb = await call(handler, 'GET', '/memory-tide/api/settings')
  assert.equal(wrongVerb.status, 405)
  assert.equal(wrongVerb.headers.allow, 'POST')

  const badJson = await call(handler, 'POST', '/memory-tide/api/settings', '{oops')
  assert.equal(badJson.status, 400)
  assert.match(badJson.json.error, /invalid JSON/)

  const oversize = await call(handler, 'POST', '/memory-tide/api/settings', {
    patch: { note: 'x'.repeat(1024 * 1024 + 32) },
  })
  assert.equal(oversize.status, 413)
  assert.match(oversize.json.error, /exceeds/)

  const trailing = await call(handler, 'GET', '/memory-tide/api/state/')
  assert.equal(trailing.status, 200)
})
