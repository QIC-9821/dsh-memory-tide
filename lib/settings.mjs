// 设置读写：默认值、深合并、白名单清洗、原子写。
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

// SPEC §4 的默认值，必须完全一致。
export const DEFAULTS = {
  enabled: true,
  dryRun: false,
  curve: { baseTtlDays: 7, growth: 2.0, maxTtlEnabled: true, maxTtlDays: 90 },
  mentions: { enabled: true, minSharedGrams: 2, protectKeywords: '勿删,待确认,勿动,不要归档,不要删除' },
  archive: { archiveDays: 30, onExpiry: 'cold' }, // cold = 转入冷归档；delete = 期满硬删
  sweep: { intervalMinutes: 30, onTurnEnd: true, startupDelaySec: 10 },
  adapters: {
    fish: { enabled: true, mode: 'archive', maxEntries: 300 },
    evolve: {
      enabled: true,
      mode: 'archive',
      tracks: { memory: true, key: true, user: false, project: false, daily: false },
    },
  },
  customAdapters: [], // 通用文件映射，见 SPEC §7
  discovery: { enabled: true, autoAdoptHighConfidence: false, deny: [] },
  board: { pageSize: 100 },
}

// 测试可把根目录指到临时目录，避免碰真实的 ~/.dsh。
export function tideHome() {
  const override = process.env.DSH_MEMORY_TIDE_HOME
  return typeof override === 'string' && override.trim() ? override : path.join(os.homedir(), '.dsh', 'memory-tide')
}

export function settingsPath() {
  return path.join(tideHome(), 'settings.json')
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// 深合并：对象递归合并，数组/标量整体替换。
function mergeDeep(base, patch) {
  if (Array.isArray(base)) return Array.isArray(patch) ? structuredClone(patch) : structuredClone(base)
  if (!isPlainObject(base)) return patch === undefined ? structuredClone(base) : structuredClone(patch)
  const out = { ...base }
  if (!isPlainObject(patch)) return structuredClone(out)
  for (const [k, v] of Object.entries(patch)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = mergeDeep(out[k], v)
    else out[k] = structuredClone(v)
  }
  return out
}

function warnUnknown(obj, allowed, prefix, warnings) {
  if (!isPlainObject(obj)) return
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) warnings.push(`未知设置键 ${prefix}${k}，已丢弃`)
  }
}

function sectionObject(raw, key, warnings) {
  if (!(key in raw)) return {}
  const v = raw[key]
  if (!isPlainObject(v)) {
    warnings.push(`设置项 ${key} 不是对象，已使用默认值`)
    return {}
  }
  return v
}

function readBool(obj, key, def, prefix, warnings) {
  if (!(key in obj)) return def
  const v = obj[key]
  if (typeof v !== 'boolean') {
    warnings.push(`设置项 ${prefix}${key} 不是布尔值，已回落默认 ${def}`)
    return def
  }
  return v
}

function readNumber(obj, key, def, range, prefix, warnings) {
  if (!(key in obj)) return def
  const v = obj[key]
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    warnings.push(`设置项 ${prefix}${key} 不是有限数字，已回落默认 ${def}`)
    return def
  }
  const [min, max] = range
  if (v < min || v > max) {
    const clamped = Math.min(max, Math.max(min, v))
    warnings.push(`设置项 ${prefix}${key}=${v} 超出范围 [${min}, ${max}]，已修正为 ${clamped}`)
    return clamped
  }
  return v
}

function readEnum(obj, key, def, allowed, prefix, warnings) {
  if (!(key in obj)) return def
  const v = obj[key]
  if (!allowed.includes(v)) {
    warnings.push(`设置项 ${prefix}${key}=${JSON.stringify(v)} 不是 ${allowed.join(' / ')}，已回落默认 ${def}`)
    return def
  }
  return v
}

function readString(obj, key, def, prefix, warnings) {
  if (!(key in obj)) return def
  const v = obj[key]
  if (typeof v !== 'string') {
    warnings.push(`设置项 ${prefix}${key} 不是字符串，已回落默认值`)
    return def
  }
  return v
}

const MD_FORMAT_KEYS = ['delimiter', 'dateRegex', 'encoding']
const JSON_FORMAT_KEYS = ['listPath', 'textField', 'timeFields', 'idField', 'indent', 'tagsField']

function sanitizeFormat(type, raw, prefix, warnings) {
  if (raw === undefined) return {}
  if (!isPlainObject(raw)) {
    warnings.push(`${prefix}.format 不是对象，已忽略`)
    return {}
  }
  const allowed = type === 'file-md' ? MD_FORMAT_KEYS : JSON_FORMAT_KEYS
  const out = {}
  for (const [k, v] of Object.entries(raw)) {
    if (!allowed.includes(k)) {
      warnings.push(`${prefix}.format.${k} 不是该类型支持的字段，已丢弃`)
      continue
    }
    if (k === 'timeFields') {
      if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === 'string' && x)
      else warnings.push(`${prefix}.format.timeFields 不是数组，已忽略`)
      continue
    }
    if (k === 'indent') {
      if (typeof v === 'number' || typeof v === 'string') out[k] = v
      else warnings.push(`${prefix}.format.indent 必须是数字或字符串，已忽略`)
      continue
    }
    if (typeof v === 'string') out[k] = v
  }
  return out
}

