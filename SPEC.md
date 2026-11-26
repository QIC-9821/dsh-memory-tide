# dsh-memory-tide — 实现规格（唯一契约）

本文件是并行开发的唯一契约。所有模块按这里的签名实现；不要改别人的文件，不要引入第三方依赖。

## 0. 使命

DSH 本地插件。后台按「遗忘曲线」把长期不被提及的记忆从**现有记忆插件自己的存储**里删掉；不注册工具、不向 systemPrompt 注入任何内容（常驻 token 增量 = 0）。

两个内置来源：
- `dsh-fish-memory` → `~/.dsh/fish-memory/*.json`（workspace 模式是单文件 `ws_*.json`）
- `dsh-memory-evolve` → `~/.dsh/memories/*.md`（`\n§\n` 分隔，五轨：memory/key/user/project/daily）

通用能力：任意 Markdown / JSON 记忆文件可按映射纳管；自动发现 `.dsh` 下的新记忆库；未来插件可用 `ctx.memoryTide.registerSource()` 自注册。

明确不做：不碰 billion-context 的压缩块、不碰会话归档（dsh-readprune / archive-manager）、不改 DSH 本体、不注册工具、不自动改其它插件的配置。

## 1. 目录与文件归属（并行开发时每人只碰自己的文件）

```
dsh-memory-tide/
├─ package.json            [lead]
├─ cordis.patch.yml        [lead]
├─ SPEC.md                 [lead]
├─ index.js                [host-api]
├─ client.js               [client-ui]
├─ icon.svg                [client-ui]
├─ locale\zh-CN.json       [client-ui]
├─ locale\en-US.json       [client-ui]
├─ lib\settings.mjs        [core-engine]
├─ lib\store.mjs           [core-engine]
├─ lib\curve.mjs           [core-engine]
├─ lib\match.mjs           [core-engine]
├─ lib\sweep.mjs           [core-engine]
├─ lib\board.mjs           [host-api]
├─ lib\routes.mjs          [host-api]
├─ lib\log.mjs             [host-api]
├─ lib\adapters\registry.mjs  [builtin-adapters]
├─ lib\adapters\fish.mjs      [builtin-adapters]
├─ lib\adapters\evolve.mjs    [builtin-adapters]
├─ lib\adapters\file-md.mjs   [generic-discovery]
├─ lib\adapters\file-json.mjs [generic-discovery]
├─ lib\discovery.mjs          [generic-discovery]
├─ test\curve.test.mjs     [core-engine]
├─ test\match.test.mjs     [core-engine]
├─ test\sweep.test.mjs     [core-engine]
├─ test\fish.test.mjs      [builtin-adapters]
├─ test\evolve.test.mjs    [builtin-adapters]
├─ test\generic.test.mjs   [generic-discovery]
├─ test\discovery.test.mjs [generic-discovery]
├─ test\board.test.mjs     [host-api]
├─ test\routes.test.mjs    [host-api]
├─ docs\DETAIL.md          [lead]
└─ README.md               [lead]
```

## 2. 运行时

- ESM，Node ≥ 22（本机 24.22.3）。Windows 路径。
- 零依赖（只用 node:fs/promises、node:path、node:crypto、node:os）。
- 测试命令（不用 npm）：
  `node --test test/<x>.test.mjs`
- 所有对外函数 async；错误用 `{ok:false,error}` 返回，不抛到事件回调外。
- 注释中英皆可，同文件保持一致。

## 3. 归一化条目 Entry

```js
{
  key: "fish:mmwuora5m101",      // `${adapterId}:${entryId}`，全局唯一，状态与归档都用它
  adapterId: "fish",
  entryId: "mmwuora5m101",
  date: 1795000000000,            // 毫秒时间戳；未知 = null
  dateText: "2026-11-07",         // 展示用；未知 = ""
  text: "条目的完整正文（可多行）",
  tags: ["插件", "习惯"],
  track: "memory",                // evolve 轨名；其它 adapter = null
  raw: "原始条目全文",             // 删除时按它精确匹配（可选）
  path: "C:\\...\\ws_x.json"       // 来源文件（可选）
}
```

