// Read-only discovery of candidate memory stores under ~/.dsh (SPEC §7.5).
// Nothing here writes to disk: it only walks, stats and parses files, and
// reports what could be adopted as a custom adapter.

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const MAX_DEPTH = 4;
const MAX_SIZE = 2 * 1024 * 1024;
const MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;

const SKIP_DIR_NAMES = new Set([
  'node_modules',
  'backup',
  'archive',
  'billion-context',
  'profiles',
  'attachments',
  'storages',
  'sessions',
  'logs',
  '.git',
  'memory-tide',
  'fish-memory-backup',
]);

const TIME_FIELDS = ['createdAt', 'at', 'time', 'timestamp', 'date', 'updatedAt', 'ts'];
const TEXT_FIELDS = ['text', 'content', 'memo'];
const PREVIEW_LEN = 80;
const PREVIEW_COUNT = 3;

const EVOLVE_DATE_REGEX = '^\\[(\\d{4}-\\d{2}-\\d{2})(?:[ T][^\\]]*)?\\]\\s*';
const GENERIC_DATE_REGEX = '^\\[(\\d{4}-\\d{2}-\\d{2})\\]\\s*';

function truncate(text) {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim();
  return one.length > PREVIEW_LEN ? one.slice(0, PREVIEW_LEN) : one;
}

function normalisePath(p) {
  let out = path.resolve(String(p));
  if (process.platform === 'win32') out = out.toLowerCase();
  return out.replace(/[\\/]+$/, '');
}

function isDenied(file, deny) {
  if (!deny.length) return false;
  const n = normalisePath(file);
  return deny.some((d) => n === d || n.startsWith(d));
}

function isExcludedFile(name) {
  const n = name.toLowerCase();
  if (n === 'settings.json' || n === 'package.json') return true;
  if (n.endsWith('.lock')) return true;
  if (n.includes('.bak')) return true;
  return false;
}

function splitBlank(text) {
  return text.split(/(?:\r?\n[ \t]*){2,}/).map((s) => s.trim()).filter(Boolean);
}

