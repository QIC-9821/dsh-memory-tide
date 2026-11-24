// 遗忘曲线：TTL 与到期判定。
const DAY_MS = 86400000

function positiveNumber(v, def) {
  return typeof v === 'number' && Number.isFinite(v) ? v : def
}

// base * growth^touches；开启上限时取 min(..., maxTtlDays)。
export function ttlDays(touches, curve) {
  const c = curve && typeof curve === 'object' ? curve : {}
  const base = positiveNumber(c.baseTtlDays, 7)
  const growth = positiveNumber(c.growth, 2)
  const t = typeof touches === 'number' && Number.isFinite(touches) && touches > 0 ? touches : 0
  let days = base * Math.pow(growth, t)
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