正文里不重复存时间戳前缀（evolve 的 `[YYYY-MM-DD]` 已剥离到 `dateText`）。

## 4. 设置（settings.json）

文件：`~/.dsh/memory-tide/settings.json`（`os.homedir()/.dsh/memory-tide/`）。

默认值（`DEFAULTS`，必须完全一致）：

```js
{
  enabled: true,
  dryRun: false,
  curve: { model: "exponential", baseTtlDays: 7, growth: 2.0, survivalFloor: 0.1,
           maxTtlEnabled: true, maxTtlDays: 90, customExpr: "base * (1 + growth * touches)" },
  // model: exponential（默认，艾宾浩斯遗忘曲线/指数衰减）| additive（常数叠加）| custom（自定义函数表达式）
  mentions: { enabled: true, minSharedGrams: 2, protectKeywords: "勿删,待确认,勿动,不要归档,不要删除" },
  archive: { archiveDays: 30, onExpiry: "cold" },   // cold = 归档期满转冷归档（仅手动恢复）；delete = 期满硬删
  sweep: { intervalMinutes: 30, onTurnEnd: true, startupDelaySec: 10 },
  adapters: {
    fish:   { enabled: true,  mode: "archive", maxEntries: 300 },
    evolve: { enabled: true,  mode: "archive",
              tracks: { memory: true, key: true, user: false, project: false, daily: false } }
  },
  customAdapters: [],            // 通用文件映射，见 §7
  standalone: { enabled: true, path: "", format: "md", delimiter: "blank", mode: "archive" },
  // 独立记忆文件：path 留空 = DSH_HOME/memories/memory-tide/MEMORY.md；不依赖任何记忆插件
  discovery: { enabled: true, autoAdoptHighConfidence: false, deny: [] },
  board: { pageSize: 100 }
}
```

`settings.mjs` 导出：
```js
export const DEFAULTS
export function sanitizeSettings(raw) -> {settings, warnings: string[]}
export async function loadSettings() -> {settings, warnings}   // 读盘 + 合并 DEFAULTS + 清洗
export async function saveSettings(patch) -> {settings, warnings} // 深合并 + 清洗 + 原子写
export function settingsPath()
```
规则：数字 clamp 到合理范围（baseTtlDays 0.0007–3650，growth 1–10，maxTtlDays 1–36500，archiveDays 0–36500，intervalMinutes 1–1440，maxEntries 0–100000，minSharedGrams 1–5，pageSize 10–500）；未知键丢弃；非法值回落默认并塞 warnings。

## 5. 状态与归档（store.mjs）

目录：
```
~/.dsh/memory-tide/
├─ settings.json
├─ state.json
├─ archive\hot\<key>.json     // 已归档、可恢复、参与列表
├─ archive\cold\<key>.json    // 冷归档：仅手动恢复，永不被自动删除
├─ backup\<yyyy-mm-ddThh-mm-ss>\<原名>   // 改任何第三方文件前的备份
└─ logs\sweep.log
```

```js
export async function loadState() -> state
export async function saveState(state)            // tmp+rename
export function emptyState() -> {version:1, items:{}, deny:[], lastSweepAt:0, firstSweepDone:false}
// items[key] = { adapterId, entryId, firstSeenAt, lastSeenAt, lastRecalledAt, resetAt,
//                touches, pinned, state: "active"|"archived"|"cold",
//                archivedAt, expiresAt, date, textHash }
export async function backupFile(path) -> backupPath|null  // 文件不存在返回 null；同名去重（同一天只备份一次）
export async function putArchive(entry, tier /* "hot"|"cold" */)  // 写入完整 Entry JSON
// Entry JSON 可带 tombstone（墓碑）：{ v:1, at, actor:"sweep"|"manual",
//   cause:"decay"|"manual"|"legacy", preview, lastActiveAt, idleDays, touches, ttlDays }
// 只有归档时写；适配器恢复时不认识这个字段，不会写回用户的记忆文件。
// 源插件自己的归档（evolve 的 *-archive.md 等）不落盘墓碑，面板按需合成：
//   { v:0, at: entry.date, actor:"source", cause:"source", preview }
export async function readArchive(key) -> entry|null
export async function listArchive(tier) -> entry[]
export async function removeArchive(key)
export async function appendLog(line) -> void       // ISO 时间 + 文本，单文件最多 2000 行，超出裁剪
export async function readLog(lines = 50) -> string[]
```
`key` 含 `:` 在 Windows 文件名里非法 → 归档文件名用 `encodeURIComponent(key)`。

