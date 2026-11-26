// 遗忘曲线：TTL 与到期判定。
//
// 三种模型，都按「一次提醒/一次被提到 = touches + 1」计数：
//
//  - exponential（默认，艾宾浩斯遗忘曲线/指数衰减）：每条记忆有强度 S，随时间按半衰期
//    baseTtlDays 指数衰减 S(t) = 2^(-t/baseTtlDays)；每被提到一次强度乘以
//    growth；当强度掉到 survivalFloor 以下（默认 0.1）才算忘。
//    等价 TTL = baseTtlDays × (touches × log2(growth) + log2(1/survivalFloor))。
//    于是遗忘是「逐渐变淡」：越久没提越接近阈值，而不是有一个整点一刀切。
//
//  - additive（常数叠加）：TTL = baseTtlDays × growth^touches，
//    每被提到一次直接按倍数延长。
//
//  - custom（自定义函数）：由 curve.customExpr 表达式决定，可用变量
//    touches / base / growth / floor，返回天数；还能直接用数学短名
//    log/ln/exp/sqrt/pow/abs/min/max/log10/log2/ceil/round 与常量 e/PI（见 mathAliases）。
//    表达式编译失败或算不出正数时回退到 exponential，绝不让清扫因一个表达式停下。
//
// 三种模型都受 maxTtlDays 封顶（maxTtlEnabled 为 false 时无限期）。
const DAY_MS = 86400000

const DEFAULT_SURVIVAL_FLOOR = 0.1

function positiveNumber(v, def) {
  return typeof v === 'number' && Number.isFinite(v) ? v : def
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

function curveNumbers(curve) {
  const c = curve && typeof curve === 'object' ? curve : {}
  return {
    base: positiveNumber(c.baseTtlDays, 7),
    growth: positiveNumber(c.growth, 2),
    floor: clamp(positiveNumber(c.survivalFloor, DEFAULT_SURVIVAL_FLOOR), 0.001, 0.9),
  }
}

function exponentialDays(t, base, growth, floor) {
  const halfLives = Math.log2(1 / floor) + t * Math.log2(Math.max(1, growth))
  return base * halfLives
}

function additiveDays(t, base, growth) {
  return base * Math.pow(growth, t)
}

// 编译并缓存自定义表达式。返回 (touches, base, growth, floor) => days。
const exprCache = new Map()

// 表达式里可以直接用的数学短名，省得写成 Math.log(...)。
// log 与 ln 都是自然对数；floor 是注入变量（生存阈值），所以不提供同名函数。
const mathAliases = Object.freeze({
  log: Math.log,
  ln: Math.log,
  exp: Math.exp,
  sqrt: Math.sqrt,
  pow: Math.pow,
  abs: Math.abs,
  min: Math.min,
  max: Math.max,
  log10: Math.log10,
  log2: Math.log2,
  ceil: Math.ceil,
  round: Math.round,
  e: Math.E,
  PI: Math.PI,
  pi: Math.PI,
})

export function compileCustomExpr(expr) {
  const src = String(expr == null ? '' : expr).trim()
  if (!src) throw new Error('自定义函数表达式为空')
  const cached = exprCache.get(src)
  if (cached) return cached
  // 表达式在本机插件进程内执行，内容由使用者自己填写；不读取外部文件。
  // eslint-disable-next-line no-new-func
  const raw = new Function(
    'touches',
    'base',
    'growth',
    'floor',
    '__math',
    `"use strict";
    const { log, ln, exp, sqrt, pow, abs, min, max, log10, log2, ceil, round, e, PI, pi } = __math;
    return (${src});`,
  )
  const fn = (touches, base, growth, floor) => {
    const value = raw(touches, base, growth, floor, mathAliases)
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error('表达式没有返回非负有限天数')
    }
    return value
  }
  exprCache.set(src, fn)
  return fn
}

export function isValidCustomExpr(expr) {
  let fn
  try {
    fn = compileCustomExpr(expr)
  } catch {
    return false
  }
  try {
    for (const touches of [0, 1, 5]) {
      const days = fn(touches, 7, 2, DEFAULT_SURVIVAL_FLOOR)
      if (!(days >= 0) || !Number.isFinite(days)) return false
    }
    return true
  } catch {
    return false
  }
}

export function ttlDays(touches, curve) {
  const c = curve && typeof curve === 'object' ? curve : {}
  const { base, growth, floor } = curveNumbers(c)
  const t = typeof touches === 'number' && Number.isFinite(touches) && touches > 0 ? touches : 0
  let days
  if (c.model === 'additive') {
    days = additiveDays(t, base, growth)
  } else if (c.model === 'custom') {
    try {
      days = compileCustomExpr(c.customExpr)(t, base, growth, floor)
    } catch {
      days = exponentialDays(t, base, growth, floor)
    }
  } else {
    days = exponentialDays(t, base, growth, floor)
  }
  // 自定义函数也可能因上游数字极端而溢出：统一兜底成「立即到期」。
  if (!Number.isFinite(days) || days < 0) days = 0
  if (c.maxTtlEnabled !== false) days = Math.min(days, positiveNumber(c.maxTtlDays, 90))
  return days
}

// 最近一次活动：重置时间、被动召回、首次见到，三者取最大。
export function lastActivity(item) {
  if (!item || typeof item !== 'object') return 0
  const a = positiveNumber(item.resetAt, 0)
  const b = positiveNumber(item.lastRecalledAt, 0)
  const c = positiveNumber(item.firstSeenAt, 0)
  return Math.max(a, b, c)
}

export function nextExpiry(item, curve) {
  return lastActivity(item) + ttlDays(item?.touches, curve) * DAY_MS
}

export function isExpired(item, curve, now) {
  const at = typeof now === 'number' && Number.isFinite(now) ? now : Date.now()
  return at >= nextExpiry(item, curve)
}
