// dsh-memory-tide — host plugin entry
// Path: index.js
//
// Registers no tools and injects nothing into the system prompt: the plugin
// only sweeps the memory stores of other plugins on a forgetting curve, plus a
// small HTTP surface for the settings page.
//
// Every event callback is wrapped so a bad payload can never break a turn.

import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { loadSettings, saveSettings, settingsPath } from './lib/settings.mjs'
import * as store from './lib/store.mjs'
import { matchMention } from './lib/match.mjs'
import { sweep as sweepModule } from './lib/sweep.mjs'
import { applyMerges } from './lib/merge.mjs'
import { createRegistry } from './lib/adapters/registry.mjs'
import { scan as scanModule } from './lib/discovery.mjs'
import { createLogger } from './lib/log.mjs'
import * as board from './lib/board.mjs'
import { registerRoutes } from './lib/routes.mjs'

export const name = 'dsh-memory-tide'
// webServer is optional: the sweeper must keep working on hosts without it.
export const inject = []

const MENTION_CACHE_MS = 10000
const STATE_SAVE_THROTTLE_MS = 2000
const TURN_END_DEBOUNCE_MS = 3000

function stateDir() {
  try {
    return dirname(settingsPath())
  } catch {
    return join(homedir(), '.dsh', 'memory-tide')
  }
}

function messageText(message) {
  if (!message) return ''
  if (typeof message === 'string') return message
  const content = message.content ?? message.message?.content ?? message.text
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (!part || typeof part !== 'object') return ''
        if (typeof part.text === 'string') return part.text
        if (typeof part.content === 'string') return part.content
        if (part.type === 'image' || part.type === 'image_url') return ''
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function extractMessages(payload) {
  if (!payload || typeof payload !== 'object') return []
  const candidates = [
    payload.messages,
    payload.session?.messages,
    payload.agent?.session?.messages,
    payload.session?.header?.messages,
    payload.history,
  ]
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate
  }
  return []
}

function lastUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message) continue
    const role = message.role ?? message.type
    if (role !== 'user' && role !== 'human') continue
    const text = messageText(message)
    if (text) return text
  }
  return ''
}

function newItem(key, entry, now) {
  const text = String(key)
  const split = text.indexOf(':')
  return {
    adapterId: entry?.adapterId ?? (split < 0 ? '' : text.slice(0, split)),
    entryId: entry?.entryId ?? (split < 0 ? text : text.slice(split + 1)),
    firstSeenAt: now,
    lastSeenAt: now,
    lastRecalledAt: 0,
    resetAt: now,
    touches: 0,
    pinned: false,
    state: 'active',
    archivedAt: 0,
    expiresAt: 0,
    date: Number.isFinite(entry?.date) ? entry.date : null,
    textHash: null,
  }
}

function summarizeReport(report) {
  if (!report) return 'no report'
  const totals = { checked: 0, expired: 0, archived: 0, cooled: 0, deleted: 0, failed: 0 }
  for (const row of Array.isArray(report.adapters) ? report.adapters : []) {
    for (const key of Object.keys(totals)) {
      if (Number.isFinite(row?.[key])) totals[key] += row[key]
    }
  }
  return Object.entries(totals)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ')
}

