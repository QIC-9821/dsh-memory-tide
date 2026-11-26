// 文本整合：句段对齐 + 槽位替换 + 合并日期标记。
// 纯函数、无 IO、不调用模型 —— 整合本身是 0 token 的本地计算。
//
// 方向：base = 最新的一条（保留它的时间槽），oldTexts = 更旧的条目（保留它们的前置条件）。
// 例：旧「7点有一个计划」+ 新「把计划改到10点钟」→「10点有一个计划」。

import { grams } from './match.mjs'

const TRAIL_RE = /〔合并日期：([^〕]*)〕/g
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const SLOT_RE =
  /\d{4}-\d{2}-\d{2}|\d{1,2}[:：]\d{2}|\d+月\d+日|\d+号|周[一二三四五六日天]|\d+点半?|\d+(?:个|次|条|天|周|月|年|岁|人|分|秒|小时|公里|块|元)/g
const STOP = new Set(
  Array.from('的了是在把到和与就都也还又很再要会能可对从被让给为以将已并但而或这那有些个一不没我你他她它们着过之其呢吧啊嘛'),
)

export function stripTrail(text) {
  return String(text ?? '').replace(TRAIL_RE, '').trimEnd()
}

export function parseTrailDates(text) {
  const out = []
  const src = String(text ?? '')
  for (const m of src.matchAll(TRAIL_RE)) {
    for (const part of String(m[1] ?? '').split(/[、,，\s]+/)) {
      const d = part.trim()
      if (DATE_RE.test(d) && !out.includes(d)) out.push(d)
    }
  }
  return out
}

export function formatTrail(dates) {
  return dates.length ? `〔合并日期：${dates.join('、')}〕` : ''
}

// 把日期标记附在正文末尾；保留最近 count 个（0 = 不写标记）。
export function applyTrail(text, dates, count = 3) {
  const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 3
  const base = stripTrail(text)
  if (!n) return base
  const all = []
  for (const d of [...parseTrailDates(text), ...(Array.isArray(dates) ? dates : [])]) {
    if (typeof d !== 'string' || !DATE_RE.test(d) || all.includes(d)) continue
    all.push(d)
  }
  all.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
  const trail = formatTrail(all.slice(0, n))
  return trail ? `${base}\n${trail}` : base
}

// 保留分隔符的切分：偶数下标是正文段，奇数下标是分隔符。
export function splitSegments(text) {
  const parts = String(text ?? '').split(/(\n+|[。；！？!?;]+)/)
  const segs = []
  for (let i = 0; i < parts.length; i += 2) {
    const t = parts[i]
    if (t && t.trim()) segs.push({ index: i, text: t.trim() })
  }
  return { parts, segs }
}

export function slotValues(seg) {
  return [...String(seg ?? '').matchAll(SLOT_RE)].map((m) => m[0])
}

function diceSets(a, b) {
  if (!a || !b || !a.size || !b.size) return 0
  let inter = 0
  for (const g of a) if (b.has(g)) inter += 1
  return (2 * inter) / (a.size + b.size)
}

export function dice(aText, bText) {
  return diceSets(grams(aText, 2), grams(bText, 2))
}

