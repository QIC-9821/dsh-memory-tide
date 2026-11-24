import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { scan } from '../lib/discovery.mjs';

const sha1 = (buf) => createHash('sha1').update(buf).digest('hex');

async function makeDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mt-discovery-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function write(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, 'utf8');
}

async function snapshot(root) {
  const rows = [];
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        await walk(full);
      } else if (ent.isFile()) {
        const st = await fs.stat(full);
        const buf = await fs.readFile(full);
        rows.push({
          rel: path.relative(root, full).replaceAll('\\', '/'),
          size: st.size,
          mtimeMs: st.mtimeMs,
          sha: sha1(buf),
        });
      }
    }
  }
  await walk(root);
  return rows;
}

function rel(root, file) {
  return path.relative(root, file).replaceAll('\\', '/');
}

async function buildFixture(t) {
  const root = await makeDir(t);

  await write(path.join(root, 'fish-memory', 'ws_1.json'), JSON.stringify({
    version: 2,
    memories: [
      { id: 'm1', text: 'fish 一', createdAt: 1700000000000 },
      { id: 'm2', text: 'fish 二' },
    ],
  }, null, 2));

  await write(path.join(root, 'memories', 'MEMORY.md'), '记忆一\n§\n[2026-01-01] 记忆二\n');

  await write(
    path.join(root, 'notes', 'notes.md'),
    '[2026-01-01] 笔记一\n\n[2026-02-02] 笔记二\n\n[2026-03-03] 笔记三\n',
  );

  await write(
    path.join(root, 'notes', 'headings.md'),
    '## [2026-01-01] 甲\n## [2026-02-02] 乙\n',
  );

  await write(path.join(root, 'store', 'data.json'), JSON.stringify([
    { text: '一', at: '2026-01-01T00:00:00.000Z' },
    { content: '二', createdAt: 1700000000000 },
  ], null, 2));

  await write(path.join(root, 'misc', 'random.json'), '{"hello":"world"}\n');
  await write(path.join(root, 'settings.json'), '{"theme":"dark"}\n');
  await write(path.join(root, 'package.json'), '{"name":"x"}\n');
  await write(path.join(root, 'something.lock'), 'lock\n');
  await write(path.join(root, 'old.bak2'), 'backup\n');

  await write(path.join(root, 'node_modules', 'pkg', 'ws.json'), JSON.stringify({
    version: 2,
    memories: [{ id: 'n1', text: 'should be skipped' }],
  }));

  await write(path.join(root, 'private', 'secret.md'), '[2026-01-01] secret\n\n[2026-02-02] secret2\n');

  await write(path.join(root, 'deep', 'a', 'b', 'c', 'deep-ok.md'), '[2026-01-01] ok\n');
  await write(path.join(root, 'deep', 'a', 'b', 'c', 'd', 'e', 'too-deep.md'), '[2026-01-01] deep\n');

  const big = path.join(root, 'big', 'big.md');
  await write(big, `${'a'.repeat(2 * 1024 * 1024 + 1)}\n`);

  const old = path.join(root, 'old', 'oldmem.md');
  await write(old, '[2026-01-01] old\n');
  const oldTime = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
  await fs.utimes(old, oldTime, oldTime);

  let symlink = null;
  try {
    symlink = path.join(root, 'link.md');
    await fs.symlink(path.join(root, 'notes', 'notes.md'), symlink, 'file');
  } catch {
    symlink = null;
  }

  return { root, symlink, big, old, deny: [path.join(root, 'private')] };
}

