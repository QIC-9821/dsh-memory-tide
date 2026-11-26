// 遗忘曲线：TTL 与到期判定。
//
// 两种模型，都按「一次提醒/一次被提到 = touches + 1」计数：
//
//  - exponential（默认，艾宾浩斯）：每条记忆有强度 S，随时间按半衰期
//    baseTtlDays 指数衰减 S(t) = 2^(-t/baseTtlDays)；每被提到一次强度乘以
//    growth；当强度掉到 survivalFloor 以下（默认 0.1）才算忘。
//    等价 TTL = baseTtlDays × (touches × log2(growth) + log2(1/survivalFloor))。
//    于是遗忘是「逐渐变淡」：越久没提越接近阈值，而不是有一个整点一刀切。
//
//  - additive（旧版，常数叠加）：TTL = baseTtlDays × growth^touches，
//    每被提到一次直接按倍数延长。
//
// 两种模型都受 maxTtlDays 封顶（maxTtlEnabled 为 false 时无限期）。
const DAY_MS = 86400000

const DEFAULT_SURVIVAL_FLOOR = 0.1

function positiveNumber(v, def) {
  return typeof v === 'number' && Number.isFinite(v) ? v : def
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

export function ttlDays(touches, curve) {
  const c = curve && typeof curve === 'object' ? curve : {}
  const base = positiveNumber(c.baseTtlDays, 7)
  const growth = positiveNumber(c.growth, 2)
  const t = typeof touches === 'number' && Number.isFinite(touches) && touches > 0 ? touches : 0
  let days
  if (c.model === 'additive') {
    days = base * Math.pow(growth, t)
  } else {
    const floor = clamp(positiveNumber(c.survivalFloor, DEFAULT_SURVIVAL_FLOOR), 0.001, 0.9)
    const halfLives = Math.log2(1 / floor) + t * Math.log2(Math.max(1, growth))
    days = base * halfLives
  }
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