function sanitizeCustomAdapters(raw, warnings) {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    warnings.push('设置项 customAdapters 不是数组，已使用空列表')
    return []
  }
  const out = []
  const seen = new Set()
  raw.forEach((item, index) => {
    const prefix = `customAdapters[${index}]`
    if (!isPlainObject(item)) {
      warnings.push(`${prefix} 不是对象，已丢弃`)
      return
    }
    const type = item.type === 'file-md' || item.type === 'file-json' ? item.type : null
    if (!type) {
      warnings.push(`${prefix}.type 必须是 file-md / file-json，已丢弃`)
      return
    }
    const filePath = typeof item.path === 'string' && item.path.trim() ? item.path : null
    if (!filePath) {
      warnings.push(`${prefix} 缺少 path，已丢弃`)
      return
    }
    let id = typeof item.id === 'string' && item.id ? item.id : `custom:${crypto.randomUUID()}`
    if (seen.has(id)) {
      warnings.push(`${prefix}.id=${id} 重复，已丢弃`)
      return
    }
    seen.add(id)
    const label = typeof item.label === 'string' && item.label ? item.label : filePath
    out.push({
      id,
      type,
      label,
      path: filePath,
      mode: item.mode === 'delete' ? 'delete' : 'archive',
      format: sanitizeFormat(type, item.format, prefix, warnings),
    })
  })
  return out
}

function sanitizeAdapters(raw, warnings) {
  const src = sectionObject(raw, 'adapters', warnings)
  warnUnknown(src, ['fish', 'evolve'], 'adapters.', warnings)

  const fishRaw = isPlainObject(src.fish) ? src.fish : {}
  if (src.fish !== undefined && !isPlainObject(src.fish)) warnings.push('设置项 adapters.fish 不是对象，已使用默认值')
  warnUnknown(fishRaw, ['enabled', 'mode', 'maxEntries'], 'adapters.fish.', warnings)

  const evolveRaw = isPlainObject(src.evolve) ? src.evolve : {}
  if (src.evolve !== undefined && !isPlainObject(src.evolve)) warnings.push('设置项 adapters.evolve 不是对象，已使用默认值')
  warnUnknown(evolveRaw, ['enabled', 'mode', 'tracks'], 'adapters.evolve.', warnings)

  const tracksRaw = isPlainObject(evolveRaw.tracks) ? evolveRaw.tracks : {}
  if (evolveRaw.tracks !== undefined && !isPlainObject(evolveRaw.tracks)) {
    warnings.push('设置项 adapters.evolve.tracks 不是对象，已使用默认值')
  }
  const trackKeys = Object.keys(DEFAULTS.adapters.evolve.tracks)
  warnUnknown(tracksRaw, trackKeys, 'adapters.evolve.tracks.', warnings)
  const tracks = {}
  for (const track of trackKeys) {
    tracks[track] = readBool(tracksRaw, track, DEFAULTS.adapters.evolve.tracks[track], 'adapters.evolve.tracks.', warnings)
  }

  return {
    fish: {
      enabled: readBool(fishRaw, 'enabled', DEFAULTS.adapters.fish.enabled, 'adapters.fish.', warnings),
      mode: readEnum(fishRaw, 'mode', DEFAULTS.adapters.fish.mode, ['archive', 'delete'], 'adapters.fish.', warnings),
      maxEntries: readNumber(fishRaw, 'maxEntries', DEFAULTS.adapters.fish.maxEntries, [0, 100000], 'adapters.fish.', warnings),
    },
    evolve: {
      enabled: readBool(evolveRaw, 'enabled', DEFAULTS.adapters.evolve.enabled, 'adapters.evolve.', warnings),
      mode: readEnum(evolveRaw, 'mode', DEFAULTS.adapters.evolve.mode, ['archive', 'delete'], 'adapters.evolve.', warnings),
      tracks,
    },
  }
}

