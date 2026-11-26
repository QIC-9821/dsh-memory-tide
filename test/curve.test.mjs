import test from 'node:test'
import assert from 'node:assert/strict'
import { ttlDays, lastActivity, isExpired, nextExpiry } from '../lib/curve.mjs'

const DAY = 86400000
const additive = { model: 'additive', baseTtlDays: 7, growth: 2, maxTtlEnabled: true, maxTtlDays: 90 }
const exponential = { model: 'exponential', baseTtlDays: 7, growth: 2, survivalFloor: 0.1, maxTtlEnabled: false }

function close(actual, expected, eps = 1e-9) {
  assert.ok(Math.abs(actual - expected) < eps, `${actual} != ${expected}`)
}

test('additive: base * growth^touches', () => {
  assert.equal(ttlDays(0, additive), 7)
  assert.equal(ttlDays(1, additive), 14)
  assert.equal(ttlDays(2, additive), 28)
  assert.equal(ttlDays(3, additive), 56)
})

test('additive: maxTtlEnabled 时封顶', () => {
  assert.equal(ttlDays(4, additive), 90)
  assert.equal(ttlDays(100, additive), 90)
})

test('additive: 上限关闭后不封顶', () => {
  assert.equal(ttlDays(4, { ...additive, maxTtlEnabled: false }), 112)
  assert.equal(ttlDays(10, { ...additive, maxTtlEnabled: false }), 7168)
})

test('exponential: 默认强度 2^-t/base，掉到 survivalFloor 才算忘', () => {
  // log2(1/0.1) = 3.321928...
  close(ttlDays(0, exponential), 7 * Math.log2(10))
  // 每次提及强度 ×2，等于多撑一个半衰期
  close(ttlDays(1, exponential), 7 * (Math.log2(10) + 1))
  close(ttlDays(3, exponential), 7 * (Math.log2(10) + 3))
})

test('exponential: 不写 model 时默认就是指数衰减', () => {
  close(ttlDays(0, { baseTtlDays: 7, growth: 2 }), 7 * Math.log2(10))
})

test('exponential: growth = 1 时提及不延长', () => {
  const c = { ...exponential, growth: 1 }
  close(ttlDays(0, c), 7 * Math.log2(10))
  close(ttlDays(5, c), 7 * Math.log2(10))
})

test('exponential: survivalFloor 越大越早忘，且被限制在 0.001~0.9', () => {
  close(ttlDays(0, { ...exponential, survivalFloor: 0.5 }), 7 * 1)
  close(ttlDays(0, { ...exponential, survivalFloor: 0.9 }), 7 * Math.log2(1 / 0.9))
  // 超出范围时 clamp 到边界
  close(ttlDays(0, { ...exponential, survivalFloor: 0 }), 7 * Math.log2(1000))
})

test('exponential: maxTtlEnabled 时封顶', () => {
  assert.equal(ttlDays(100, { ...exponential, maxTtlEnabled: true, maxTtlDays: 30 }), 30)
})

test('additive: growth = 1 始终等于 base', () => {
  const c = { ...additive, growth: 1 }
  assert.equal(ttlDays(0, c), 7)
  assert.equal(ttlDays(5, c), 7)
  assert.equal(ttlDays(50, c), 7)
})

test('ttlDays: base = 0 时立即到期', () => {
  const c = { ...additive, baseTtlDays: 0 }
  assert.equal(ttlDays(0, c), 0)
  assert.equal(ttlDays(3, c), 0)
  assert.equal(ttlDays(3, { ...c, growth: 5 }), 0)
})

test('ttlDays: 非法 touches 视为 0', () => {
  assert.equal(ttlDays(-3, additive), 7)
  assert.equal(ttlDays(undefined, additive), 7)
  assert.equal(ttlDays('2', additive), 7)
  assert.equal(ttlDays(NaN, additive), 7)
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
  assert.equal(nextExpiry(item, additive), 1000 + 7 * DAY)
  assert.equal(isExpired(item, additive, 1000 + 7 * DAY - 1), false)
  assert.equal(isExpired(item, additive, 1000 + 7 * DAY), true)
})

test('isExpired 用最近活动时间：resetAt 会暂停倒计时', () => {
  const item = { firstSeenAt: 0, resetAt: 10 * DAY, touches: 1 }
  assert.equal(isExpired(item, additive, 20 * DAY), false)
  assert.equal(isExpired(item, additive, 24 * DAY), true)
  assert.equal(nextExpiry(item, additive), 24 * DAY)
})
