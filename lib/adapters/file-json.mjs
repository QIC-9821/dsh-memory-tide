// Generic JSON store adapter (SPEC §7.4).
// The store is a JSON document whose (possibly nested) list is an array.
// Removal filters whole elements and re-serialises with the file's own
// indentation, line endings and trailing-newline convention.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const DEFAULT_ENCODING = 'utf8';

function sha1_16(text) {
  return createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 16);
}

function toTimestamp(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1e11 ? value * 1000 : value;
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

function detectIndent(text) {
  if (!text.includes('\n')) return 0; // compact JSON stays compact
  const tab = /\n(\t+)\S/.exec(text);
  if (tab) return '\t';
  const spaces = /\n( +)\S/.exec(text);
  if (spaces) {
    const n = spaces[1].length;
    return n >= 4 ? 4 : n >= 2 ? n : 2;
  }
  return 2;
}

function detectEol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function resolveArray(root, listPath) {
  const parts = String(listPath ?? '').split('.').filter(Boolean);
  let cur = root;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object') return null;
    cur = cur[part];
  }
  return Array.isArray(cur) ? cur : null;
}

function buildContainer(listPath) {
  const parts = String(listPath ?? '').split('.').filter(Boolean);
  if (!parts.length) return [];
  const root = {};
  let cur = root;
  for (let i = 0; i < parts.length; i += 1) {
    if (i === parts.length - 1) cur[parts[i]] = [];
    else {
      cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
  }
  return root;
}

function entryIdOfKey(entry) {
  if (entry?.entryId) return String(entry.entryId);
  const key = typeof entry?.key === 'string' ? entry.key : '';
  const idx = key.lastIndexOf(':');
  return idx >= 0 ? key.slice(idx + 1) : key;
}

export function createFileJsonAdapter(config = {}) {
  const cfg = config || {};
  const filePath = cfg.path ? path.resolve(String(cfg.path)) : '';
  const adapterId = cfg.id || `custom:file-json:${sha1_16(filePath).slice(0, 10)}`;
  const label = cfg.label || (filePath ? path.basename(filePath) : 'json');
  const format = cfg.format && typeof cfg.format === 'object' ? cfg.format : {};
  const encoding = typeof format.encoding === 'string' && format.encoding
    ? format.encoding
    : DEFAULT_ENCODING;
  const listPath = format.listPath === undefined ? 'memories' : String(format.listPath ?? '');
  const textField = typeof format.textField === 'string' && format.textField ? format.textField : 'text';
  const timeFields = (Array.isArray(format.timeFields) ? format.timeFields : ['createdAt', 'at'])
    .filter((f) => typeof f === 'string' && f);
  const idField = typeof format.idField === 'string' && format.idField ? format.idField : 'id';
  const tagsField = typeof format.tagsField === 'string' && format.tagsField ? format.tagsField : 'tags';

  async function readStore() {
    if (!filePath) return { ok: false, missing: true };
    let text;
    try {
      text = await readFile(filePath, encoding);
    } catch (err) {
      if (err && err.code === 'ENOENT') return { ok: false, missing: true };
      return { ok: false, error: err?.message || String(err) };
    }
    try {
      return { ok: true, root: JSON.parse(text), text };
    } catch (err) {
      return { ok: false, parseError: true, error: `invalid JSON: ${err?.message || String(err)}`, text };
    }
  }

  function elementId(el) {
    if (typeof el === 'string') return sha1_16(el);
    if (el && typeof el === 'object') {
      const raw = el[idField];
      if (typeof raw === 'string' && raw) return raw;
      if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
      if (typeof raw === 'bigint') return String(raw);
      return sha1_16(JSON.stringify(el));
    }
    return sha1_16(JSON.stringify(el) ?? String(el));
  }

  function elementText(el) {
    if (typeof el === 'string') return el;
    if (!el || typeof el !== 'object') return '';
    if (typeof el[textField] === 'string') return el[textField];
    for (const alt of ['text', 'content', 'memo']) {
      if (typeof el[alt] === 'string') return el[alt];
    }
    return '';
  }

  function elementDate(el) {
    if (!el || typeof el !== 'object') return { date: null, dateText: '' };
    for (const field of timeFields) {
      if (el[field] == null) continue;
      const ms = toTimestamp(el[field]);
      if (ms != null) return { date: ms, dateText: dateTextOf(ms) };
    }
    return { date: null, dateText: '' };
  }

  function elementTags(el) {
    if (!el || typeof el !== 'object') return [];
    const tags = el[tagsField];
    return Array.isArray(tags) ? tags.filter((t) => typeof t === 'string') : [];
  }

  function makeEntry(el, index) {
    const raw = typeof el === 'string' ? el : JSON.stringify(el);
    const { date, dateText } = elementDate(el);
    return {
      key: `${adapterId}:${elementId(el)}`,
      adapterId,
      entryId: elementId(el),
      date,
      dateText,
      text: elementText(el),
      tags: elementTags(el),
      track: null,
      raw,
      path: filePath,
      index,
    };
  }

  async function list() {
    const r = await readStore();
    if (!r.ok) return [];
    const arr = resolveArray(r.root, listPath);
    if (!arr) return [];
    return arr.map((el, i) => makeEntry(el, i));
  }

  async function describe() {
    const entries = await list();
    return { path: filePath, count: entries.length };
  }

  function serialise(root, formatForFile) {
    const indent = formatForFile.indent ?? detectIndent(formatForFile.text);
    let out = JSON.stringify(root, null, indent);
    if (formatForFile.eol === '\r\n') out = out.replace(/\n/g, '\r\n');
    if (formatForFile.trailing) out += formatForFile.eol;
    return out;
  }

  async function remove(entries) {
    const listIn = Array.isArray(entries) ? entries : [];
    const result = { removed: [], failed: [] };
    const r = await readStore();
    if (!r.ok) {
      const error = r.missing ? 'file not found' : (r.error || 'read failed');
      result.failed = listIn.map((e) => ({ key: e?.key, error }));
      return result;
    }
    const arr = resolveArray(r.root, listPath);
    if (!arr) {
      result.failed = listIn.map((e) => ({ key: e?.key, error: `array not found at "${listPath}"` }));
      return result;
    }

    const targets = new Set();
    for (const e of listIn) {
      const id = entryIdOfKey(e);
      if (id) targets.add(id);
    }

    const matched = new Set();
    const kept = [];
    for (const el of arr) {
      const id = elementId(el);
      if (targets.has(id)) {
        matched.add(`${adapterId}:${id}`);
        continue;
      }
      kept.push(el);
    }

    if (!matched.size) {
      result.failed = listIn.map((e) => ({ key: e?.key, error: 'entry not found' }));
      return result;
    }

    // replace the array in place so the nested container (and root, when the
    // list is the root) all see the filtered list
    arr.splice(0, arr.length, ...kept);

    const indentGiven = format.indent;
    const fileInfo = {
      indent: indentGiven ?? detectIndent(r.text),
      eol: detectEol(r.text),
      trailing: /\r?\n$/.test(r.text),
      text: r.text,
    };
    const out = serialise(r.root, fileInfo);
    await writeAtomic(filePath, out, encoding);

    result.removed = [...matched];
    for (const e of listIn) {
      const key = e?.key ?? `${adapterId}:${entryIdOfKey(e)}`;
      if (!matched.has(key)) result.failed.push({ key, error: 'entry not found' });
    }
    return result;
  }

  async function add(entry) {
    const r = await readStore();
    let root;
    let arr;
    let fileInfo;
    if (!r.ok) {
      if (!r.missing) return { ok: false, error: r.error || 'read failed' };
      root = buildContainer(listPath);
      arr = resolveArray(root, listPath);
      fileInfo = {
        indent: format.indent ?? 2,
        eol: '\n',
        trailing: true,
        text: '',
      };
    } else {
      root = r.root;
      arr = resolveArray(root, listPath);
      if (!arr) return { ok: false, error: `array not found at "${listPath}"` };
      fileInfo = {
        indent: format.indent ?? detectIndent(r.text),
        eol: detectEol(r.text),
        trailing: /\r?\n$/.test(r.text),
        text: r.text,
      };
    }

    let value = null;
    if (typeof entry?.raw === 'string' && /^\s*[{[]/.test(entry.raw)) {
      try {
        value = JSON.parse(entry.raw);
      } catch {
        value = null;
      }
    }
    if (value == null) {
      const stringArray = arr.length > 0 && arr.every((x) => typeof x === 'string');
      if (stringArray) {
        value = String(entry?.text ?? '');
      } else {
        value = { [textField]: String(entry?.text ?? '') };
        if (timeFields.length) value[timeFields[0]] = entry?.date ?? Date.now();
        if (entry?.tags?.length) value[tagsField] = entry.tags;
      }
    }

    arr.push(value);
    const out = serialise(root, fileInfo);
    await writeAtomic(filePath, out, encoding);
    return { ok: true };
  }

  return { id: adapterId, label, kind: 'file-json', describe, list, remove, add };
}

async function writeAtomic(file, data, encoding) {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-memory-tide-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await writeFile(tmp, data, encoding);
  await rename(tmp, file);
}