## 6. 曲线与匹配

`curve.mjs`
```js
export function ttlDays(touches, curve)      // model='exponential'（默认）: base*(t*log2(growth)+log2(1/floor))；model='additive': base*growth^t；model='custom': 执行 curve.customExpr（变量 touches/base/growth/floor，另可用数学短名 log/ln/exp/sqrt/pow/abs/min/max/log10/log2/ceil/round 与常量 e/PI），失败回退 exponential；maxTtlEnabled 时 min(..., maxTtlDays)
export function compileCustomExpr(expr)      // 编译并缓存表达式，返回 (touches, base, growth, floor) => days；空/语法错/非正数抛错
export function isValidCustomExpr(expr)      // 用 t=0/1/5 验证表达式能算出正数
export function lastActivity(item)           // max(resetAt, lastRecalledAt, firstSeenAt)
export function isExpired(item, curve, now)  // now >= lastActivity + ttlDays*86400000
export function nextExpiry(item, curve)      // 毫秒时间戳，展示用
```
`touches` 只由「显性提及」增加；被动召回只写 `lastRecalledAt`（暂停倒计时，不加速）。

`match.mjs`
```js
export function normalize(text) -> string                 // 小写、去标点空白
export function grams(text, n) -> Set<string>             // 中文按字符 2-gram；英文按词 2-gram
export function matchMention(userText, entries, { minSharedGrams = 2 } = {}) -> string[] // 命中的 key 列表
```
规则：对每条 entry，取 `text` 的 2-gram 集合；用户消息 2-gram 与它的交集 ≥ minSharedGrams 且交集字符数 ≥ 4 才算命中；`tags` 里任一 tag 原文出现在用户消息里也算命中。纯单字重合不算。空文本 / < 2 字符的消息直接返回 []。

## 7. 适配器契约

每个适配器模块导出工厂：
```js
export function createFishAdapter({ settings, logger }) -> adapter
```

adapter 对象：
```js
{
  id: "fish",                  // 稳定 id；自定义适配器 = custom:<uuid>
  label: "fish-memory",
  kind: "builtin" | "file-md" | "file-json",
  async describe() -> { path, count },              // 给设置页展示
  async list() -> Entry[],                          // 只读；文件不存在返回 []
  async remove(entries) -> { removed: string[], failed: [{key,error}] },  // 硬删，entries 是 Entry[]
  async add(entry) -> { ok: boolean, error?: string } // 恢复用；不支持时不要实现
}
```

`registry.mjs`
```js
export function createRegistry({ settings, getSettings?, logger, loadAdapterModule? }) -> {
  adapters() -> adapter[],           // 内置 + standalone + settings.customAdapters 实例化 + 第三方来源
  get(id) -> adapter | undefined,
  async reload(),                    // 设置变了以后重建
  registerSource(src),               // 第三方自注册；src 需实现 id/label/list/remove
  unregisterSource(id)
}
```

