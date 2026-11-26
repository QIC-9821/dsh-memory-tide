import test from 'node:test'
import assert from 'node:assert/strict'

import { applyTrail, parseTrailDates, reconcileText, stripTrail } from '../lib/reconcile.mjs'

test('日期标记：写入、读取、条数上限', () => {
  const text = '正文\n〔合并日期：2026-11-26、2026-11-20、2026-11-01〕'
  assert.equal(stripTrail(text), '正文')
  assert.deepEqual(parseTrailDates(text), ['2026-11-26', '2026-11-20', '2026-11-01'])

  const out = applyTrail('正文', ['2026-11-20', '2026-11-26', '2026-11-01'], 2)
  assert.match(out, /〔合并日期：2026-11-26、2026-11-20〕/)
  assert.ok(!out.includes('2026-11-01'))
})

test('按最新日期改写时间槽，同时保留旧句的前置条件', () => {
  const base = '10点有一个计划要出门，记得带伞'
  const old = '7点有一个计划要出门，记得带伞'
  const { text } = reconcileText({ baseText: base, oldTexts: [old] })
  assert.ok(text.includes('10点'), text)
  assert.ok(!text.includes('7点'), text)
  assert.ok(text.includes('记得带伞'), text)
  assert.equal((text.match(/有一个计划/g) || []).length, 1)
})

test('完全相同的句子不重复堆叠', () => {
  const { text } = reconcileText({ baseText: '喜欢蓝色', oldTexts: ['喜欢蓝色'] })
  assert.equal(text, '喜欢蓝色')
})

test('不同主题的旧句作为补充保留', () => {
  const { text, appended } = reconcileText({ baseText: '周末去爬山', oldTexts: ['记得带水'] })
  assert.ok(text.includes('周末去爬山'), text)
  assert.ok(text.includes('记得带水'), text)
  assert.equal(appended, 1)
})

test('多句改写只作用于对应句段', () => {
  const base = '10点有一个计划要出门。记得带伞。'
  const old = '7点有一个计划要出门。记得带伞。'
  const { text } = reconcileText({ baseText: base, oldTexts: [old] })
  assert.ok(text.includes('10点有一个计划要出门'), text)
  assert.ok(!text.includes('7点'), text)
  assert.equal((text.match(/记得带伞/g) || []).length, 1)
})
