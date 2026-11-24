import test from 'node:test'
import assert from 'node:assert/strict'
import { ttlDays, lastActivity, isExpired, nextExpiry } from '../lib/curve.mjs'

const DAY = 86400000
const curve = { baseTtlDays: 7, growth: 2, maxTtlEnabled: true, maxTtlDays: 90 }

test('ttlDays: base * growth^touches', () => {
  assert.equal(ttlDays(0, curve), 7)
  assert.equal(ttlDays(1, curve), 14)
  assert.equal(ttlDays(2, curve), 28)
  assert.equal(ttlDays(3, curve), 56)
})

test('ttlDays: maxTtlEnabled 时封顶', () => {
  assert.equal(ttlDays(4, curve), 90)
  assert.equal(ttlDays(100, curve), 90)
})

test('ttlDays: 上限关闭后不封顶', () => {
  assert.equal(ttlDays(4, { ...curve, maxTtlEnabled: false }), 112)
  assert.equal(ttlDays(10, { ...curve, maxTtlEnabled: false }), 7168)
})

test('ttlDays: growth = 1 始终等于 base', () => {
  const c = { ...curve, growth: 1 }
  assert.equal(ttlDays(0, c), 7)
  assert.equal(ttlDays(5, c), 7)
  assert.equal(ttlDays(50, c), 7)
})

test('ttlDays: base = 0 时立即到期', () => {
  const c = { ...curve, baseTtlDays: 0 }
  assert.equal(ttlDays(0, c), 0)
  assert.equal(ttlDays(3, c), 0)
  assert.equal(ttlDays(3, { ...c, growth: 5 }), 0)
})

test('ttlDays: 非法 touches 视为 0', () => {
  assert.equal(ttlDays(-3, curve), 7)
  assert.equal(ttlDays(undefined, curve), 7)
  assert.equal(ttlDays('2', curve), 7)
  assert.equal(ttlDays(NaN, curve), 7)
})

test('lastActivity 取三者最大', () => {
  assert.equal(lastActivity({ resetAt: 30, lastRecalledAt: 10, firstSeenAt: 20 }), 30)
  assert.equal(lastActivity({ lastRecalledAt: 10, firstSeenAt: 20 }), 20)
  assert.equal(lastActivity({ firstSeenAt: 5 }), 5)
  assert.equal(lastActivity({}), 0)
  assert.equal(lastActivity(null), 0)
})

test('isExpired 在边界毫秒处生效', () => {
  const item = { firstSeenAt: 1000, touches: 0 }
  assert.equal(nextExpiry(item, curve), 1000 + 7 * DAY)
  assert.equal(isExpired(item, curve, 1000 + 7 * DAY - 1), false)
  assert.equal(isExpired(item, curve, 1000 + 7 * DAY), true)
})

test('isExpired 用最近活动时间：resetAt 会暂停倒计时', () => {
  const item = { firstSeenAt: 0, resetAt: 10 * DAY, touches: 1 }
  assert.equal(isExpired(item, curve, 20 * DAY), false)
  assert.equal(isExpired(item, curve, 24 * DAY), true)
  assert.equal(nextExpiry(item, curve), 24 * DAY)
})