### 7.1 fish
- 读 `~/.dsh/fish-memory/*.json`（workspace 模式就一个文件；session 模式多个，全部纳入）。
- 校验 `version === 2`、`Array.isArray(memories)`；不符 → 跳过该文件并 logger.warn。
- `entryId = memory.id`；`date = createdAt || at`；`tags`；`text`；`raw = JSON.stringify(memory)`。
- 删除：从 `memories` 里过滤掉目标 id，**不要写 deleted[]**；保留其它所有字段。
- 写：`backupFile` → 写同目录 `.tmp-<pid>` → `rename`；写前 `stat` 的 mtime，写完再 stat，若变化则视为冲突：还原备份内容并返回 failed（调用方下轮重试）。
- 文件 mtime 距今 < 2000ms 时 list/remove 都直接跳过（避免和正在写库的插件打架），日志记 `busy`。
- `add(entry)`：往 `memories` push `{id, text, at: entry.date||now, createdAt: entry.date||now, category:"note", importance:0.5, emotion:null, tags: entry.tags||[], source:"memory-tide"}`。
- 尊重 `maxEntries`（0 = 不限）：超出时按 `touches` 升序、`lastActivity` 升序由 sweep 决策，不在 adapter 内做。

### 7.2 evolve
- 目录 `~/.dsh/memories`；文件映射：
  `memory→MEMORY.md`、`user→USER.md`、`key→KEY.md`、`project→PROJECT.md`、`daily→DAILY.md`（不存在的跳过）。
  归档文件 `*-archive.md` 只读、不纳入清理。
- 只处理 `settings.adapters.evolve.tracks[track] === true` 的轨；`user` 默认 false 且设置页标注「永久保护」。
- 解析：`text.split("\n§\n")`，trim，空块跳过；时间戳正则 `/^\[(\d{4}-\d{2}-\d{2})(?:[ T][^\]]*)?\]\s*/`，剥离后进 `text`；`entryId = sha1(raw).slice(0,16)`（同一条目内容稳定）。
- 删除：过滤掉目标块，`serialize = blocks.join("\n§\n") + "\n"`；先做 **drift guard**：`serialize(parse(original)) === original` 不成立就拒写并 failed（说明文件被手工改过）。
- 锁：用 `~/.dsh/memories/.memory.lock`，`withLock` 语义（O_EXCL 创建，5s 超时，stale 10s 强制接管）。
- 写：`backupFile` → tmp+rename。`add(entry)`：在文件末尾追加 `\n§\n` + 原文（若 `raw` 存在用 raw，否则用 `[dateText] ` + text）。
- `list()` 返回五轨里启用的所有条目，`track` 字段标明。

### 7.0 独立记忆文件（standalone）
不装任何记忆插件时，潮汐自己也能当记忆库：
- `settings.standalone = { enabled, path, format: "md", delimiter: "blank", mode: "archive" }`。
- `path` 留空 → `DSH_HOME/memories/memory-tide/MEMORY.md`（DSH_HOME 未设则 `~/.dsh`）。
- reload 时若 `enabled !== false`，在 customAdapters 之前插入 `{ id: "standalone", type: "file-md", label: "独立记忆文件", path, mode, format: { delimiter } }`，随后走 file-md 适配器。
- 路径/分隔符可改；`mode` 为 `delete` 时归档期满直接删，为 `archive`（默认）时进热归档。sweep 按 `settings.standalone.mode` 决定，不读 `adapters` 段。

### 7.3 通用 file-md
settings.customAdapters 项：
```js
{ id: "custom:xxx", type: "file-md", label: "我的笔记", path: "C:\\...\\mem.md", mode: "archive",
  format: { delimiter: "\n§\n", dateRegex: "^\\[(\\d{4}-\\d{2}-\\d{2})\\]\\s*", encoding: "utf8" } }
```
- 按 `delimiter` 切片（`delimiter: "blank"` 表示按空行分段）；每段 trim，空段跳过。
- `dateRegex` 匹配段首；第一个捕获组是日期 → `date`。不匹配则 `date = null`。
- `entryId = sha1(raw).slice(0,16)`。
- 删除：保留非目标段，用原 delimiter 重新 join；文件末尾换行保持原样（记录原文件是否以换行结尾）。
- `add`：追加 delimiter + raw。
- 只允许删除整段，绝不编辑段内字符。

