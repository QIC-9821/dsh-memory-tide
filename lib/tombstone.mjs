// 墓碑：归档条目上留一行「为什么被收走、讲的是什么」。
//
// 全部本地计算，不调用模型、不进上下文 —— 常驻 token 增量仍然是 0。
// 墓碑跟着归档 JSON 一起躺在 ~/.dsh/memory-tide/archive/<tier>/ 里，
// 适配器恢复时不认识这个字段，所以不会写回用户的记忆文件。
import { lastActivity, ttlDays } from './curve.mjs'

const DAY_MS = 86400000
const DEFAULT_PREVIEW_MAX = 60

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function round1(v) {
  return v === null ? null : Math.round(v * 10) / 10
}

// 首句摘录：折叠空白 → 去掉开头的 markdown 记号与 [summary:…] 摘要行 →
// 截到第一个句末 → 太长的截断加省略号。
export function previewOf(text, max = DEFAULT_PREVIEW_MAX) {
  if (typeof text !== 'string') return ''
  const limit = Number.isFinite(max) && max > 4 ? Math.trunc(max) : DEFAULT_PREVIEW_MAX
  let s = text.replace(/\r\n?/g, '\n').replace(/[ \t\f\v]+/g, ' ').trim()
  // 渐进式披露的摘要行（[summary:…] / [摘要:…]）不是正文，摘录时跳过。
  for (let i = 0; i < 3; i += 1) {
    const stripped = s.replace(/^\[(?:summary|摘要)\s*:[^\]]*\]\s*/i, '')
    if (stripped === s) break
    s = stripped.trim()
  }
  // 条目正文里偶尔带列表/标题记号，墓碑上不需要。
  s = s.replace(/^(?:[-*+>#]+\s+)+/, '')
  if (!s) return ''
  const cut = s.search(/[。！？；!?;\n]/)
  let head = (cut >= 0 ? s.slice(0, cut) : s).trim()
  if (!head) head = s.trim()
  if (head.length > limit) head = head.slice(0, limit - 1).trimEnd() + '…'
  return head
}

/**
 * Build the tombstone record that rides on an archived entry.
 *
 * @param {object} args
 * @param {number} args.at        archive timestamp (ms)
 * @param {'sweep'|'manual'} args.actor
 * @param {'decay'|'manual'} args.cause
 * @param {object} args.entry     adapter entry being archived
 * @param {object} [args.item]    state.json item for that key (may be missing)
 * @param {object} [args.curve]   effective curve settings
 * @returns {object}
 */
export function makeTombstone({ at, actor, cause, entry, item, curve } = {}) {
  const now = num(at) ?? Date.now()
  const lastActiveAt = item ? num(lastActivity(item)) || null : null
  const idleDays = lastActiveAt === null ? null : Math.max(0, Math.floor((now - lastActiveAt) / DAY_MS))
  return {
    v: 1,
    at: now,
    actor: actor === 'manual' ? 'manual' : 'sweep',
    cause: cause === 'manual' ? 'manual' : 'decay',
    preview: previewOf(entry?.text),
    lastActiveAt,
    idleDays,
    touches: num(item?.touches),
    ttlDays: item ? round1(num(ttlDays(item?.touches, curve))) : null,
  }
}

/**
 * Normalise a stored tombstone for the board. Entries archived before this
 * feature existed (or with a hand-damaged field) degrade to `legacy`.
 *
 * @param {object|undefined|null} stored
 * @param {object} entry adapter/archive entry
 */
export function resolveTombstone(stored, entry) {
  const fallbackPreview = previewOf(entry?.text)
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    return legacyTombstone(fallbackPreview)
  }
  const cause = stored.cause === 'decay' || stored.cause === 'manual' || stored.cause === 'legacy'
    ? stored.cause
    : 'legacy'
  return {
    v: num(stored.v) ?? 0,
    at: num(stored.at),
    actor: stored.actor === 'manual' || stored.actor === 'sweep' ? stored.actor : null,
    cause,
    preview: typeof stored.preview === 'string' ? stored.preview : fallbackPreview,
    lastActiveAt: num(stored.lastActiveAt),
    idleDays: num(stored.idleDays),
    touches: num(stored.touches),
    ttlDays: num(stored.ttlDays),
  }
}

/**
 * 源插件自己收走的归档（memory-evolve 的 `*-archive.md` 等）：潮汐不知道原因，
 * 但仍给出「讲的是哪句」，翻归档时不用点开猜。
 *
 * @param {object} entry adapter entry from the source plugin's own archive
 */
export function sourceTombstone(entry) {
  return {
    v: 0,
    at: num(entry?.date),
    actor: 'source',
    cause: 'source',
    preview: previewOf(entry?.text),
    lastActiveAt: null,
    idleDays: null,
    touches: null,
    ttlDays: null,
  }
}

function legacyTombstone(preview) {
  return {
    v: 0,
    at: null,
    actor: null,
    cause: 'legacy',
    preview: preview || '',
    lastActiveAt: null,
    idleDays: null,
    touches: null,
    ttlDays: null,
  }
}
