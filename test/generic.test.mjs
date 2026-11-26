import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createFileMdAdapter } from '../lib/adapters/file-md.mjs';
import { createFileJsonAdapter } from '../lib/adapters/file-json.mjs';

const sha1_16 = (text) => createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 16);

async function makeDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mt-generic-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function readText(file) {
  return fs.readFile(file, 'utf8');
}

function mdConfig(dir, fileName, format) {
  return {
    id: 'custom:md-test',
    type: 'file-md',
    label: '笔记测试',
    path: path.join(dir, fileName),
    mode: 'archive',
    format,
  };
}

function jsonConfig(dir, fileName, format) {
  return {
    id: 'custom:json-test',
    type: 'file-json',
    label: 'JSON 测试',
    path: path.join(dir, fileName),
    mode: 'archive',
    format,
  };
}

// ---------------------------------------------------------------- file-md

test('file-md: § delimiter parses date/text and removes only the target block', async (t) => {
  const dir = await makeDir(t);
  const file = path.join(dir, 'mem.md');
  const original = '第一段\n§\n[2026-11-01] 第二段\n\n第二段续行\n§\n第三段\n';
  await fs.writeFile(file, original, 'utf8');

  const adapter = createFileMdAdapter(mdConfig(dir, 'mem.md', {
    delimiter: '\n§\n',
    dateRegex: '^\\[(\\d{4}-\\d{2}-\\d{2})\\]\\s*',
  }));
  assert.equal(adapter.id, 'custom:md-test');
  assert.equal(adapter.kind, 'file-md');
  assert.equal(adapter.label, '笔记测试');

  const entries = await adapter.list();
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((e) => e.text), ['第一段', '第二段\n\n第二段续行', '第三段']);
  assert.equal(entries[0].date, null);
  assert.equal(entries[0].dateText, '');
  assert.equal(entries[1].dateText, '2026-11-01');
  assert.equal(entries[1].date, Date.parse('2026-11-01'));
  assert.equal(entries[1].entryId, sha1_16('[2026-11-01] 第二段\n\n第二段续行'));
  assert.equal(entries[1].key, `custom:md-test:${entries[1].entryId}`);
  assert.equal(entries[1].path, file);
  assert.equal(entries[1].track, null);
  assert.deepEqual(entries[1].tags, []);

  const result = await adapter.remove([entries[1]]);
  assert.deepEqual(result.removed, [entries[1].key]);
  assert.deepEqual(result.failed, []);
  assert.equal(await readText(file), '第一段\n§\n第三段\n');

  const after = await adapter.list();
  assert.equal(after.length, 2);
  assert.equal(after[0].entryId, entries[0].entryId);
  assert.equal(after[1].entryId, entries[2].entryId);
});

test('file-md: CRLF file keeps CRLF and removes a middle block exactly', async (t) => {
  const dir = await makeDir(t);
  const file = path.join(dir, 'crlf.md');
  await fs.writeFile(file, '甲\r\n§\r\n乙\r\n', 'utf8');
  const adapter = createFileMdAdapter(mdConfig(dir, 'crlf.md', { delimiter: '\n§\n' }));

  const entries = await adapter.list();
  assert.deepEqual(entries.map((e) => e.text), ['甲', '乙']);
  const result = await adapter.remove([entries[0]]);
  assert.equal(result.removed.length, 1);
  assert.equal(await readText(file), '乙\r\n');
  assert.ok(!(await readText(file)).includes('\n§\n'));
});

test('file-md: blank delimiter splits on empty lines and preserves blanks on delete', async (t) => {
  const dir = await makeDir(t);
  const file = path.join(dir, 'blank.md');
  await fs.writeFile(file, '2026-01-01 一号\n\n第二段\n\n第三段\n', 'utf8');
  const adapter = createFileMdAdapter(mdConfig(dir, 'blank.md', { delimiter: 'blank' }));

  const entries = await adapter.list();
  assert.deepEqual(entries.map((e) => e.text), ['2026-01-01 一号', '第二段', '第三段']);
  const result = await adapter.remove([entries[1]]);
  assert.equal(result.removed.length, 1);
  assert.equal(await readText(file), '2026-01-01 一号\n\n第三段\n');
});

test('file-md: "## " delimiter keeps the heading marker on remaining blocks', async (t) => {
  const dir = await makeDir(t);
  const file = path.join(dir, 'heading.md');
  await fs.writeFile(file, '## [2026-02-02] 甲\n## 乙\n', 'utf8');
  const adapter = createFileMdAdapter(mdConfig(dir, 'heading.md', {
    delimiter: '## ',
    dateRegex: '^\\[(\\d{4}-\\d{2}-\\d{2})\\]\\s*',
  }));

  const entries = await adapter.list();
  assert.deepEqual(entries.map((e) => e.text), ['甲', '乙']);
  assert.equal(entries[0].dateText, '2026-02-02');
  const result = await adapter.remove([entries[0]]);
  assert.equal(result.removed.length, 1);
  assert.equal(await readText(file), '## 乙\n');
});