### 7.4 通用 file-json
```js
{ id: "custom:yyy", type: "file-json", label: "某插件库", path: "C:\\...\\store.json", mode: "archive",
  format: { listPath: "memories", textField: "text", timeFields: ["createdAt","at"], idField: "id",
            indent: 2, tagsField: "tags" } }
```
- `listPath` 用 `.` 分割取数组；数组元素可以是对象或字符串（字符串则 text 就是它，id=sha1）。
- 删除：从数组过滤 → `JSON.stringify(root, null, indent)` + 尾部换行（保持原文件是否换行）。
- JSON 解析失败 / 路径不存在 → `{ok:false}`，不写。
- `indent` 未给时探测：原文件用 tab 则 `"\t"`，否则取第一层缩进空格数（2/4）。

### 7.5 自动发现 discovery.mjs
```js
export async function scan({ settings, logger, roots } = {}) -> {
  found: [{
    path, kind: "fish"|"evolve"|"file-md"|"file-json"|"unknown",
    confidence: 0..1, count, preview: [string], reason,
    suggested: { type, format } | null
  }],
  skipped: [{ path, reason }]
}
```
- 默认 roots：`~/.dsh` 递归，深度 ≤ 4，跳过 `node_modules`、`backup`、`archive`、`billion-context`、`profiles`、`attachments`、`storages`、`sessions`、`logs`、`.git`。
- 只收 `.json` / `.md`，大小 ≤ 2MB，mtime ≤ 180 天。
- 排除：`settings.json`、`*.lock`、`package.json`、`*.bak*`。
- 识别：
  - JSON 且 `version===2 && Array.isArray(memories)` → fish，confidence 0.95
  - MD 且含 `\n§\n` → evolve，confidence 0.9
  - MD 分段后 ≥30% 段带 `[YYYY-MM-DD]` 日期 → file-md，confidence 0.6
  - JSON 数组且 ≥50% 元素有 text/content/memo 字段且至少一个时间字段 → file-json，confidence 0.6
  - 其它 → unknown（不纳管）
- preview 取前 3 条正文，各截 80 字。
- `deny` 里的路径（前缀匹配）直接跳过。

## 8. 清扫 sweep.mjs

```js
export async function sweep({ registry, state, settings, logger, now = Date.now(), dryRun = false }) -> report
// report = { at, dryRun, adapters: [{ id, checked, expired, archived, cooled, deleted, failed }], warnings: [] }
```
流程：
1. `registry.adapters()`，跳过 `!settings.adapters[id]?.enabled`（自定义适配器默认 enabled）。
2. `adapter.list()` 得到 entries。
3. 逐条：
   - 从 state 取或初始化 item（firstSeenAt=now），更新 lastSeenAt/date/textHash；
   - `pinned` / `state==='cold'` 跳过；
   - 文本命中 `mentions.protectKeywords`（逗号分隔，任一子串）→ 跳过；
   - `isExpired` 才处理：
     - `mode==='delete'` → `adapter.remove([entry])`；成功则删 state item；
     - `mode==='archive'` 且 `state==='active'` → `putArchive(entry,'hot')` + `adapter.remove([entry])`；成功则 item.state='archived', archivedAt=now, expiresAt=now+archiveDays*86400000；
     - `state==='archived'` 且 `now>=expiresAt` → `settings.archive.onExpiry==='cold'`：`putArchive(entry,'cold')` + `removeArchive(key)`（hot）+ item.state='cold'；`==='delete'`：删 hot 归档 + 删 item（若 adapter 里还在就再 remove 一次）。
4. 每适配器结束写一条日志；`dryRun` 只统计不改盘、不改 state。
5. 整个 sweep 串行（不要并行），避免同时写同一文件。

硬上限：`maxEntries > 0` 且某适配器活跃条目数超出时，按「touches 少 → lastActivity 旧」排序，把超出的部分走与到期相同的处理（archive/delete）。

## 9. 宿主插件 index.js / routes.mjs / board.mjs / log.mjs