export async function apply(ctx, config = {}) {
  const logger = createLogger('[memory-tide]')

  let settings
  try {
    const loaded = await loadSettings()
    settings = loaded.settings
    for (const warning of Array.isArray(loaded.warnings) ? loaded.warnings : []) logger.warn(warning)
  } catch (error) {
    logger.error(`loadSettings failed: ${error?.stack || error?.message || error}`)
    return
  }

  let registry
  try {
    registry = createRegistry({ settings, getSettings: () => settings, logger })
  } catch (error) {
    logger.error(`createRegistry failed: ${error?.stack || error?.message || error}`)
    return
  }

  let state
  try {
    state = await store.loadState()
  } catch (error) {
    logger.error(`loadState failed: ${error?.stack || error?.message || error}`)
  }
  if (!state || typeof state !== 'object' || !state.items || typeof state.items !== 'object') {
    try {
      state = store.emptyState()
    } catch {
      state = { version: 1, items: {}, deny: [], lastSweepAt: 0, firstSweepDone: false }
    }
  }

  let firstRunReport = null
  let chain = Promise.resolve()
  let stateSaveTimer = null
  let stateSavePending = false
  let lastStateSaveAt = 0
  let turnEndTimer = null
  let mentionCache = { at: 0, entries: [] }

  const getSettings = () => settings
  const getState = () => state

  function flushState() {
    lastStateSaveAt = Date.now()
    stateSavePending = false
    return Promise.resolve(store.saveState(state)).catch((error) => {
      logger.error(`saveState failed: ${error?.stack || error?.message || error}`)
    })
  }

  function scheduleStateSave() {
    stateSavePending = true
    if (stateSaveTimer) return
    const wait = Math.max(0, STATE_SAVE_THROTTLE_MS - (Date.now() - lastStateSaveAt))
    stateSaveTimer = setTimeout(() => {
      stateSaveTimer = null
      if (!stateSavePending) return
      void flushState()
    }, wait)
    stateSaveTimer.unref?.()
  }

  function runSweep(options = {}) {
    const task = chain.then(async () => {
      if (!settings.enabled) return null
      const requestedDryRun = options?.dryRun === true
      const first = state.firstSweepDone !== true
      const dryRun = requestedDryRun || first || settings.dryRun === true
      let report = null
      try {
        report = await sweepModule({ registry, state, settings, logger, dryRun })
      } catch (error) {
        logger.error(`sweep failed: ${error?.stack || error?.message || error}`)
        return null
      }
      if (first) {
        firstRunReport = report
        state.firstSweepDone = true
      }
      if (!dryRun) state.lastSweepAt = Date.now()
      if (first || !dryRun) await flushState()
      logger.info(`sweep ${dryRun ? '(dry-run) ' : ''}done: ${summarizeReport(report)}`)
      return report
    })
    chain = task.catch((error) => {
      logger.error(`sweep queue failed: ${error?.stack || error?.message || error}`)
      return null
    })
    return chain
  }

  function sweepDue(now = Date.now()) {
    const minutes = Number(settings?.sweep?.intervalMinutes)
    const interval = (Number.isFinite(minutes) && minutes > 0 ? minutes : 30) * 60000
    return now - (Number(state.lastSweepAt) || 0) >= interval
  }

  function maybeSweep() {
    try {
      if (!settings.enabled) return
      if (!sweepDue()) return
      void runSweep({})
    } catch (error) {
      logger.error(`sweep trigger failed: ${error?.stack || error?.message || error}`)
    }
  }

  async function collectEntries({ maxAgeMs = MENTION_CACHE_MS } = {}) {
    if (mentionCache.at && Date.now() - mentionCache.at < maxAgeMs) return mentionCache.entries
    const entries = []
    for (const adapter of registry.adapters()) {
      const adapterSettings = settings?.adapters?.[adapter.id]
      if (adapterSettings && adapterSettings.enabled === false) continue
      try {
        const list = await adapter.list()
        if (Array.isArray(list)) entries.push(...list)
      } catch (error) {
        logger.warn(`list(${adapter.id}) failed: ${error?.message || error}`)
      }
    }
    mentionCache = { at: Date.now(), entries }
    return entries
  }

  async function onPreStep(payload) {
    try {
      if (!settings?.mentions?.enabled) return
      const text = lastUserText(extractMessages(payload))
      if (!text || text.trim().length < 2) return
      const entries = await collectEntries()
      if (!entries.length) return
      const minSharedGrams = Number(settings?.mentions?.minSharedGrams)
      const hits = matchMention(text, entries, {
        minSharedGrams: Number.isFinite(minSharedGrams) && minSharedGrams > 0 ? minSharedGrams : 2,
      })
      if (!Array.isArray(hits) || !hits.length) return

      const byKey = new Map()
      for (const entry of entries) {
        if (entry?.key) byKey.set(entry.key, entry)
      }
      const now = Date.now()
      let changed = false
      for (const key of hits) {
        const entry = byKey.get(key)
        let item = state.items[key]
        if (!item || typeof item !== 'object') {
          item = newItem(key, entry, now)
          state.items[key] = item
        }
        item.touches = (Number.isFinite(item.touches) ? item.touches : 0) + 1
        item.lastRecalledAt = now
        item.resetAt = now
        item.lastSeenAt = now
        changed = true
      }
      if (changed) scheduleStateSave()
    } catch (error) {
      logger.error(`mention tracking failed: ${error?.stack || error?.message || error}`)
    }
  }

  function onTurnStopping() {
    try {
      if (!settings.enabled || settings?.sweep?.onTurnEnd !== true) return
      if (turnEndTimer) clearTimeout(turnEndTimer)
      turnEndTimer = setTimeout(() => {
        turnEndTimer = null
        maybeSweep()
      }, TURN_END_DEBOUNCE_MS)
      turnEndTimer.unref?.()
    } catch (error) {
      logger.error(`turn-stopping handler failed: ${error?.stack || error?.message || error}`)
    }
  }

  const deps = {
    settings,
    registry,
    state,
    stateRepo: store,
    saveSettings,
    board,
    scan: scanModule,
    sweep: (options) => runSweep(options),
    merge: async (options = {}) => {
      const dryRun = options?.dryRun !== false
      const report = await applyMerges({ registry, state, settings, logger, dryRun })
      if (!dryRun) await flushState()
      return report
    },
    logger,
    paths: { dir: stateDir() },
    getSettings,
    getState,
    getFirstRunReport: () => firstRunReport,
    onSettingsApplied: async (next) => {
      settings = next
      deps.settings = next
      mentionCache = { at: 0, entries: [] }
      try {
        await registry.reload()
      } catch (error) {
        logger.warn(`registry.reload failed: ${error?.message || error}`)
      }
    },
  }

  // HTTP surface (optional: hosts without webServer keep sweeping).
  try {
    registerRoutes(ctx, deps)
  } catch (error) {
    logger.warn(`registerRoutes failed: ${error?.message || error}`)
  }

  // Mentions pause the countdown; they never accelerate it.
  try {
    if (typeof ctx?.on === 'function') {
      ctx.on('agent/pre-step', (payload, next) => {
        // `agent/pre-step` is a waterfall: skipping next() would swallow the
        // step decision and break the turn, so always pass control on.
        void onPreStep(payload)
        return typeof next === 'function' ? next() : undefined
      })
      ctx.on('agent/turn-stopping', () => {
        onTurnStopping()
      })
    } else {
      logger.warn('ctx.on is unavailable; memory mentions will not be tracked')
    }
  } catch (error) {
    logger.warn(`event registration failed: ${error?.message || error}`)
  }

  // Interval sweeper, plus the one-off startup kick.
  const effect = (body, label) => {
    if (typeof ctx?.effect === 'function') {
      try {
        return ctx.effect(body, label)
      } catch (error) {
        logger.warn(`ctx.effect(${label}) failed: ${error?.message || error}`)
      }
    }
    return body()
  }

  effect(
    () => {
      let interval = null
      let startup = null
      try {
        const minutes = Number(settings?.sweep?.intervalMinutes)
        const period = (Number.isFinite(minutes) && minutes > 0 ? minutes : 30) * 60000
        interval = setInterval(() => maybeSweep(), period)
        interval.unref?.()

        const delay = Number(settings?.sweep?.startupDelaySec)
        startup = setTimeout(() => {
          try {
            if (!settings.enabled) return
            if (state.firstSweepDone !== true) void runSweep({})
            else maybeSweep()
          } catch (error) {
            logger.error(`startup sweep failed: ${error?.stack || error?.message || error}`)
          }
        }, (Number.isFinite(delay) && delay >= 0 ? delay : 10) * 1000)
        startup.unref?.()
      } catch (error) {
        logger.warn(`sweeper setup failed: ${error?.message || error}`)
      }
      return () => {
        if (interval) clearInterval(interval)
        if (startup) clearTimeout(startup)
        if (turnEndTimer) {
          clearTimeout(turnEndTimer)
          turnEndTimer = null
        }
      }
    },
    'dsh-memory-tide: sweeper',
  )

  // Flush state on teardown.
  effect(
    () => () => {
      if (stateSaveTimer) {
        clearTimeout(stateSaveTimer)
        stateSaveTimer = null
      }
      void flushState()
    },
    'dsh-memory-tide: flush state',
  )

  // Public service for future plugins (self-registering sources).
  const service = {
    registerSource(source) {
      try {
        registry.registerSource(source)
        logger.info(`source registered: ${source?.id ?? 'unknown'}`)
      } catch (error) {
        logger.warn(`registerSource failed: ${error?.message || error}`)
      }
      return service
    },
    unregisterSource(id) {
      try {
        registry.unregisterSource(id)
        logger.info(`source unregistered: ${id}`)
      } catch (error) {
        logger.warn(`unregisterSource failed: ${error?.message || error}`)
      }
      return service
    },
    sweep: () => runSweep({}),
  }

  try {
    if (typeof ctx?.provide === 'function') ctx.provide('memoryTide', service)
    else if (typeof ctx?.set === 'function') ctx.set('memoryTide', service)
    else logger.warn('neither ctx.provide nor ctx.set is available; memoryTide service not exposed')
  } catch (error) {
    logger.warn(`provide(memoryTide) failed: ${error?.message || error}`)
    try {
      ctx?.set?.('memoryTide', service)
    } catch (fallbackError) {
      logger.warn(`ctx.set(memoryTide) failed: ${fallbackError?.message || fallbackError}`)
    }
  }

  logger.info(
    `ready: enabled=${settings.enabled} dryRun=${settings.dryRun} ` +
      `ttl=${settings.curve?.baseTtlDays}d interval=${settings.sweep?.intervalMinutes}m ` +
      `state=${join(stateDir(), 'state.json')}`,
  )
}
