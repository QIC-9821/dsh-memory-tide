# 实现细节

这份文档写给想改代码或接新记忆库的人；对外行为以 [README](../README.md) 为准，字段契约以 [SPEC.md](../SPEC.md) 为准。

## 生命周期

1. **加载**（`index.js`）：注册 `memoryTide` 服务、挂 `/memory-tide/api` 路由、listen `agent/pre-step` 与 `agent/turn-stopping`。
2. **pre-step**：把用户消息里出现的记忆原文做 n-gram 匹配（`lib/match.mjs`），命中的条目记一次 `touch`，重置倒计时，并按 `growth^n` 拉长下次期限。
3. **turn-stopping / 定时器**：触发 `sweep`（`lib/sweep.mjs`），串行跑所有适配器，先算到期，再按设置归档或删除。
4. **写入**：所有删除/归档都由适配器做，插件只传 `key`；删前先写 `archive/hot` 或 `archive/cold`，再调用适配器自己的写函数。

## 模块

| 文件 | 职责 |
|---|---|
| `lib/settings.mjs` | 默认值、白名单清洗、原子写、`DSH_MEMORY_TIDE_HOME` 隔离 |
| `lib/store.mjs` | state.json、hot/cold 归档、改动前备份 |
| `lib/curve.mjs` | 两种曲线：指数衰减（默认，`S = 2^(-t/base)`，提及 ×growth，低于 survivalFloor 到期，`ttl = base × (touches·log2(growth) + log2(1/floor))`）与常数叠加（`ttl = base × growth^touches`）；上限可关 |
| `lib/match.mjs` | 提到检测：字符 n-gram、共享 gram 阈值、保护词 |
| `lib/sweep.mjs` | 一轮清扫：重复整合（可选）→ 到期判断、归档、冷却、删除、失败回滚 |
| `lib/merge.mjs` | 近似重复聚类（Dice 2-gram）、保留/改写方案、写盘与回退 |
| `lib/reconcile.mjs` | 按最新日期改写：时间槽替换、前置条件补充、合并日期标记 |
| `lib/board.mjs` | 记忆列表、单条/批量操作、分页过滤 |
| `lib/routes.mjs` | 9 个 HTTP 端点（含 `POST /merge`），统一 `{ok:false,error}` |
| `lib/adapters/*.mjs` | fish / evolve / file-md / file-json，统一 `list/remove/add/update` |
| `lib/discovery.mjs` | 扫 `~/.dsh` 找新记忆库，只读预览 |

## 适配器契约

```js
{
  id, label,
  async list(): Entry[],
  async remove(entries): { removed: string[], failed: [{key, error}] },
  async add(entry): { ok: boolean, error?: string },
  // 可选：源插件自己的归档
  async listArchived?(): Entry[],
  async unarchive?(entry): { ok: boolean, error?: string },
}
```

`Entry` 必备字段：`key`、`adapterId`、`entryId`、`text`、`date`、`raw`；可选 `file`、`track`、`tags`、`dateText`。

- **fish**：读 `~/.dsh/fish-memory/*.json`，写前比对 mtime；不写 `deleted[]` 墓碑；恢复时复用原 `entryId`。
- **evolve**：按真实布局 `MEMORY.md` / `USER.md` / `projects/<hash>/KEY.md` / `projects/<hash>/MEMORY.md` / `daily/YYYY-MM-DD.md`；写前用它的 `.memory.lock`，drift guard 失败就拒绝覆盖；自动清扫忽略 `*-archive.md`、`*.bak*`、`TODOS.md`；`listArchived` 单独读 `*-archive.md`（同文去重、含已关闭轨），`unarchive` 把条目搬回活文件。
- **file-md / file-json**：设置页配置路径、分隔符、日期正则、列表路径；只整段删，保留其余字节和换行风格。

## 安全不变量

- 首次 sweep 只演练（`firstSweepDone=false` 时强制 `dryRun`），第二次起才真实改动。
- 每条改动前备份到 `~/.dsh/memory-tide/backup/<时间戳>/`。
- 文件被外部改过（mtime / drift guard 不符）→ 跳过本次，不猜、不合并。
- 置顶（pinned）与保护词命中的条目不参与自动删除。
- 删除失败时回滚刚写的 hot 归档，保证「要么删掉、要么原样」。

## 测试

```bash
node --test test/*.test.mjs
```

107 个用例，覆盖曲线、匹配、清扫、四个适配器（含源归档列出与恢复）、发现、面板与路由。适配器测试都在 `mkdtemp` 里造数据，不碰真实记忆；`DSH_FISH_STORE_SAMPLE` 指向真实 fish 库时会额外跑一条只读冒烟。
