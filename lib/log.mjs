// dsh-memory-tide — logger that also appends to ~/.dsh/memory-tide/logs/sweep.log
// Path: lib/log.mjs
//
// createLogger(prefix) keeps the call sites tiny: logger.info/warn/error never
// throw, because logging must not break a sweep. store.mjs is core-engine's
// module, so the appender is imported lazily (and can be replaced in tests).

let defaultAppendPromise = null

function defaultAppend(line) {
  if (!defaultAppendPromise) {
    defaultAppendPromise = import('./store.mjs')
      .then((mod) => (typeof mod.appendLog === 'function' ? mod.appendLog : null))
      .catch(() => null)
  }
  return defaultAppendPromise.then((append) => (append ? append(line) : undefined))
}

function stringify(value) {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.stack || value.message || String(value)
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`
  try {
    const seen = new WeakSet()
    return JSON.stringify(value, (_key, nested) => {
      if (nested && typeof nested === 'object') {
        if (seen.has(nested)) return '[circular]'
        seen.add(nested)
      }
      return nested
    })
  } catch {
    return Object.prototype.toString.call(value)
  }
}

/**
 * @param {string} prefix tag prepended to every line, e.g. '[memory-tide]'
 * @param {{ append?: (line: string) => unknown }} [options] test hook
 * @returns {{ info: Function, warn: Function, error: Function }}
 */
export function createLogger(prefix = '', options = {}) {
  const tag = prefix ? String(prefix) : ''
  const append = typeof options.append === 'function' ? options.append : defaultAppend

  const write = (level, args) => {
    try {
      const text = args.map(stringify).join(' ')
      const line = `[${level}]${tag ? ` ${tag}` : ''} ${text}`
      const result = append(line)
      if (result && typeof result.catch === 'function') result.catch(() => {})
    } catch {
      // Logging failures stay silent by contract.
    }
  }

  return {
    info: (...args) => write('info', args),
    warn: (...args) => write('warn', args),
    error: (...args) => write('error', args),
  }
}
