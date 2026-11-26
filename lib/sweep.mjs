// 清扫：按遗忘曲线归档/删除，串行处理，dryRun 不落盘、不改 state。
import crypto from 'node:crypto'
import { isExpired, lastActivity } from './curve.mjs'
import { putArchive, readArchive, removeArchive } from './store.mjs'
import { makeTombstone } from './tombstone.mjs'
import { applyMerges } from './merge.mjs'

const DAY_MS = 86400000

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function errMsg(err) {
  return err?.message || String(err)
}

function safeLog(logger, level, msg) {
  try {
    logger?.[level]?.(msg)
  } catch {
    // 日志失败不影响清扫
  }
}

function hashText(text) {
  return crypto.createHash('sha1').update(String(text ?? '')).digest('hex').slice(0, 16)
}

function keywordList(settings) {
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

function findCustom(settings, id) {
  const list = Array.isArray(settings?.customAdapters) ? settings.customAdapters : []
  return list.find((x) => x && x.id === id)
}

function modeOf(settings, id) {
  // 独立记忆文件是一个虚拟内置源，它的配置在 settings.standalone 里而不是 adapters 里。
  if (id === 'standalone') {
    const standalone = settings?.standalone
    if (standalone && typeof standalone.mode === 'string') return standalone.mode === 'delete' ? 'delete' : 'archive'
    return 'archive'
  }
  const builtin = settings?.adapters?.[id]
  if (builtin && typeof builtin.mode === 'string') return builtin.mode === 'delete' ? 'delete' : 'archive'
  const custom = findCustom(settings, id)
  if (custom && custom.mode === 'delete') return 'delete'
  return 'archive'
}

function normalizeEntry(raw, adapterId) {
  const entryId = raw.entryId ?? raw.id ?? null
  const key =
    typeof raw.key === 'string' && raw.key
      ? raw.key
      : entryId !== null && entryId !== undefined
        ? `${adapterId}:${entryId}`
        : null
  return { ...raw, key, entryId }
}

function createItem(adapterId, entry, at) {
  return {
    adapterId,
    entryId: entry.entryId ?? null,
    firstSeenAt: at,
    lastSeenAt: at,
    lastRecalledAt: 0,
    resetAt: 0,
    touches: 0,
    pinned: false,
    state: 'active',
    archivedAt: 0,
    expiresAt: 0,
    date: entry.date ?? null,
    textHash: hashText(entry.text),
  }
}

async function removeOne(adapter, entry, dryRun, report) {
  if (dryRun) return true
  if (typeof adapter.remove !== 'function') {
    report.warnings.push(`适配器 ${adapter.id} 没有实现 remove`)
    return false
  }
  try {
    const res = await adapter.remove([entry])
    if (res && Array.isArray(res.removed) && res.removed.some((k) => k === entry.key || k === entry.entryId)) {
      return true
    }
    if (res && Array.isArray(res.failed) && res.failed.length) {
      const first = res.failed.find((f) => f && (f.key === entry.key || f.key === entry.entryId)) || res.failed[0]
      report.warnings.push(`remove ${entry.key} 失败：${first?.error || '未知错误'}`)
    } else if (!res || res.removed === undefined) {
      report.warnings.push(`remove ${entry.key} 返回格式异常`)
    } else {
      report.warnings.push(`remove ${entry.key} 未生效`)
    }
    return false
  } catch (err) {
    report.warnings.push(`remove ${entry.key} 抛错：${errMsg(err)}`)
    return false
  }
}

// 到期条目的统一处理（archive / delete）。
// 返回 "archived"（已归档、state item 保留）、"deleted"（已删除、state item 也应删除）或 "failed"。
async function handleExpired({ adapter, entry, item, mode, at, archiveDays, curve, dryRun, row, report }) {
  if (mode === 'delete') {
    const ok = await removeOne(adapter, entry, dryRun, report)
    if (ok) row.deleted += 1
    else row.failed += 1
    return ok ? 'deleted' : 'failed'
  }

  let archived = true
  if (!dryRun) {
    try {
      // 墓碑跟着归档条目一起落盘：本地算一行「为什么被收走」。
      const tombstone = makeTombstone({ at, actor: 'sweep', cause: 'decay', entry, item, curve })
      await putArchive({ ...entry, tombstone }, 'hot')
    } catch (err) {
      archived = false
      report.warnings.push(`写入 hot 归档失败 ${entry.key}：${errMsg(err)}`)
    }
  }
  if (!archived) {
    row.failed += 1
    return 'failed'
  }

  const ok = await removeOne(adapter, entry, dryRun, report)
  if (ok) {
    item.state = 'archived'
    item.archivedAt = at
    item.expiresAt = at + archiveDays * DAY_MS
    row.archived += 1
    return 'archived'
  }
  row.failed += 1
  // 没删成功就别留下重复的 hot 归档
  if (!dryRun) {
    try {
      await removeArchive(entry.key, 'hot')
    } catch {
      // 回滚失败也不影响主流程
    }
  }
  return 'failed'
}

export async function sweep({ registry, state, settings, logger, now = Date.now(), dryRun = false } = {}) {
  const at = typeof now === 'number' && Number.isFinite(now) ? now : Date.now()
  const isDry = dryRun === true
  const report = { at, dryRun: isDry, adapters: [], warnings: [] }

  if (!state || typeof state !== 'object') {
    report.warnings.push('sweep: state 缺失')
    return report
  }
  if (settings && settings.enabled === false) {
    safeLog(logger, 'info', '[sweep] 插件已禁用，跳过')
    return report
  }

  let adapters = []
  try {
    adapters = (typeof registry?.adapters === 'function' ? await registry.adapters() : []) || []
  } catch (err) {
    report.warnings.push(`registry.adapters() 失败：${errMsg(err)}`)
    return report
  }

  // dryRun 全程只在本地副本上操作，绝不写回 state.items。
  let items = state.items
  if (!items || typeof items !== 'object') {
    if (isDry) {
      items = {}
    } else {
      items = {}
      state.items = items
    }
  }

  // 先做重复整合，再按遗忘曲线清扫：整合是本地比较，不产生 token 成本。
  if (settings?.merge?.enabled === true) {
    try {
      const merged = await applyMerges({ registry, settings, state, logger, dryRun: isDry })
      report.merge = {
        groups: Array.isArray(merged.groups) ? merged.groups.length : 0,
        applied: merged.applied,
        mergedEntries: merged.mergedEntries,
        removedEntries: merged.removedEntries,
      }
      for (const warning of Array.isArray(merged.warnings) ? merged.warnings : []) {
        report.warnings.push(`merge: ${warning}`)
      }
    } catch (error) {
      report.warnings.push(`merge 失败：${errMsg(error)}`)
    }
  }

  const curve = settings?.curve || {}
  const archiveDays = (() => {
    const v = settings?.archive?.archiveDays
    return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : 30
  })()
  const onExpiry = settings?.archive?.onExpiry === 'delete' ? 'delete' : 'cold'
  const keywords = keywordList(settings)

  for (const adapter of adapters) {
    if (!adapter || typeof adapter !== 'object' || !adapter.id) continue
    const id = String(adapter.id)
    const builtin = settings?.adapters && typeof settings.adapters === 'object' ? settings.adapters[id] : undefined
    const custom = findCustom(settings, id)
    if (builtin && builtin.enabled === false) continue
    if (!builtin && custom && custom.enabled === false) continue

    const row = { id, checked: 0, expired: 0, archived: 0, cooled: 0, deleted: 0, failed: 0 }
    report.adapters.push(row)

    let entries
    try {
      entries = adapter.list ? await adapter.list() : []
      if (!Array.isArray(entries)) entries = []
    } catch (err) {
      row.failed += 1
      report.warnings.push(`适配器 ${id} list 失败：${errMsg(err)}`)
      safeLog(logger, 'warn', `[sweep] ${id} list 失败：${errMsg(err)}`)
      continue
    }

    const mode = modeOf(settings, id)
    const itemMap = new Map()
    const entriesByKey = new Map()
    const deletedKeys = new Set()

    for (const rawEntry of entries) {
      if (!rawEntry || typeof rawEntry !== 'object') continue
      const entry = normalizeEntry(rawEntry, id)
      if (!entry.key || entriesByKey.has(entry.key)) continue
      entriesByKey.set(entry.key, entry)
      row.checked += 1

      const prev = items[entry.key]
      const item = prev && typeof prev === 'object' ? { ...prev } : createItem(id, entry, at)
      item.adapterId = id
      item.entryId = entry.entryId ?? item.entryId ?? null
      item.lastSeenAt = at
      if (entry.date !== undefined && entry.date !== null) item.date = entry.date
      item.textHash = hashText(entry.text)
      if (item.state !== 'archived' && item.state !== 'cold') item.state = 'active'

      let removed = false

      if (item.pinned === true || item.state === 'cold' || isProtected(entry.text, keywords)) {
        // pinned / 冷归档 / 保护词：跳过，但保留 lastSeenAt 等更新
      } else if (item.state === 'archived') {
        const expiresAt = num(item.expiresAt)
        if (expiresAt > 0 && at >= expiresAt) {
          row.expired += 1
          if (onExpiry === 'cold') {
            let coldOk = true
            if (!isDry) {
              try {
                // 热归档里的墓碑要跟着抄到冷归档，否则转冷后卡片掉回「没记原因」。
                const hot = await readArchive(entry.key).catch(() => null)
                const cold = hot?.tombstone ? { ...entry, tombstone: hot.tombstone } : entry
                await putArchive(cold, 'cold')
              } catch (err) {
                coldOk = false
                row.failed += 1
                report.warnings.push(`写入 cold 归档失败 ${entry.key}：${errMsg(err)}`)
              }
              if (coldOk) {
                try {
                  await removeArchive(entry.key, 'hot')
                } catch (err) {
                  report.warnings.push(`清理 hot 归档失败 ${entry.key}：${errMsg(err)}`)
                }
              }
            }
            if (coldOk) {
              item.state = 'cold'
              row.cooled += 1
            }
          } else {
            if (!isDry) {
              try {
                await removeArchive(entry.key, 'hot')
              } catch (err) {
                report.warnings.push(`删除 hot 归档失败 ${entry.key}：${errMsg(err)}`)
              }
            }
            // 归档文件删了，adapter 里若还留着也再删一次
            const ok = await removeOne(adapter, entry, isDry, report)
            if (ok) {
              row.deleted += 1
              removed = true
            } else {
              row.failed += 1
            }
          }
        }
      } else if (isExpired(item, curve, at)) {
        row.expired += 1
        const status = await handleExpired({
          adapter,
          entry,
          item,
          mode,
          at,
          archiveDays,
          curve,
          dryRun: isDry,
          row,
          report,
        })
        if (status === 'deleted') removed = true
      }

      if (removed) {
        itemMap.delete(entry.key)
        deletedKeys.add(entry.key)
      } else {
        itemMap.set(entry.key, item)
      }
    }

    // 硬上限：按 touches 少、lastActivity 旧排序，超出部分同到期处理。
    const maxEntries = num(builtin?.maxEntries)
    if (maxEntries > 0) {
      const candidates = []
      for (const [key, item] of itemMap) {
        if (!item || item.state !== 'active' || item.pinned === true) continue
        const entry = entriesByKey.get(key)
        if (entry && isProtected(entry.text, keywords)) continue
        candidates.push({ key, item, entry })
      }
      if (candidates.length > maxEntries) {
        candidates.sort(
          (a, b) =>
            num(a.item.touches) - num(b.item.touches) ||
            lastActivity(a.item) - lastActivity(b.item) ||
            a.key.localeCompare(b.key),
        )
        const overflow = candidates.slice(0, candidates.length - maxEntries)
        for (const cand of overflow) {
          const entry = cand.entry || entriesByKey.get(cand.key)
          if (!entry) continue
          const status = await handleExpired({
            adapter,
            entry,
            item: cand.item,
            mode,
            at,
            archiveDays,
            dryRun: isDry,
            row,
            report,
          })
          if (status === 'deleted') {
            itemMap.delete(cand.key)
            deletedKeys.add(cand.key)
          }
        }
      }
    }

    if (!isDry) {
      for (const [key, item] of itemMap) items[key] = item
      for (const key of deletedKeys) delete items[key]
    }

    safeLog(
      logger,
      'info',
      `[sweep] ${isDry ? 'dry-run ' : ''}${id} checked=${row.checked} expired=${row.expired} archived=${row.archived} cooled=${row.cooled} deleted=${row.deleted} failed=${row.failed}`,
    )
  }

  return report
}