`index.js`：
```js
export const name = 'dsh-memory-tide'
export const inject = ['webServer']            // 可选；没有 webServer 时插件仍跑清扫
export function apply(ctx, config) { ... }
```
- 启动：`loadSettings()` → `createRegistry` → `loadState` → `registerRoutes(ctx, deps)`。
- `ctx.on('agent/pre-step', handler)`：取 `payload.messages` 最后一条 user 消息的纯文本；`matchMention` 命中 → 对每条 item：`touches++`、`resetAt=now`、`lastRecalledAt=now`；保存 state（节流：最多 1 次/2 秒）。
- `ctx.on('agent/turn-stopping', handler)`：若 `settings.sweep.onTurnEnd`，debounce 3 秒后，若 `now-lastSweepAt >= intervalMinutes` 则跑 sweep。
- 定时：`ctx.effect(() => { const t=setInterval(...); return ()=>clearInterval(t) }, 'dsh-memory-tide: sweeper')`，启动 `startupDelaySec` 后首扫。
- 首次清扫：`state.firstSweepDone === false` → 以 `dryRun=true` 跑一次，写日志 + report 存内存给页面，然后置 true（第二次起真删）。
- 服务：`ctx.provide('memoryTide', { registerSource, unregisterSource, sweep: () => 立即清扫 })`（若 provide 不可用，退化为 `ctx.set('memoryTide', ...)`；用 try/catch）。
- 退出：`ctx.effect(() => () => { /* flush state */ })`。

`log.mjs`：`createLogger(prefix)` 返回 `{info,warn,error}`，内部 `appendLog`，失败静默。

`board.mjs`：
```js
export async function listEntries({ registry, state, settings, query = {} })
// query: { state: "active"|"archived"|"cold"|"all", adapter, q, page=1, pageSize }
// 返回 { total, page, pageSize, rows: [{ key, adapterId, adapterLabel, entryId, date, dateText,
//          text, tags, track, state, pinned, expiresAt, touches, source: "live"|"archive",
//          tombstone: { cause: "decay"|"manual"|"legacy", preview, at, idleDays, ttlDays, ... } | null }] }
export async function act({ registry, state, settings, op, keys })
// op: "archive" | "delete" | "restore" | "pin" | "unpin"
// 返回 { results: [{ key, ok, error }] }
```
- live 条目从 adapter.list() 取（只读，不写）；archived/cold 从 state + archive 读。
- 排序：date 降序，null 排最后；同日期按 key。
- `q`：对 text/tags 子串匹配（大小写不敏感）。
- 手动操作语义：不检查保护词/曲线；`delete` 直接硬删（先 backup，再 adapter.remove，再删 state/归档）；`archive` 立即归档（hot）；`restore`：从 hot/cold 读 Entry，`adapter.add(entry)` 成功后删除归档、item.state='active'、touches 不变、resetAt=now；`pin`/`unpin` 改 item.pinned。

`routes.mjs`：
```js
export function registerRoutes(ctx, deps)
// deps = { settings, registry, state, stateRepo, sweep, scan, board, logger, paths }
```
用 `ctx.inject(['webServer'], (webCtx) => { webCtx.effect(() => webCtx.webServer.register({ kind:'prefix', path:'/memory-tide', handler })) })`。
统一响应 `{ ok:true, data }` / `{ ok:false, error }`，JSON UTF-8；只允许 GET/POST；其它 405。

| 方法 | 路径 | 入参 | 出参 |
|---|---|---|---|
| GET | /memory-tide/api/state | – | `{ settings, stats:{active,archived,cold}, adapters:[{id,label,path,count,enabled}], lastSweepAt, firstSweepDone, firstRunReport }` |
| POST | /memory-tide/api/settings | `{patch}` | `{settings, warnings}` |
| GET | /memory-tide/api/entries | `state,adapter,q,page,pageSize` | board.listEntries 结果 |
| POST | /memory-tide/api/action | `{op, keys}` | `{results}` |
| POST | /memory-tide/api/sweep | `{dryRun}` | `{report}` |
| POST | /memory-tide/api/scan | – | `{found, skipped}` |
| POST | /memory-tide/api/adopt | `{adapter}` 或 `{deny:[path]}` | `{settings}` |
| GET | /memory-tide/api/log | `lines` | `{lines}` |

## 10. 客户端 client.js