test('scan: identifies fish / evolve / file-md / file-json / unknown and applies exclusions', async (t) => {
  const { root, symlink, big, old, deny } = await buildFixture(t);
  const before = await snapshot(root);

  const result = await scan({
    settings: { discovery: { enabled: true, deny } },
    roots: [root],
  });
  assert.ok(Array.isArray(result.found));
  assert.ok(Array.isArray(result.skipped));

  const map = new Map(result.found.map((f) => [rel(root, f.path), f]));

  const fish = map.get('fish-memory/ws_1.json');
  assert.ok(fish, 'fish fixture discovered');
  assert.equal(fish.kind, 'fish');
  assert.equal(fish.confidence, 0.95);
  assert.equal(fish.count, 2);
  assert.deepEqual(fish.preview, ['fish 一', 'fish 二']);
  assert.equal(fish.suggested.type, 'file-json');
  assert.equal(fish.suggested.format.listPath, 'memories');

  const evolve = map.get('memories/MEMORY.md');
  assert.ok(evolve, 'evolve fixture discovered');
  assert.equal(evolve.kind, 'evolve');
  assert.equal(evolve.confidence, 0.9);
  assert.equal(evolve.count, 2);
  assert.deepEqual(evolve.preview, ['记忆一', '记忆二']);
  assert.equal(evolve.suggested.format.delimiter, '\n§\n');

  const notes = map.get('notes/notes.md');
  assert.ok(notes, 'dated markdown discovered');
  assert.equal(notes.kind, 'file-md');
  assert.equal(notes.confidence, 0.6);
  assert.equal(notes.count, 3);
  assert.equal(notes.suggested.format.delimiter, 'blank');
  assert.match(notes.reason, /2\/2|\d+\/\d+/);
  assert.deepEqual(notes.preview, ['笔记一', '笔记二', '笔记三']);

  const headings = map.get('notes/headings.md');
  assert.ok(headings);
  assert.equal(headings.kind, 'file-md');
  assert.equal(headings.suggested.format.delimiter, '## ');

  const data = map.get('store/data.json');
  assert.ok(data, 'object array discovered');
  assert.equal(data.kind, 'file-json');
  assert.equal(data.confidence, 0.6);
  assert.equal(data.count, 2);
  assert.equal(data.suggested.format.listPath, '');
  assert.ok(data.suggested.format.timeFields.includes('at'));
  assert.ok(data.suggested.format.timeFields.includes('createdAt'));
  assert.deepEqual(data.preview, ['一', '二']);

  const random = map.get('misc/random.json');
  assert.ok(random);
  assert.equal(random.kind, 'unknown');
  assert.equal(random.confidence, 0);
  assert.equal(random.suggested, null);

  assert.ok(map.has('deep/a/b/c/deep-ok.md'), 'depth 4 file is included');
  assert.ok(!map.has('deep/a/b/c/d/e/too-deep.md'), 'depth 5 file is not walked');
  assert.ok(!map.has('node_modules/pkg/ws.json'), 'node_modules is skipped');
  assert.ok(!map.has('private/secret.md'), 'denied prefix is skipped');
  assert.ok(!map.has('settings.json'), 'settings.json excluded');
  assert.ok(!map.has('package.json'), 'package.json excluded');
  assert.ok(!map.has('old/oldmem.md'), 'old file excluded by mtime');
  assert.ok(!map.has('big/big.md'), 'oversized file excluded');
  if (symlink) assert.ok(!map.has('link.md'), 'symlink is skipped');

  const skippedReasons = new Map(result.skipped.map((s) => [rel(root, s.path), s.reason]));
  assert.ok(skippedReasons.has('settings.json'));
  assert.match(skippedReasons.get('settings.json'), /excluded/);
  assert.match(skippedReasons.get('package.json'), /excluded/);
  assert.match(skippedReasons.get('private'), /denied/);
  assert.match(skippedReasons.get('big/big.md'), /too large|2MB/i);
  assert.match(skippedReasons.get('old/oldmem.md'), /180 days/);

  for (const f of result.found) {
    for (const p of f.preview) assert.ok(p.length <= 80, `preview too long: ${p}`);
  }

  const after = await snapshot(root);
  assert.deepEqual(after, before, 'scan must not write any file');
});

test('scan: roots override accepts a single directory string and a relative prefix deny', async (t) => {
  const { root } = await buildFixture(t);
  const result = await scan({ roots: root });
  assert.ok(result.found.length > 0);
  assert.ok(result.found.every((f) => path.isAbsolute(f.path)));
  assert.ok(!result.found.some((f) => rel(root, f.path).startsWith('node_modules/')));

  const only = await scan({ roots: [path.join(root, 'notes')] });
  assert.equal(only.found.length, 2);
  assert.ok(only.found.every((f) => f.kind === 'file-md'));
});

test('scan: missing root is reported as skipped, not thrown', async (t) => {
  const root = await makeDir(t);
  const result = await scan({ roots: [path.join(root, 'does-not-exist')] });
  assert.deepEqual(result.found, []);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /root not found/);
});

test('scan: a whole-file dated paragraph with no separator is a single-entry file-md store', async (t) => {
  const root = await makeDir(t);
  const file = path.join(root, 'mem', 'MEMORY.md');
  await write(file, '[2026-11-07] 一条没有分隔符的长期记忆\n');
  const result = await scan({ roots: [root] });
  const found = result.found.find((f) => f.path === file);
  assert.ok(found, 'single-entry memory file discovered');
  assert.equal(found.kind, 'file-md');
  assert.equal(found.confidence, 0.6);
  assert.equal(found.count, 1);
  assert.equal(found.suggested.format.delimiter, '\n§\n');
  assert.deepEqual(found.preview, ['一条没有分隔符的长期记忆']);
});
