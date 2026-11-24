import test from 'node:test'
import assert from 'node:assert/strict'
import { normalize, grams, matchMention } from '../lib/match.mjs'

test('normalize: 小写、去标点与空白', () => {
  assert.equal(normalize(' Hello,  World! 2 '), 'helloworld2')
  assert.equal(normalize('中文，标点。'), '中文标点')
  assert.equal(normalize(''), '')
  assert.equal(normalize(null), '')
  assert.equal(normalize(undefined), '')
})

test('grams: 中文按字符 2-gram', () => {
  assert.deepEqual([...grams('我爱鲸鱼')].sort(), ['我爱', '爱鲸', '鲸鱼'])
})

test('grams: 英文按词 2-gram', () => {
  assert.deepEqual([...grams('use Dark Mode')].sort(), ['dark mode', 'use dark'])
})

test('grams: 中英混排各自成 gram', () => {
  const g = grams('用 Dark Mode 写代码')
  assert.deepEqual([...g].sort(), ['dark mode', '代码', '写代'])
})

test('grams: 单字中文不成 2-gram', () => {
  assert.equal(grams('鲸').size, 0)
  assert.equal(grams('鲸 鱼').size, 0)
})

test('matchMention: 中文共享 ≥2 个 2-gram 且 ≥4 字符才算命中', () => {
  const entries = [
    { key: 'a', text: '每周三晚上学习鲸鱼知识', tags: [] },
    { key: 'b', text: '深海鲸鱼', tags: [] },
    { key: 'c', text: '完全无关的条目', tags: ['插件'] },
  ]
  assert.deepEqual(matchMention('今晚学习鲸鱼知识吧', entries), ['a'])
  // 只共享一个 2-gram（"鲸鱼"，2 字符）→ 不算；tag 命中才算
  assert.deepEqual(matchMention('鲸鱼好可爱', entries), [])
  assert.deepEqual(matchMention('这个插件挺好', entries), ['c'])
})

test('matchMention: 空文本或不足 2 字符直接返回 []', () => {
  const entries = [{ key: 'a', text: '鲸鱼知识', tags: [] }]
  assert.deepEqual(matchMention('', entries), [])
  assert.deepEqual(matchMention('鲸', entries), [])
  assert.deepEqual(matchMention(null, entries), [])
  assert.deepEqual(matchMention('鲸 鱼', entries), [])
})

test('matchMention: 英文共享 2 个词 2-gram 才算命中', () => {
  const entries = [{ key: 'e', text: 'use dark mode for coding', tags: [] }]
  assert.deepEqual(matchMention('dark mode for coding please', entries), ['e'])
  assert.deepEqual(matchMention('dark mode rocks', entries), [])
  assert.deepEqual(matchMention('dark mode rocks', entries, { minSharedGrams: 1 }), ['e'])
})

test('matchMention: tags 原文（大小写不敏感）出现在消息里也命中', () => {
  const entries = [{ key: 't', text: '跟正文无关', tags: ['TypeScript', '插件'] }]
  assert.deepEqual(matchMention('typescript 太难了', entries), ['t'])
  assert.deepEqual(matchMention('这个插件不错', entries), ['t'])
  assert.deepEqual(matchMention('完全无关的一句话', entries), [])
})

test('matchMention: 同一 key 不重复返回，缺 key 的条目忽略', () => {
  const entries = [
    { key: 'x', text: '学习鲸鱼知识', tags: [] },
    { key: 'x', text: '学习鲸鱼知识', tags: [] },
    { text: '学习鲸鱼知识', tags: [] },
  ]
  assert.deepEqual(matchMention('学习鲸鱼知识', entries), ['x'])
})
