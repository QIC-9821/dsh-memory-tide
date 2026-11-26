// 重复记忆整合：同一来源、同一文件、同一轨里找近似条目，
// 保留最完整的一条，其余删除；正文按设置决定是否按最新日期改写。
// 全部是本地计算，不调用模型，因此不产生 token 成本。

import { dice, parseTrailDates, applyTrail, reconcileText, stripTrail } from './reconcile.mjs'

const DAY_MS = 86400000

function num(v, def = 0) {
  return typeof v === 'number' && Number.isFinite(v) ? v : def
}

function clamp(v, min, max, def) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def
}

function keywordsOf(settings) {
  const raw = settings?.mentions?.protectKeywords
  if (typeof raw !== 'string') return []
  return raw
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function isProtected(text, keywords) {
  if (!keywords.length) return false
  const t = String(text ?? '')
  return keywords.some((k) => t.includes(k))
}

function fileOf(entry) {
  return String(entry?.file || entry?.path || '')
}

function trackOf(entry) {
  return typeof entry?.track === 'string' ? entry.track : ''
}

function groupKeyOf(entry) {
  return `${entry?.adapterId ?? ''}\u0000${fileOf(entry)}\u0000${trackOf(entry)}`
}

function dateMsOf(entry) {
  if (typeof entry?.date === 'number' && Number.isFinite(entry.date)) return entry.date
  return 0
}

function dateTextOf(entry) {
  if (typeof entry?.dateText === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry.dateText)) return entry.dateText
  if (typeof entry?.date === 'number' && Number.isFinite(entry.date) && entry.date > 0) {
    const d = new Date(entry.date)
    const pad = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }
  return ''
}

// 在单组条目内做单链聚类：相似度 >= 阈值的连成一簇。
function clusterBySimilarity(entries, threshold) {
  const parent = entries.map((_, i) => i)
  const find = (i) => {
    let cur = i
    while (parent[cur] !== cur) {
      parent[cur] = parent[parent[cur]]
      cur = parent[cur]
    }
    return cur
  }
  const union = (a, b) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[rb] = ra
  }

  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      if (dice(entries[i].text, entries[j].text) >= threshold) union(i, j)
    }
  }

  const buckets = new Map()
  for (let i = 0; i < entries.length; i += 1) {
    const root = find(i)
    if (!buckets.has(root)) buckets.set(root, [])
    buckets.get(root).push(entries[i])
  }
  return [...buckets.values()]
}

export function mergeDefaults(settings) {
  const cfg = settings?.merge && typeof settings.merge === 'object' ? settings.merge : {}
  return {
    enabled: cfg.enabled === true,
    dryRun: cfg.dryRun === true,
    mode: cfg.mode === 'reconcile' ? 'reconcile' : 'keep-latest',
    threshold: clamp(cfg.threshold, 0.5, 1, 0.7),
    minChars: clamp(cfg.minChars, 4, 200, 10),
    segmentThreshold: clamp(cfg.segmentThreshold, 0.4, 1, 0.62),
    dateTrailCount: clamp(cfg.dateTrailCount, 0, 20, 3),
    maxMergedChars: clamp(cfg.maxMergedChars, 200, 20000, 4000),
  }
}