function anchorSet(seg) {
  const cleaned = String(seg ?? '')
    .replace(SLOT_RE, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
  const out = new Set()
  for (const g of grams(cleaned, 2)) {
    const chars = Array.from(g.replace(/\s+/g, ''))
    if (!chars.length) continue
    if (chars.every((c) => STOP.has(c))) continue
    if (chars.every((c) => /\d/.test(c))) continue
    out.add(g)
  }
  return out
}

function sharedAnchors(a, b) {
  const A = anchorSet(a)
  const B = anchorSet(b)
  let count = 0
  for (const g of A) if (B.has(g)) count += 1
  return count
}

// 用 newerSlots 替换段里所有旧槽位；新旧数量一致时按顺序一一对应。
function replaceSlots(seg, newerSlots) {
  const olds = slotValues(seg)
  if (!olds.length || !newerSlots.length) return null
  let out = seg
  if (olds.length === newerSlots.length) {
    for (let i = olds.length - 1; i >= 0; i -= 1) {
      const idx = out.lastIndexOf(olds[i])
      if (idx < 0) return null
      out = out.slice(0, idx) + newerSlots[i] + out.slice(idx + olds[i].length)
    }
    return out
  }
  if (newerSlots.length === 1) {
    let cursor = 0
    for (const old of olds) {
      const idx = out.indexOf(old, cursor)
      if (idx < 0) continue
      out = out.slice(0, idx) + newerSlots[0] + out.slice(idx + old.length)
      cursor = idx + newerSlots[0].length
    }
    return out
  }
  return null
}

export function reconcileText({ baseText, oldTexts = [], segmentThreshold = 0.62, maxChars = 4000 } = {}) {
  const base = stripTrail(baseText)
  if (!base) return { text: '', replaced: 0, appended: 0 }

  const { parts } = splitSegments(base)
  const baseSegs = []
  const baseSlots = []
  for (let i = 0; i < parts.length; i += 2) {
    if (parts[i] && parts[i].trim()) {
      baseSegs.push({ index: i, text: parts[i].trim() })
      baseSlots.push(slotValues(parts[i]))
    }
  }

  const replaced = new Map()
  const extras = []

  for (const rawOld of Array.isArray(oldTexts) ? oldTexts : []) {
    const old = stripTrail(rawOld)
    if (!old) continue
    for (const seg of splitSegments(old).segs) {
      const text = seg.text
      if (!text || text.length < 2) continue
      if (baseSegs.some((b) => b.text === text)) continue

      const oldSlots = slotValues(text)
      let best = -1
      let bestScore = 0
      if (oldSlots.length) {
        for (let i = 0; i < baseSegs.length; i += 1) {
          const slots = baseSlots[i]
          if (!slots.length) continue
          if (oldSlots.join('|') === slots.join('|')) continue
          const shared = sharedAnchors(text, baseSegs[i].text)
          if (!shared) continue
          const score = shared * 2 + dice(text, baseSegs[i].text)
          if (score > bestScore) {
            bestScore = score
            best = i
          }
        }
      }

      if (best >= 0) {
        const candidate = replaceSlots(text, baseSlots[best])
        if (candidate && candidate !== baseSegs[best].text) {
          const prev = replaced.get(best)
          if (!prev || candidate.length >= prev.length) {
            // 候选句不比新句短太多才替换；否则把前置条件作为补充句留着。
            if (candidate.length + 2 >= baseSegs[best].text.length) replaced.set(best, candidate)
            else if (!extras.includes(candidate)) extras.push(candidate)
          }
          continue
        }
      }

      const dup =
        baseSegs.some((b) => dice(b.text, text) >= segmentThreshold) ||
        extras.some((e) => dice(e, text) >= segmentThreshold)
      if (!dup) extras.push(text)
    }
  }

  const outParts = parts.slice()
  for (const [segIndex, cand] of replaced) {
    const target = baseSegs.find((b) => b.index === segIndex)
    if (target) outParts[target.index] = cand
  }
  let merged = outParts.join('').trim()

  let appended = 0
  if (extras.length) {
    const sep = merged && !/[。；！？!?;]$/.test(merged) ? '；' : ''
    let next = `${merged}${sep}${extras.join('；')}`
    if (!/[。！？!?]$/.test(next)) next += '。'
    if (!merged || next.length <= maxChars) {
      merged = next
      appended = extras.length
    } else {
      for (const e of extras) {
        const sep2 = /[。；！？!?;]$/.test(merged) ? '' : '；'
        const candidate = `${merged}${sep2}${e}`
        if (candidate.length > maxChars) break
        merged = candidate
        appended += 1
      }
      if (!/[。！？!?]$/.test(merged)) merged += '。'
    }
  }

  return { text: merged, replaced: replaced.size, appended }
}
