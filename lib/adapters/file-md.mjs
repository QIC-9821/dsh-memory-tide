// Generic Markdown segmented-store adapter (SPEC §7.3).
// A markdown file is split into whole segments; only whole segments may be
// removed. Segment bodies are never edited or reordered, and the original
// delimiter / line endings / trailing newline are preserved on write.

import { existsSync } from 'node:fs';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const DEFAULT_DELIMITER = '\n§\n';
const DEFAULT_ENCODING = 'utf8';

function sha1_16(text) {
  return createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 16);
}

function eolOf(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function toTimestamp(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1e11 ? value * 1000 : value; // seconds vs milliseconds
    return Number.isNaN(new Date(ms).getTime()) ? null : ms;
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return null;
    if (/^\d+$/.test(s)) return toTimestamp(Number(s));
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

function dateTextOf(ms) {
  if (ms == null) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function compileDateRegex(src) {
  if (!src) return null;
  if (src instanceof RegExp) {
    const flags = src.flags.replace(/[gy]/g, '');
    try {
      return new RegExp(src.source, flags);
    } catch {
      return null;
    }
  }
  try {
    return new RegExp(String(src));
  } catch {
    return null;
  }
}

// A CRLF file needs the CRLF form of a newline-containing delimiter,
// otherwise "\n§\n" would never match and the whole file becomes one block.
function effectiveDelimiter(delimiter, text) {
  if (delimiter === 'blank') return 'blank';
  if (delimiter.includes('\n') && !delimiter.includes('\r') && text.includes('\r\n')) {
    return delimiter.replace(/\n/g, '\r\n');
  }
  return delimiter;
}

// Pieces keep their exact body plus the exact separator that followed them,
// so a write can reproduce untouched regions byte for byte.
function splitPieces(text, delimiter) {
  const pieces = [];
  if (delimiter === 'blank') {
    const re = /(?:\r?\n[ \t]*){2,}/g;
    let cursor = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      pieces.push({ body: text.slice(cursor, m.index), sep: m[0] });
      cursor = m.index + m[0].length;
    }
    pieces.push({ body: text.slice(cursor), sep: null });
    return pieces;
  }
  let cursor = 0;
  let idx;
  while ((idx = text.indexOf(delimiter, cursor)) !== -1) {
    pieces.push({ body: text.slice(cursor, idx), sep: delimiter });
    cursor = idx + delimiter.length;
  }
  pieces.push({ body: text.slice(cursor), sep: null });
  return pieces;
}

function serializePieces(pieces, delimiter) {
  if (!pieces.length) return '';
  let out = pieces[0].body;
  for (let i = 1; i < pieces.length; i += 1) {
    const fallback = delimiter === 'blank' ? '\n\n' : delimiter;
    out += (pieces[i - 1].sep ?? fallback) + pieces[i].body;
  }
  return out;
}

function applyTrailingStyle(out, original) {
  const hadEol = /\r?\n$/.test(original);
  const eol = eolOf(original);
  if (hadEol && !/\r?\n$/.test(out)) return out + eol;
  if (!hadEol && !out) return out;
  if (!hadEol && /\r?\n$/.test(out)) return out.replace(/\r?\n$/, '');
  return out;
}

function entryIdOfKey(entry) {
  if (entry?.entryId) return String(entry.entryId);
  const key = typeof entry?.key === 'string' ? entry.key : '';
  const idx = key.lastIndexOf(':');
  return idx >= 0 ? key.slice(idx + 1) : key;
}

export function createFileMdAdapter(config = {}) {
  const cfg = config || {};
  const filePath = cfg.path ? path.resolve(String(cfg.path)) : '';
  const adapterId = cfg.id || `custom:file-md:${sha1_16(filePath).slice(0, 10)}`;
  const label = cfg.label || (filePath ? path.basename(filePath) : 'markdown');
  const format = cfg.format && typeof cfg.format === 'object' ? cfg.format : {};
  const delimiter = typeof format.delimiter === 'string' && format.delimiter
    ? format.delimiter
    : DEFAULT_DELIMITER;
  const encoding = typeof format.encoding === 'string' && format.encoding
    ? format.encoding
    : DEFAULT_ENCODING;
  const dateRe = compileDateRegex(format.dateRegex);

  async function readRaw() {
    if (!filePath) return { ok: false, missing: true };
    try {
      return { ok: true, text: await readFile(filePath, encoding) };
    } catch (err) {
      if (err && err.code === 'ENOENT') return { ok: false, missing: true };
      return { ok: false, error: err?.message || String(err) };
    }
  }

  function makeEntry(raw) {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    let date = null;
    let dateText = '';
    let text = trimmed;
    if (dateRe) {
      const m = dateRe.exec(trimmed);
      if (m && m.index === 0 && m[1]) {
        dateText = m[1];
        date = toTimestamp(dateText);
        const rest = trimmed.slice(m[0].length).trim();
        if (rest) text = rest;
      }
    }
    return {
      key: `${adapterId}:${sha1_16(trimmed)}`,
      adapterId,
      entryId: sha1_16(trimmed),
      date,
      dateText,
      text,
      tags: [],
      track: null,
      raw: trimmed,
      path: filePath,
    };
  }

  async function list() {
    const r = await readRaw();
    if (!r.ok) return [];
    const delim = effectiveDelimiter(delimiter, r.text);
    const entries = [];
    for (const piece of splitPieces(r.text, delim)) {
      const entry = makeEntry(piece.body);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  async function describe() {
    const entries = await list();
    return { path: filePath, count: entries.length, missing: !existsSync(filePath) };
  }

  async function remove(entries) {
    const list = Array.isArray(entries) ? entries : [];
    const result = { removed: [], failed: [] };
    const r = await readRaw();
    if (!r.ok) {
      const error = r.missing ? 'file not found' : (r.error || 'read failed');
      result.failed = list.map((e) => ({ key: e?.key, error }));
      return result;
    }

    const delim = effectiveDelimiter(delimiter, r.text);
    const pieces = splitPieces(r.text, delim);
    const byId = new Map();
    const byRaw = new Map();
    for (const e of list) {
      const id = entryIdOfKey(e);
      if (id) byId.set(id, e?.key ?? id);
      if (typeof e?.raw === 'string' && e.raw.trim()) byRaw.set(e.raw.trim(), e?.key ?? id);
    }

    const matched = new Set();
    const kept = [];
    for (const piece of pieces) {
      const trimmed = piece.body.trim();
      const id = trimmed ? sha1_16(trimmed) : '';
      const hitKey = id && byId.has(id)
        ? byId.get(id)
        : (trimmed && byRaw.has(trimmed) ? byRaw.get(trimmed) : null);
      if (hitKey !== null) {
        matched.add(hitKey);
        continue;
      }
      kept.push(piece);
    }

    if (!matched.size) {
      result.failed = list.map((e) => ({ key: e?.key, error: 'entry not found' }));
      return result;
    }

    let out = kept.every((p) => !p.body.trim()) ? '' : serializePieces(kept, delim);
    if (out) out = applyTrailingStyle(out, r.text);
    await writeAtomic(filePath, out, encoding);

    result.removed = [...matched];
    for (const e of list) {
      const key = e?.key ?? entryIdOfKey(e);
      if (!matched.has(key)) result.failed.push({ key, error: 'entry not found' });
    }
    return result;
  }

  async function add(entry) {
    const raw = typeof entry?.raw === 'string' && entry.raw.trim()
      ? entry.raw.trim()
      : (entry?.dateText
        ? `[${entry.dateText}] ${String(entry.text ?? '')}`
        : String(entry?.text ?? '').trim());
    if (!raw) return { ok: false, error: 'empty entry' };

    const r = await readRaw();
    if (!r.ok && !r.missing) return { ok: false, error: r.error || 'read failed' };
    const original = r.ok ? r.text : '';
    const eol = eolOf(original || '\n');
    const delim = effectiveDelimiter(delimiter, original);

    let out;
    if (!original) {
      out = raw + eol;
    } else {
      const sep = delim === 'blank' ? eol + eol : delim;
      const needsBreak = !/\r?\n$/.test(original) && !/^\r?\n/.test(sep);
      out = original + (needsBreak ? eol : '') + sep + raw;
      out = applyTrailingStyle(out, original);
    }
    await writeAtomic(filePath, out, encoding);
    return { ok: true };
  }

  // 就地改写某一段正文（整合时用）。只换段体，分隔符/换行风格保持原样。
  async function update(entry, newText) {
    const text = typeof newText === 'string' ? newText.trim() : '';
    if (!text) return { ok: false, error: 'entry text is empty' };

    const r = await readRaw();
    if (!r.ok) return { ok: false, error: r.missing ? 'file not found' : (r.error || 'read failed') };

    const delim = effectiveDelimiter(delimiter, r.text);
    const pieces = splitPieces(r.text, delim);
    const eol = eolOf(r.text);
    const id = entryIdOfKey(entry);
    const raw = typeof entry?.raw === 'string' ? entry.raw.trim() : '';
    let hit = false;

    for (const piece of pieces) {
      const trimmed = piece.body.trim();
      if (!trimmed) continue;
      if (sha1_16(trimmed) !== id && trimmed !== raw) continue;
      const prefix = entry?.dateText ? `[${entry.dateText}] ` : '';
      piece.body = prefix + text.replace(/\r?\n/g, eol);
      hit = true;
      break;
    }

    if (!hit) return { ok: false, error: 'entry not found' };
    let out = serializePieces(pieces, delim);
    out = applyTrailingStyle(out, r.text);
    await writeAtomic(filePath, out, encoding);
    return { ok: true };
  }

  return { id: adapterId, label, kind: 'file-md', describe, list, remove, add, update };
}

async function writeAtomic(file, data, encoding) {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-memory-tide-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await writeFile(tmp, data, encoding);
  await rename(tmp, file);
}