test('file-md: "---" delimiter removes a middle block', async (t) => {
  const dir = await makeDir(t);
  const file = path.join(dir, 'rules.md');
  await fs.writeFile(file, 'A\n---\nB\n---\nC\n', 'utf8');
  const adapter = createFileMdAdapter(mdConfig(dir, 'rules.md', { delimiter: '---' }));
  const entries = await adapter.list();
  assert.deepEqual(entries.map((e) => e.text), ['A', 'B', 'C']);
  await adapter.remove([entries[1]]);
  assert.equal(await readText(file), 'A\n---\nC\n');
});

test('file-md: unmatched dateRegex leaves date null and add appends raw', async (t) => {
  const dir = await makeDir(t);
  const file = path.join(dir, 'mixed.md');
  await fs.writeFile(file, '无日期\n§\n[2026-03-01] 有日期\n', 'utf8');
  const adapter = createFileMdAdapter(mdConfig(dir, 'mixed.md', {
    delimiter: '\n§\n',
    dateRegex: '^\\[(\\d{4}-\\d{2}-\\d{2})\\]\\s*',
  }));
  const entries = await adapter.list();
  assert.equal(entries[0].date, null);
  assert.equal(entries[0].dateText, '');
  assert.equal(entries[1].dateText, '2026-03-01');

  const added = await adapter.add({ text: '新增', dateText: '2026-04-04' });
  assert.deepEqual(added, { ok: true });
  assert.equal(await readText(file), '无日期\n§\n[2026-03-01] 有日期\n\n§\n[2026-04-04] 新增\n');
  const after = await adapter.list();
  assert.equal(after.length, 3);
  assert.equal(after[2].text, '新增');
  assert.equal(after[2].dateText, '2026-04-04');
});

test('file-md: missing file lists nothing; unknown target fails without writing', async (t) => {
  const dir = await makeDir(t);
  const adapter = createFileMdAdapter(mdConfig(dir, 'nope.md', { delimiter: '\n§\n' }));
  assert.deepEqual(await adapter.list(), []);
  assert.deepEqual(await adapter.describe(), { path: path.join(dir, 'nope.md'), count: 0, missing: true });

  const file = path.join(dir, 'existing.md');
  const original = '一\n§\n二\n';
  await fs.writeFile(file, original, 'utf8');
  const real = createFileMdAdapter(mdConfig(dir, 'existing.md', { delimiter: '\n§\n' }));
  const result = await real.remove([{ key: 'custom:md-test:deadbeefdeadbeef', entryId: 'deadbeefdeadbeef' }]);
  assert.deepEqual(result.removed, []);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].error, 'entry not found');
  assert.equal(await readText(file), original);
});

test('file-md: remove matching by raw still works when entryId is absent', async (t) => {
  const dir = await makeDir(t);
  const file = path.join(dir, 'raw.md');
  await fs.writeFile(file, '甲\n§\n乙\n', 'utf8');
  const adapter = createFileMdAdapter(mdConfig(dir, 'raw.md', { delimiter: '\n§\n' }));
  const result = await adapter.remove([{ key: 'custom:md-test:unknown', raw: '乙' }]);
  assert.deepEqual(result.removed, ['custom:md-test:unknown']);
  assert.equal(await readText(file), '甲\n');
});

// -------------------------------------------------------------- file-json

test('file-json: object array keeps 4-space indent and trailing newline on delete', async (t) => {
  const dir = await makeDir(t);
  const file = path.join(dir, 'store.json');
  const original = `[
    {
        "id": "a",
        "text": "甲",
        "createdAt": 1700000000000,
        "tags": ["x"]
    },
    {
        "id": "b",
        "text": "乙",
        "at": "2026-01-02T00:00:00.000Z"
    }
]
`;
  await fs.writeFile(file, original, 'utf8');
  const adapter = createFileJsonAdapter(jsonConfig(dir, 'store.json', {
    listPath: '',
    textField: 'text',
    timeFields: ['createdAt', 'at'],
    idField: 'id',
    tagsField: 'tags',
  }));

  const entries = await adapter.list();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].entryId, 'a');
  assert.equal(entries[0].text, '甲');
  assert.equal(entries[0].date, 1700000000000);
  assert.deepEqual(entries[0].tags, ['x']);
  assert.equal(entries[1].entryId, 'b');
  assert.equal(entries[1].dateText, '2026-01-02');

  const result = await adapter.remove([entries[0]]);
  assert.deepEqual(result.removed, [entries[0].key]);
  const written = await readText(file);
  assert.ok(written.startsWith('[\n    {\n        "id": "b"'));
  assert.ok(written.endsWith('\n]\n'));
  assert.deepEqual(JSON.parse(written), [{ id: 'b', text: '乙', at: '2026-01-02T00:00:00.000Z' }]);
});