// raw 可以是不完整的对象；返回完整设置 + 清洗警告。
export function sanitizeSettings(raw) {
  const warnings = []
  if (raw !== undefined && raw !== null && !isPlainObject(raw)) {
    warnings.push('settings 顶层不是对象，已使用全部默认值')
  }
  const src = isPlainObject(raw) ? raw : {}
  warnUnknown(src, Object.keys(DEFAULTS), '', warnings)

  const curveRaw = sectionObject(src, 'curve', warnings)
  warnUnknown(curveRaw, Object.keys(DEFAULTS.curve), 'curve.', warnings)

  const mentionsRaw = sectionObject(src, 'mentions', warnings)
  warnUnknown(mentionsRaw, Object.keys(DEFAULTS.mentions), 'mentions.', warnings)

  const archiveRaw = sectionObject(src, 'archive', warnings)
  warnUnknown(archiveRaw, Object.keys(DEFAULTS.archive), 'archive.', warnings)

  const sweepRaw = sectionObject(src, 'sweep', warnings)
  warnUnknown(sweepRaw, Object.keys(DEFAULTS.sweep), 'sweep.', warnings)

  const discoveryRaw = sectionObject(src, 'discovery', warnings)
  warnUnknown(discoveryRaw, Object.keys(DEFAULTS.discovery), 'discovery.', warnings)

  const boardRaw = sectionObject(src, 'board', warnings)
  warnUnknown(boardRaw, Object.keys(DEFAULTS.board), 'board.', warnings)

  const deny = []
  if (discoveryRaw.deny !== undefined) {
    if (Array.isArray(discoveryRaw.deny)) {
      for (const item of discoveryRaw.deny) {
        if (typeof item === 'string' && item) deny.push(item)
        else warnings.push('设置项 discovery.deny 里有非字符串项，已丢弃')
      }
    } else {
      warnings.push('设置项 discovery.deny 不是数组，已使用空列表')
    }
  }

  const settings = {
    enabled: readBool(src, 'enabled', DEFAULTS.enabled, '', warnings),
    dryRun: readBool(src, 'dryRun', DEFAULTS.dryRun, '', warnings),
    curve: {
      baseTtlDays: readNumber(curveRaw, 'baseTtlDays', DEFAULTS.curve.baseTtlDays, [0.0007, 3650], 'curve.', warnings),
      growth: readNumber(curveRaw, 'growth', DEFAULTS.curve.growth, [1, 10], 'curve.', warnings),
      maxTtlEnabled: readBool(curveRaw, 'maxTtlEnabled', DEFAULTS.curve.maxTtlEnabled, 'curve.', warnings),
      maxTtlDays: readNumber(curveRaw, 'maxTtlDays', DEFAULTS.curve.maxTtlDays, [1, 36500], 'curve.', warnings),
    },
    mentions: {
      enabled: readBool(mentionsRaw, 'enabled', DEFAULTS.mentions.enabled, 'mentions.', warnings),
      minSharedGrams: readNumber(mentionsRaw, 'minSharedGrams', DEFAULTS.mentions.minSharedGrams, [1, 5], 'mentions.', warnings),
      protectKeywords: readString(mentionsRaw, 'protectKeywords', DEFAULTS.mentions.protectKeywords, 'mentions.', warnings),
    },
    archive: {
      archiveDays: readNumber(archiveRaw, 'archiveDays', DEFAULTS.archive.archiveDays, [0, 36500], 'archive.', warnings),
      onExpiry: readEnum(archiveRaw, 'onExpiry', DEFAULTS.archive.onExpiry, ['cold', 'delete'], 'archive.', warnings),
    },
    sweep: {
      intervalMinutes: readNumber(sweepRaw, 'intervalMinutes', DEFAULTS.sweep.intervalMinutes, [1, 1440], 'sweep.', warnings),
      onTurnEnd: readBool(sweepRaw, 'onTurnEnd', DEFAULTS.sweep.onTurnEnd, 'sweep.', warnings),
      startupDelaySec: readNumber(sweepRaw, 'startupDelaySec', DEFAULTS.sweep.startupDelaySec, [0, 3600], 'sweep.', warnings),
    },
    adapters: sanitizeAdapters(src, warnings),
    customAdapters: sanitizeCustomAdapters(src.customAdapters, warnings),
    discovery: {
      enabled: readBool(discoveryRaw, 'enabled', DEFAULTS.discovery.enabled, 'discovery.', warnings),
      autoAdoptHighConfidence: readBool(
        discoveryRaw,
        'autoAdoptHighConfidence',
        DEFAULTS.discovery.autoAdoptHighConfidence,
        'discovery.',
        warnings,
      ),
      deny,
    },
    board: {
      pageSize: readNumber(boardRaw, 'pageSize', DEFAULTS.board.pageSize, [10, 500], 'board.', warnings),
    },
  }
  return { settings, warnings }
}

export async function loadSettings() {
  const warnings = []
  let raw
  try {
    raw = JSON.parse(await readFile(settingsPath(), 'utf8'))
  } catch (err) {
    if (err?.code !== 'ENOENT') warnings.push(`读取 settings.json 失败：${err?.message || err}`)
    raw = undefined
  }
  const merged = mergeDeep(DEFAULTS, raw)
  const result = sanitizeSettings(merged)
  return { settings: result.settings, warnings: [...new Set([...warnings, ...result.warnings])] }
}

export async function saveSettings(patch) {
  const loaded = await loadSettings()
  const merged = isPlainObject(patch) ? mergeDeep(loaded.settings, patch) : loaded.settings
  const result = sanitizeSettings(merged)
  const warnings = [...new Set([...loaded.warnings, ...result.warnings])]
  await writeJsonAtomic(settingsPath(), result.settings)
  return { settings: result.settings, warnings }
}

async function writeJsonAtomic(file, data) {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
  await rename(tmp, file)
}