IIFE，`window.__ModuleLoader__.load({ id:'dsh-memory-tide', factory(require){ ... } })`，返回：
```js
{ inject: ['slots'],
  apply(ctx) {
    ctx.slots.inject('settings.section', () => ctx.slots.register(
      { name: 'settings.section', id: 'memory-tide', order: 52, label: () => '记忆潮汐' },
      SettingsPage
    ))
  } }
```
页面（无框架，原生 DOM + `h()`；`maxWidth: 860`；CSS 用 `--dsh-border/--dsh-accent/--dsh-text` 等变量，样式用 `<style>` 注入一次）：

两个页签：
1. **记忆**（默认，仿 memory-evolve 的 pretty 卡片）
   - 工具条：搜索框、状态筛选 chips（全部/活跃/热归档/冷归档/已置顶）、来源下拉、刷新、「扫描新记忆库」。
   - 分组：今天 / 昨天 / 本周 / 更早 / 日期未知；卡片 = 勾选框 + 日期徽章 + 来源徽章 + 到期倒计时（x 天后 / 已到期 / 无上限 / 冷归档）+ 正文（2 行截断，点击展开）+ 墓碑一行（归档条目：为什么被收走 + 讲的是哪句）+ 标签 + 单条按钮（置顶/归档/删除/恢复）。
   - 底部浮条：已选 N 条 → 归档 / 删除 / 置顶 / 取消；删除弹确认（写明条数与来源）。
   - 分页 100/页，滚到底「加载更多」；空态、加载中、错误 toast。
2. **设置**
   - 总开关 / 演练开关 / 曲线（模型三选一：艾宾浩斯遗忘曲线（指数衰减）/常数叠加/自定义函数；自定义时显示表达式输入、可用数学短名（log/ln/exp/sqrt/pow/abs/min/max/log10/log2/ceil/round、常量 e/PI）提示与 0/1/3/10 次提及的天数预览；3 个数字 + 上限开关；关闭上限时提示 growth^n 可能很大）/ 归档（archiveDays + onExpiry 单选：冷归档仅手动恢复 / 直接删除）/ 独立记忆文件（开关、路径、分隔符、清理方式）/ 清扫间隔 / 首次演练状态。
   - 适配器卡片：fish、evolve（五个轨的勾选；project/daily 勾选时显示红色警告：「这两轨是每回合写入的日志，增长快，清理后调试线索会丢」）、自定义适配器列表（新增/删除/测试）。
   - 发现：扫描结果表，每行 启用 / 忽略。
   - 日志：最近 50 行 `<pre>`。
   - 所有保存走 POST settings，保存后顶部提示「已生效」。

locale：`zh-CN.json` / `en-US.json` 至少覆盖所有可见文案；页面读取 `t('...')`，缺 key 回中文。

icon.svg：单色鲸尾/潮汐，24×24，`currentColor`。

## 11. 测试要求

- 每个模块至少覆盖 SPEC 里的边界：上限关闭、growth=1、base=0、空库、缺文件、schema 不符、drift guard、mtime 冲突、批量删除后其它字节不变、发现器 6 类样例、board 分页与排序。
- 测试全部用 `fs.mkdtemp(os.tmpdir())` 造数据，**绝不写真实库**。
- 测试里不要 import `index.js`（它要宿主），routes 用假 ctx（`{ inject(fn){ fn({ effect(fn){fn()}, webServer:{ register(){} } }) } }`）测路由分发表即可。

## 12. 验收清单（lead 最后跑）

1. `node --test test/*.test.mjs` 全绿。
2. 复制真实 fish 库与 memories 目录到 tmp，跑 sweep（dryRun=false）：到期条目消失，其它条目逐字节不变，插件再读仍正常。
3. 启动 DSH → 设置里出现「记忆潮汐」→ 记忆页能列条目、勾选删除/归档、设置页能改参数并即时生效。
4. `cordis_inspect` 确认没有新增 tool；systemPrompt 无新增注入。
5. 把 baseTtlDays 设 0.001、归档 onExpiry=cold，造一条测试记忆 → 2 分钟后自动进归档；再过 archiveDays=0.0007 → 进冷归档；手动恢复能回来。