test('file-json: tab indent is detected and preserved', async (t) => {
  const dir = await makeDir(t);
  const file = path.join(dir, 'tab.json');
  await fs.writeFile(file, '[\n\t{"text":"甲"},\n\t{"text":"乙"}\n]\n', 'utf8');
  const adapter = createFileJsonAdapter(jsonConfig(dir, 'tab.json', { listPath: '' }));
  const entries = await adapter.list();
  assert.equal(entries.length, 2);
  await adapter.remove([entries[0]]);
  const written = await readText(file);
  assert.ok(written.includes('\n\t{\n\t\t"text": "乙"\n\t}\n'), written);
  assert.ok(written.endsWith('\n]\n'));
});

test('file-json: string array uses sha1 id and removes one string', async (t) => {
  const dir = await makeDir(t);
  const file = path.join(dir, 'strings.json');
  await fs.writeFile(file, '["aaa","bbb"]', 'utf8');
  const adapter = createFileJsonAdapter(jsonConfig(dir, 'strings.json', { listPath: '' }));
  const entries = await adapter.list();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].entryId, sha1_16('aaa'));
  assert.equal(entries[0].text, 'aaa');
  assert.equal(entries[0].date, null);
  const result = await adapter.remove([entries[0]]);
  assert.equal(result.removed.length, 1);
  assert.equal(await readText(file), '["bbb"]');
});

test('file-json: nested listPath reaches data.memories and keeps the rest', async (t) => {
  const dir = await makeDir(t);
  const file = path.join(dir, 'nested.json');
  const original = '{\n  "meta": {"v": 1},\n  "data": {\n    "memories": [\n      {"text": "a"},\n      {"text": "b"}\n    ]\n  }\n}\n';
  await fs.writeFile(file, original, 'utf8');
  const adapter = createFileJsonAdapter(jsonConfig(dir, 'nested.json', { listPath: 'data.memories' }));
  const entries = await adapter.list();
  assert.equal(entries.length, 2);
  await adapter.remove([entries[1]]);
  const written = await readText(file);
  assert.deepEqual(JSON.parse(written), { meta: { v: 1 }, data: { memories: [{ text: 'a' }] } });
  assert.ok(written.startsWith('{\n  "meta"'));
  assert.ok(written.endsWith('\n}\n'));
});

test('file-json: invalid JSON returns failed and never writes', async (t) => {
  const dir = await makeDir(t);
  const file = path.join(dir, 'broken.json');
  const original = '{"broken": ';
  await fs.writeFile(file, original, 'utf8');
  const adapter = createFileJsonAdapter(jsonConfig(dir, 'broken.json', { listPath: '' }));
  assert.deepEqual(await adapter.list(), []);
  const result = await adapter.remove([{ key: 'custom:json-test:x', entryId: 'x' }]);
  assert.deepEqual(result.removed, []);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /invalid JSON/);
  assert.equal(await readText(file), original);
  assert.deepEqual(await fs.readdir(dir), ['broken.json']);
});

test('file-json: add creates a missing store and appends to a string array', async (t) => {
  const dir = await makeDir(t);
  const file = path.join(dir, 'new.json');
  const adapter = createFileJsonAdapter(jsonConfig(dir, 'new.json', {
    listPath: 'memories',
    timeFields: ['createdAt'],
    tagsField: 'tags',
  }));
  const added = await adapter.add({ text: '新记忆', date: 1700000000000, tags: ['t'] });
  assert.deepEqual(added, { ok: true });
  const root = JSON.parse(await readText(file));
  assert.deepEqual(root, {
    memories: [{ text: '新记忆', createdAt: 1700000000000, tags: ['t'] }],
  });
  assert.equal((await adapter.list()).length, 1);

  const stringsFile = path.join(dir, 'strings2.json');
  await fs.writeFile(stringsFile, '["a"]', 'utf8');
  const stringAdapter = createFileJsonAdapter(jsonConfig(dir, 'strings2.json', { listPath: '' }));
  await stringAdapter.add({ text: 'b' });
  assert.equal(await readText(stringsFile), '["a","b"]');
});

test('file-json: describe counts entries and missing file yields zero', async (t) => {
  const dir = await makeDir(t);
  const missing = createFileJsonAdapter(jsonConfig(dir, 'missing.json', { listPath: '' }));
  assert.deepEqual(await missing.describe(), { path: path.join(dir, 'missing.json'), count: 0, missing: true });

  const file = path.join(dir, 'two.json');
  await fs.writeFile(file, '[{"text":"a"},{"text":"b"}]', 'utf8');
  const adapter = createFileJsonAdapter(jsonConfig(dir, 'two.json', { listPath: '' }));
  assert.deepEqual(await adapter.describe(), { path: file, count: 2, missing: false });
});