// 只读计划：不落盘，供预览。
export async function planMerges({ registry, settings, state } = {}) {
  const cfg = mergeDefaults(settings)
  const keywords = keywordsOf(settings)
  const warnings = []
  const groups = []

  let adapters = []
  try {
    adapters = (typeof registry?.adapters === 'function' ? await registry.adapters() : []) || []
  } catch (err) {
    warnings.push(`registry.adapters() 失败：${err?.message || err}`)
    return { groups, warnings, cfg }
  }

  for (const adapter of adapters) {
    if (!adapter || !adapter.id) continue
    const id = String(adapter.id)
    const builtin = settings?.adapters?.[id]
    if (builtin && builtin.enabled === false) continue
    const custom = (Array.isArray(settings?.customAdapters) ? settings.customAdapters : []).find((x) => x?.id === id)
    if (!builtin && custom && custom.enabled === false) continue

    let entries = []
    try {
      entries = adapter.list ? await adapter.list() : []
    } catch (err) {
      warnings.push(`适配器 ${id} list 失败：${err?.message || err}`)
      continue
    }
    if (!Array.isArray(entries)) continue

    const buckets = new Map()
    for (const raw of entries) {
      if (!raw || typeof raw.text !== 'string') continue
      const text = raw.text.trim()
      if (text.length < cfg.minChars) continue
      if (isProtected(text, keywords)) continue
      if (state?.items?.[raw.key]?.pinned === true) continue
      const key = groupKeyOf(raw)
      if (!buckets.has(key)) buckets.set(key, [])
      buckets.get(key).push(raw)
    }

    for (const bucket of buckets.values()) {
      if (bucket.length < 2) continue
      for (const cluster of clusterBySimilarity(bucket, cfg.threshold)) {
        if (cluster.length < 2) continue
        cluster.sort(
          (a, b) =>
            dateMsOf(b) - dateMsOf(a) ||
            String(b.text).length - String(a.text).length ||
            String(a.key).localeCompare(String(b.key)),
        )
        const keep = cluster[0]
        const drops = cluster.slice(1)
        const dropDates = drops.map(dateTextOf).filter(Boolean)
        const mergedText =
          cfg.mode === 'reconcile'
            ? reconcileText({
                baseText: keep.text,
                oldTexts: drops.map((d) => d.text),
                segmentThreshold: cfg.segmentThreshold,
                maxChars: cfg.maxMergedChars,
              }).text
            : stripTrail(keep.text)
        const finalText = applyTrail(mergedText, [...parseTrailDates(keep.text), ...dropDates], cfg.dateTrailCount)
        if (!finalText) continue
        const keptDates = []
        for (const d of [...parseTrailDates(finalText)]) if (!keptDates.includes(d)) keptDates.push(d)
        groups.push({
          adapterId: id,
          file: fileOf(keep),
          track: trackOf(keep),
          keepKey: String(keep.key),
          dropKeys: drops.map((d) => String(d.key)),
          baseText: String(keep.text).slice(0, 600),
          mergedText: finalText,
          keptDates,
          textChanged: stripTrail(keep.text) !== stripTrail(finalText),
          _keep: keep,
          _drops: drops,
        })
      }
    }
  }

  return { groups, warnings, cfg }
}

function publicGroup(group) {
  const { _keep, _drops, ...rest } = group
  return rest
}

// 真正执行：更新保留条目的正文，再删除其余重复条目。
export async function applyMerges({ registry, state, settings, logger, dryRun = true, now = Date.now() } = {}) {
  const at = Number.isFinite(now) ? now : Date.now()
  const plan = await planMerges({ registry, settings, state })
  const report = {
    at,
    dryRun: dryRun === true,
    mode: plan.cfg.mode,
    groups: plan.groups.map(publicGroup),
    applied: 0,
    mergedEntries: 0,
    removedEntries: 0,
    warnings: [...plan.warnings],
  }
  if (dryRun === true) return report

  for (const group of plan.groups) {
    const adapter = typeof registry?.get === 'function' ? registry.get(group.adapterId) : null
    if (!adapter) {
      report.warnings.push(`适配器 ${group.adapterId} 已不可用，跳过 ${group.keepKey}`)
      continue
    }

    let ok = false
    let addedCopy = false
    if (typeof adapter.update === 'function') {
      try {
        const res = await adapter.update(group._keep, group.mergedText)
        ok = res?.ok === true
        if (!ok) report.warnings.push(`更新 ${group.keepKey} 失败：${res?.error || '未知错误'}`)
      } catch (err) {
        report.warnings.push(`更新 ${group.keepKey} 抛错：${err?.message || err}`)
        ok = false
      }
    }

    // 适配器没有 update 能力时，退回 重新添加 + 删除原有条目（连保留条一起删，避免留下两份）。
    if (!ok && typeof adapter.add === 'function') {
      try {
        const res = await adapter.add({ ...group._keep, raw: undefined, text: group.mergedText })
        ok = res?.ok === true
        addedCopy = ok
        if (!ok) report.warnings.push(`无法改写 ${group.keepKey}（${adapter.id} 不支持 update）：${res?.error || '未知错误'}`)
      } catch (err) {
        report.warnings.push(`改写 ${group.keepKey} 抛错：${err?.message || err}`)
        ok = false
      }
    }
    if (!ok) continue

    report.applied += 1
    report.mergedEntries += 1

    const toRemove = addedCopy ? [group._keep, ...group._drops] : group._drops
    let res = null
    try {
      res = await adapter.remove(toRemove)
    } catch (err) {
      report.warnings.push(`删除重复条目失败（${group.adapterId}）：${err?.message || err}`)
      continue
    }
    const failed = Array.isArray(res?.failed) ? res.failed.length : 0
    const removed = Array.isArray(res?.removed) ? res.removed.length : 0
    report.removedEntries += removed
    if (failed) report.warnings.push(`${group.adapterId} 有 ${failed} 条重复项没删掉`)

    if (!state || typeof state !== 'object' || !state.items) continue
    for (const key of [group.keepKey, ...group.dropKeys]) delete state.items[key]
  }

  if (plan.groups.length && report.applied === 0 && report.warnings.length) {
    try {
      logger?.warn?.('[merge] 没有成功整合任何一组')
    } catch {
      // ignore logging errors
    }
  }
  return report
}

export { DAY_MS, num }
