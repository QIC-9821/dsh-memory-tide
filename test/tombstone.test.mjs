// dsh-memory-tide — tombstone tests
// Path: test/tombstone.test.mjs
// Run: node --test test/tombstone.test.mjs

import test from 'node:test'
import assert from 'node:assert/strict'

import { previewOf, makeTombstone, resolveTombstone, sourceTombstone } from '../lib/tombstone.mjs'

const DAY = 86400000
const NOW = 1795000000000

test('previewOf 截到首句、折叠空白、跳过 summary 行', () => {
  assert.equal(previewOf('第一句很短。第二句不该出现'), '第一句很短')
  assert.equal(previewOf('第一行\n第二行'), '第一行')
  assert.equal(previewOf('- 列表开头 正文'), '列表开头 正文')
  assert.equal(previewOf('[summary:摘要行] 真正的正文在这里。后面'), '真正的正文在这里')
  assert.equal(previewOf('  多余   空白   收一收。  '), '多余 空白 收一收')
  assert.equal(previewOf('惊叹号也算句末！后面不要'), '惊叹号也算句末')
})

test('previewOf 超长截断加省略号，空值不抛错', () => {
  const long = previewOf('啊'.repeat(120))
  assert.equal(long.length, 60)
  assert.ok(long.endsWith('…'))
  assert.equal(previewOf(''), '')
  assert.equal(previewOf(undefined), '')
  assert.equal(previewOf(null), '')
  assert.equal(previewOf({ text: 'x' }), '')
  assert.equal(previewOf('   '), '')
})

test('makeTombstone 记下到期时间、寿命与提及次数', () => {
  const entry = { key: 'fish:a', text: '陈旧记忆。后面' }
  const item = { firstSeenAt: NOW - 100 * DAY, resetAt: 0, lastRecalledAt: NOW - 5 * DAY, touches: 2 }
  const curve = { model: 'exponential', baseTtlDays: 7, growth: 2, survivalFloor: 0.1, maxTtlEnabled: true, maxTtlDays: 90 }

  const tomb = makeTombstone({ at: NOW, actor: 'sweep', cause: 'decay', entry, item, curve })
  assert.equal(tomb.v, 1)
  assert.equal(tomb.at, NOW)
  assert.equal(tomb.actor, 'sweep')
  assert.equal(tomb.cause, 'decay')
  assert.equal(tomb.preview, '陈旧记忆')
  assert.equal(tomb.lastActiveAt, NOW - 5 * DAY)
  assert.equal(tomb.idleDays, 5)
  assert.equal(tomb.touches, 2)
  assert.equal(tomb.ttlDays, 37.3)
})

test('makeTombstone 没有 state item 时字段降级为 null', () => {
  const tomb = makeTombstone({ at: NOW, actor: 'manual', cause: 'manual', entry: { text: '手动归档的' }, curve: {} })
  assert.equal(tomb.actor, 'manual')
  assert.equal(tomb.cause, 'manual')
  assert.equal(tomb.preview, '手动归档的')
  assert.equal(tomb.lastActiveAt, null)
  assert.equal(tomb.idleDays, null)
  assert.equal(tomb.touches, null)
  assert.equal(tomb.ttlDays, null)
})

test('resolveTombstone 正常化已存墓碑', () => {
  const stored = { v: 1, at: NOW, actor: 'sweep', cause: 'decay', preview: '存下来的摘录', idleDays: 3, touches: 1, ttlDays: 21.5 }
  const tomb = resolveTombstone(stored, { text: '原正文。不该用' })
  assert.equal(tomb.cause, 'decay')
  assert.equal(tomb.preview, '存下来的摘录')
  assert.equal(tomb.idleDays, 3)
  assert.equal(tomb.ttlDays, 21.5)
  assert.equal(tomb.lastActiveAt, null)
})

test('resolveTombstone 旧归档与坏数据降级成 legacy', () => {
  const legacy = resolveTombstone(undefined, { text: '旧归档条目。后面' })
  assert.equal(legacy.cause, 'legacy')
  assert.equal(legacy.preview, '旧归档条目')
  assert.equal(legacy.at, null)

  assert.equal(resolveTombstone(null, { text: 'x' }).cause, 'legacy')
  assert.equal(resolveTombstone([], { text: 'x' }).cause, 'legacy')
  assert.equal(resolveTombstone('nope', { text: 'x' }).cause, 'legacy')

  const weird = resolveTombstone({ cause: '???', preview: 123 }, { text: '正文' })
  assert.equal(weird.cause, 'legacy')
  assert.equal(weird.preview, '正文')
})

test('sourceTombstone 只给摘录与日期，来源标成 source', () => {
  const tomb = sourceTombstone({ text: '源插件自己收走的条目。后面', date: Date.UTC(2026, 10, 20) })
  assert.equal(tomb.cause, 'source')
  assert.equal(tomb.actor, 'source')
  assert.equal(tomb.preview, '源插件自己收走的条目')
  assert.equal(tomb.at, Date.UTC(2026, 10, 20))
  assert.equal(tomb.idleDays, null)
  assert.equal(tomb.touches, null)
  assert.equal(tomb.ttlDays, null)

  const empty = sourceTombstone(null)
  assert.equal(empty.preview, '')
  assert.equal(empty.at, null)
})