function segmentDate(segment) {
  const t = String(segment).trim().replace(/^#{1,6}\s*/, '');
  const m = /^\[(\d{4}-\d{2}-\d{2})\]/.exec(t);
  return m ? m[1] : null;
}

function timeFieldsOf(obj) {
  return TIME_FIELDS.filter((f) => obj[f] != null && obj[f] !== '');
}

function hasAnyTimeField(obj) {
  return TIME_FIELDS.some((f) => obj[f] != null && obj[f] !== '');
}

function hasTextField(obj, field) {
  return obj && typeof obj === 'object' && typeof obj[field] === 'string';
}

function anyText(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  for (const f of TEXT_FIELDS) {
    if (typeof value[f] === 'string') return value[f];
  }
  return '';
}

function classifyJson(text) {
  let root;
  try {
    root = JSON.parse(text);
  } catch (err) {
    return {
      kind: 'unknown',
      confidence: 0,
      count: 0,
      preview: [],
      reason: `JSON parse failed: ${err?.message || String(err)}`,
      suggested: null,
    };
  }

  if (root && typeof root === 'object' && root.version === 2 && Array.isArray(root.memories)) {
    const preview = root.memories
      .map((m) => (m && typeof m === 'object' ? m.text : m))
      .filter((t) => typeof t === 'string' && t.trim())
      .slice(0, PREVIEW_COUNT)
      .map(truncate);
    return {
      kind: 'fish',
      confidence: 0.95,
      count: root.memories.length,
      preview,
      reason: 'version=2 且 memories 是数组',
      suggested: {
        type: 'file-json',
        format: {
          listPath: 'memories',
          textField: 'text',
          timeFields: ['createdAt', 'at'],
          idField: 'id',
          tagsField: 'tags',
        },
      },
    };
  }

  if (Array.isArray(root) && root.length) {
    const objects = root.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
    const qualifying = objects.filter((o) => hasTextField(o, 'text')
      || hasTextField(o, 'content')
      || hasTextField(o, 'memo'));
    const withTime = qualifying.filter(hasAnyTimeField);
    const ratio = withTime.length / root.length;
    if (ratio >= 0.5) {
      const textField = TEXT_FIELDS.find((f) => root.some((o) => hasTextField(o, f))) || 'text';
      const timeFields = [];
      for (const f of TIME_FIELDS) {
        if (root.some((o) => o && typeof o === 'object' && o[f] != null && o[f] !== '')) timeFields.push(f);
      }
      const idField = root.some((o) => o && typeof o === 'object' && o.id != null) ? 'id' : null;
      const tagsField = root.some((o) => o && typeof o === 'object' && Array.isArray(o.tags)) ? 'tags' : 'tags';
      const preview = root
        .map((o) => anyText(o))
        .filter((t) => typeof t === 'string' && t.trim())
        .slice(0, PREVIEW_COUNT)
        .map(truncate);
      return {
        kind: 'file-json',
        confidence: 0.6,
        count: root.length,
        preview,
        reason: 'JSON 数组，过半元素带正文与时间字段',
        suggested: {
          type: 'file-json',
          format: {
            listPath: '',
            textField,
            timeFields: timeFields.length ? timeFields : ['createdAt', 'at'],
            ...(idField ? { idField } : {}),
            tagsField,
          },
        },
      };
    }
  }

  return {
    kind: 'unknown',
    confidence: 0,
    count: Array.isArray(root) ? root.length : 0,
    preview: [],
    reason: 'JSON 但不符合记忆库特征',
    suggested: null,
  };
}

function classifyMarkdown(text) {
  const clean = text.replace(/^\uFEFF/, '');
  if (/(?:\r?\n)§(?:\r?\n)/.test(clean)) {
    const blocks = clean.split(/\r?\n§\r?\n/).map((s) => s.trim()).filter(Boolean);
    const preview = blocks.slice(0, PREVIEW_COUNT).map((b) => truncate(stripLeadingDate(b)));
    return {
      kind: 'evolve',
      confidence: 0.9,
      count: blocks.length,
      preview,
      reason: 'Markdown 含 \\n§\\n 分隔',
      suggested: {
        type: 'file-md',
        format: { delimiter: '\n§\n', dateRegex: EVOLVE_DATE_REGEX },
      },
    };
  }

  const candidates = [
    { delimiter: '\n§\n', label: '\\n§\\n' },
    { delimiter: '---', label: '---' },
    { delimiter: '## ', label: '## ' },
    { delimiter: 'blank', label: 'blank' },
  ];
  const evaluated = [];
  for (const cand of candidates) {
    const segments = cand.delimiter === 'blank'
      ? splitBlank(clean)
      : clean.split(cand.delimiter).map((s) => s.trim()).filter(Boolean);
    const dated = segments.filter((s) => segmentDate(s) !== null).length;
    const ratio = dated / segments.length;
    if (dated > 0 && ratio >= 0.3) evaluated.push({ ...cand, segments, ratio, dated });
  }
  // Real separators win over the whole file read as one segment; a file whose
  // whole body is one dated paragraph is still a (single-entry) file-md store.
  const splitting = evaluated.filter((c) => c.segments.length >= 2);
  const pool = splitting.length ? splitting : evaluated;
  let best = null;
  for (const cand of pool) {
    if (
      !best ||
      cand.ratio > best.ratio ||
      (cand.ratio === best.ratio && cand.segments.length > best.segments.length)
    ) {
      best = cand;
    }
  }

  if (best && best.ratio >= 0.3 && best.dated > 0) {
    return {
      kind: 'file-md',
      confidence: 0.6,
      count: best.segments.length,
      preview: best.segments.slice(0, PREVIEW_COUNT).map((s) => truncate(stripLeadingDate(s))),
      reason: `Markdown 分段（${best.label}）后 ${best.dated}/${best.segments.length} 段带 [YYYY-MM-DD] 日期`,
      suggested: {
        type: 'file-md',
        format: { delimiter: best.delimiter, dateRegex: GENERIC_DATE_REGEX },
      },
    };
  }

  return {
    kind: 'unknown',
    confidence: 0,
    count: 0,
    preview: [],
    reason: 'Markdown 但未识别出分段日期格式',
    suggested: null,
  };
}

function stripLeadingDate(segment) {
  return String(segment).trim()
    .replace(/^#{1,6}\s*/, '')
    .replace(/^\[\d{4}-\d{2}-\d{2}(?:[ T][^\]]*)?\]\s*/, '');
}

function classifyFile(filePath, text) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.json') return classifyJson(text);
  if (ext === '.md') return classifyMarkdown(text);
  return {
    kind: 'unknown',
    confidence: 0,
    count: 0,
    preview: [],
    reason: 'unsupported extension',
    suggested: null,
  };
}

