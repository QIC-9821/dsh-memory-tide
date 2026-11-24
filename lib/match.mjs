// 提及匹配：中文按字符 2-gram、英文按词 2-gram、tag 原文命中。
const CJK_RUN = /[\u{3400}-\u{4DBF}\u{4E00}-\u{9FFF}\u{F900}-\u{FAFF}]+/gu
const WORD_RUN = /[a-z0-9]+(?:['’-][a-z0-9]+)*/g

export function normalize(text) {
  if (text === null || text === undefined) return ''
  return String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

// 中文片段取字符 n-gram；拉丁/数字片段取词 n-gram。
export function grams(text, n = 2) {
  const size = typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : 2
  const src = text === null || text === undefined ? '' : String(text).toLowerCase()
  const out = new Set()

  for (const run of src.match(CJK_RUN) || []) {
    if (run.length < size) continue
    for (let i = 0; i + size <= run.length; i++) out.add(run.slice(i, i + size))
  }

  const words = src.match(WORD_RUN) || []
  if (words.length >= size) {
    for (let i = 0; i + size <= words.length; i++) out.add(words.slice(i, i + size).join(' '))
  }
  return out
}

// 返回命中条目的 key 列表。规则见 SPEC §6。
export function matchMention(userText, entries, { minSharedGrams = 2 } = {}) {
  if (typeof userText !== 'string') return []
  const userNorm = normalize(userText)
  if (Array.from(userNorm).length < 2) return []

  const limit = typeof minSharedGrams === 'number' && Number.isFinite(minSharedGrams)
    ? Math.max(1, Math.floor(minSharedGrams))
    : 2
  const userGrams = grams(userText, 2)
  const userLower = userText.toLowerCase()
  const list = Array.isArray(entries) ? entries : []
  const hits = []
  const seen = new Set()

  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const key =
      typeof entry.key === 'string' && entry.key
        ? entry.key
        : entry.adapterId && entry.entryId
          ? `${entry.adapterId}:${entry.entryId}`
          : null
    if (!key || seen.has(key)) continue

    let hit = false
    const textGrams = grams(entry.text, 2)
    let shared = 0
    let chars = 0
    for (const g of textGrams) {
      if (!userGrams.has(g)) continue
      shared += 1
      chars += g.replace(/\s+/g, '').length
    }
    if (shared >= limit && chars >= 4) hit = true

    if (!hit && Array.isArray(entry.tags)) {
      for (const tag of entry.tags) {
        if (typeof tag !== 'string') continue
        const t = tag.trim()
        if (t && userLower.includes(t.toLowerCase())) {
          hit = true
          break
        }
      }
    }

    if (hit) {
      seen.add(key)
      hits.push(key)
    }
  }
  return hits
}