export async function scan({ settings, logger, roots } = {}) {
  const denyRaw = settings?.discovery?.deny;
  const deny = (Array.isArray(denyRaw) ? denyRaw : [])
    .filter((d) => typeof d === 'string' && d.trim())
    .map((d) => normalisePath(d));

  let rootList;
  if (typeof roots === 'string') rootList = [roots];
  else if (Array.isArray(roots) && roots.length) rootList = roots.filter((r) => typeof r === 'string' && r);
  else rootList = [path.join(os.homedir(), '.dsh')];

  const found = [];
  const skipped = [];
  const now = Date.now();

  async function handleFile(filePath) {
    const name = path.basename(filePath);
    if (isDenied(filePath, deny)) {
      skipped.push({ path: filePath, reason: 'denied' });
      return;
    }
    if (isExcludedFile(name)) {
      skipped.push({ path: filePath, reason: 'excluded file name' });
      return;
    }
    let info;
    try {
      info = await stat(filePath);
    } catch (err) {
      skipped.push({ path: filePath, reason: `stat failed: ${err?.code || err?.message || err}` });
      return;
    }
    if (info.size > MAX_SIZE) {
      skipped.push({ path: filePath, reason: `too large (${info.size} bytes)` });
      return;
    }
    if (now - info.mtimeMs > MAX_AGE_MS) {
      skipped.push({ path: filePath, reason: 'older than 180 days' });
      return;
    }
    let text;
    try {
      text = await readFile(filePath, 'utf8');
    } catch (err) {
      skipped.push({ path: filePath, reason: `read failed: ${err?.code || err?.message || err}` });
      return;
    }
    const classified = classifyFile(filePath, text);
    found.push({ path: filePath, ...classified });
  }

  async function walk(dir, depth) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      skipped.push({ path: dir, reason: `readdir failed: ${err?.code || err?.message || err}` });
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        const lower = ent.name.toLowerCase();
        // Backups are historical copies, never live memory: adopting one would
        // resurrect entries the user already deleted.
        if (lower.includes('backup')) continue;
        if (SKIP_DIR_NAMES.has(lower)) continue;
        if (isDenied(full, deny)) {
          skipped.push({ path: full, reason: 'denied' });
          continue;
        }
        if (depth + 1 > MAX_DEPTH) continue;
        await walk(full, depth + 1);
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase();
        if (ext !== '.json' && ext !== '.md') continue;
        await handleFile(full);
      }
    }
  }

  for (const root of rootList) {
    let info;
    try {
      info = await stat(root);
    } catch (err) {
      skipped.push({ path: root, reason: `root not found: ${err?.code || err?.message || err}` });
      continue;
    }
    if (!info.isDirectory()) {
      skipped.push({ path: root, reason: 'not a directory' });
      continue;
    }
    await walk(root, 0);
  }

  found.sort((a, b) => a.path.localeCompare(b.path));
  return { found, skipped };
}
