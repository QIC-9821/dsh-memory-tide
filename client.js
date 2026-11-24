/* dsh-memory-tide · 设置区页面（记忆潮汐）
 *
 * 页面全部用原生 DOM 构建（本文件里的 h() 是自己的小工具，不依赖任何 UI 框架），
 * 只在最外层用宿主的 React 做一次「挂载适配」：settings.section 的渲染器是 React，
 * 它需要一个组件函数；这个组件只创建一个宿主 div 并把 DOM 树挂进去。
 * 如果宿主没有 react 模块，页面渲染为空 —— 见 README/docs 的说明。
 */
(function () {
  'use strict'

  const SELF = (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) || ''
  if (typeof window === 'undefined' || !window.__ModuleLoader__) return

  window.__ModuleLoader__.load({
    id: 'dsh-memory-tide',
    factory(require) {
      /* eslint-disable no-var */
      const API = '/memory-tide/api'
      const STYLE_ID = 'dsh-memory-tide-style'
      const DAY = 86400000

      /* ------------------------------------------------------------------ 文案 */
      const ZH = {
        'app.title': '记忆潮汐',
        'app.subtitle': '按遗忘曲线，把长期没人提的记忆归档、清理。',
        'tab.memories': '记忆',
        'tab.settings': '设置',
        'search.placeholder': '搜索正文或标签',
        'source.all': '全部来源',
        'btn.refresh': '刷新',
        'btn.scan': '扫描新记忆库',
        'btn.save': '保存',
        'btn.more': '加载更多',
        'btn.retry': '重试',
        'btn.cancel': '取消',
        'btn.add': '添加',
        'btn.remove': '删除',
        'btn.test': '测试',
        'btn.refreshLog': '刷新日志',
        'btn.enable': '启用',
        'btn.ignore': '忽略',
        'filter.all': '全部',
        'filter.active': '活跃',
        'filter.archived': '已归档',
        'filter.cold': '冷归档',
        'filter.pinned': '已置顶',
        'stats.line': '活跃 {active} · 已归档 {archived} · 冷归档 {cold}',
        'group.today': '今天',
        'group.yesterday': '昨天',
        'group.week': '本周',
        'group.earlier': '更早',
        'group.unknown': '日期未知',
        'badge.pinned': '置顶',
        'track.memory': '长期记忆',
        'track.key': '关键事实',
        'track.user': '用户档案',
        'track.project': '项目记忆',
        'track.daily': '日常日志',
        'ttl.days': '{n} 天后',
        'ttl.expired': '已到期',
        'ttl.never': '无上限',
        'ttl.cold': '冷归档',
        'ttl.archiveLeft': '{n} 天后转冷',
        'ttl.archiveLeftDelete': '{n} 天后删除',
        'ttl.archiveExpired': '已到归档期限',
        'op.pin': '置顶',
        'op.unpin': '取消置顶',
        'op.archive': '归档',
        'op.restore': '恢复',
        'op.delete': '删除',
        'list.loading': '加载中…',
        'list.empty': '这里还没有记忆条目',
        'list.emptyHint': '换个筛选条件，或者点「扫描新记忆库」看看有没有新库。',
        'list.total': '共 {n} 条',
        'list.loaded': '已加载 {n} / {total}',
        'bulk.selected': '已选 {n} 条',
        'confirm.deleteOne': '确定删除这条记忆吗？\n{label}\n删除前会备份到 ~/.dsh/memory-tide/backup/。',
        'confirm.deleteBulk': '确定删除 {n} 条记忆吗？\n来源：{sources}\n删除前会备份到 ~/.dsh/memory-tide/backup/。',
        'toast.op.archive': '已归档 {n} 条',
        'toast.op.delete': '已删除 {n} 条',
        'toast.op.restore': '已恢复 {n} 条',
        'toast.op.pin': '已置顶 {n} 条',
        'toast.op.unpin': '已取消置顶 {n} 条',
        'toast.saved': '已生效',
        'toast.scanned': '扫描完成：发现 {n} 个新记忆库',
        'toast.noNew': '没有发现新的记忆库',
        'toast.loadFailed': '加载失败',
        'toast.actionFailed': '操作失败',
        'toast.adopted': '已纳管',
        'toast.denied': '已忽略这个路径',
        'toast.tested': '可读取 {n} 条',
        'toast.needPath': '请先填写文件路径',
        'toast.added': '已加入列表，记得保存',
        'toast.warn': '提示',
        'set.title': '设置',
        'set.dirty': '有未保存的修改',
        'set.saved': '已生效',
        'set.enabled': '启用记忆潮汐',
        'set.enabledHint': '关闭后不再自动清扫，页面里的手动操作仍然可用。',
        'set.dryRun': '演练模式（只统计，不删）',
        'set.dryRunHint': '打开后清扫只写日志和统计，不动任何文件。',
        'set.curve': '遗忘曲线',
        'set.curveHint': 'TTL = 基础天数 × 增长倍数^n，n 是显性提及次数。',
        'set.base': '基础 TTL（天）',
        'set.growth': '增长倍数',
        'set.maxTtl': '启用 TTL 上限',
        'set.maxDays': '上限（天）',
        'set.maxOffWarn': '关闭上限后 TTL = 基础 × 增长^n 会随提及次数迅速变大，可能出现极长的过期时间。',
        'set.archive': '归档',
        'set.archiveDays': '归档保留（天）',
        'set.onExpiry': '归档期满后',
        'set.onExpiryCold': '转冷归档（仅手动恢复）',
        'set.onExpiryDelete': '直接删除',
        'set.sweep': '清扫',
        'set.interval': '清扫间隔（分钟）',
        'set.onTurnEnd': '每回合结束时也检查',
        'set.status': '状态',
        'set.firstSweep': '首次演练',
        'set.done': '已完成',
        'set.pending': '尚未执行',
        'set.lastSweep': '上次清扫',
        'set.never': '从未',
        'set.sources': '记忆来源',
        'set.mode': '清理方式',
        'set.modeArchive': '归档（可恢复）',
        'set.modeDelete': '直接删除',
        'set.maxEntries': '活跃条目上限（0 = 不限）',
        'set.tracks': '纳管轨道',
        'set.trackProtected': '永久保护',
        'set.evolveWarn': '这两轨是每回合写入的日志，增长快，清理后调试线索会丢。',
        'set.count': '{n} 条',
        'set.path': '路径',
        'set.custom': '自定义适配器',
        'set.customEmpty': '还没有自定义适配器。用下面的表单可以把任意 Markdown / JSON 记忆文件纳管。',
        'set.customAdd': '新增适配器',
        'set.customType': '类型',
        'set.label': '名称',
        'set.filePath': '文件路径',
        'set.format': '解析格式',
        'fmt.delimiter': '分段分隔符',
        'fmt.delimiterHint': '留空表示按空行分段；也可以直接写 \\n§\\n。',
        'fmt.dateRegex': '日期正则',
        'fmt.encoding': '编码',
        'fmt.listPath': '数组路径（a.b）',
        'fmt.textField': '正文字段',
        'fmt.idField': 'id 字段',
        'fmt.timeFields': '时间字段（逗号分隔）',
        'fmt.indent': '缩进',
        'fmt.tagsField': '标签字段',
        'set.discovery': '自动发现',
        'set.discoveryHint': '扫描 ~/.dsh 下的 Markdown / JSON 记忆文件，识别后可一键纳管。',
        'set.discEnabled': '扫描 ~/.dsh 下的新记忆库',
        'set.autoAdopt': '高置信度自动纳管',
        'set.found': '发现结果',
        'set.noFound': '没有发现新记忆库。',
        'set.skipped': '跳过 {n} 个文件',
        'set.confidence': '置信度',
        'set.log': '最近日志',
        'set.logEmpty': '还没有日志。',
      }

      let DICT = ZH

      function t(key, vars) {
        let text = Object.prototype.hasOwnProperty.call(DICT, key) ? DICT[key] : undefined
        if (text === undefined && Object.prototype.hasOwnProperty.call(ZH, key)) text = ZH[key]
        if (text === undefined) return key
        if (vars) {
          text = String(text).replace(/\{(\w+)\}/g, function (match, name) {
            return vars[name] === undefined || vars[name] === null ? match : String(vars[name])
          })
        }
        return text
      }

      function hasKey(key) {
        return Object.prototype.hasOwnProperty.call(DICT, key) || Object.prototype.hasOwnProperty.call(ZH, key)
      }

      function localeCode() {
        const raw = String(
          (typeof document !== 'undefined' && document.documentElement && document.documentElement.lang) ||
            (typeof navigator !== 'undefined' && navigator.language) ||
            'zh',
        )
        return /^zh/i.test(raw) ? 'zh-CN' : 'en-US'
      }

      /* 语言文件是尽力而为：拿不到就用内置中文，页面永不空。 */
      async function loadLocale() {
        const code = localeCode()
        if (code === 'zh-CN') return false
        const candidates = []
        if (SELF) {
          try { candidates.push(new URL('locale/' + code + '.json', SELF).toString()) } catch (error) { /* ignore */ }
          try { candidates.push(new URL('../locale/' + code + '.json', SELF).toString()) } catch (error) { /* ignore */ }
        }
        candidates.push('/plugins/dsh-memory-tide/locale/' + code + '.json')
        for (const url of candidates) {
          try {
            const response = await fetch(url)
            if (!response.ok) continue
            const data = await response.json()
            if (data && typeof data === 'object') {
              DICT = Object.assign({}, ZH, data)
              return true
            }
          } catch (error) { /* try next */ }
        }
        return false
      }

      /* ------------------------------------------------------------ DOM 小工具 */
      const SVG = 'http://www.w3.org/2000/svg'
      const SVG_TAGS = { svg: 1, path: 1, circle: 1, g: 1, line: 1, rect: 1 }

      function applyProps(el, props) {
        if (!props) return
        for (const key in props) {
          if (!Object.prototype.hasOwnProperty.call(props, key)) continue
          const value = props[key]
          if (value === undefined || value === null || value === false) continue
          if (key === 'class' || key === 'className') el.setAttribute('class', String(value))
          else if (key === 'text') el.textContent = String(value)
          else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value)
          else if (key === 'dataset' && typeof value === 'object') {
            for (const dataKey in value) if (value[dataKey] !== undefined) el.dataset[dataKey] = String(value[dataKey])
          } else if (key === 'attrs' && typeof value === 'object') {
            for (const attr in value) {
              if (value[attr] === undefined || value[attr] === null) continue
              el.setAttribute(attr, String(value[attr]))
            }
          } else if (key.length > 2 && key.slice(0, 2) === 'on' && typeof value === 'function') {
            el.addEventListener(key.slice(2).toLowerCase(), value)
          } else if (key === 'value') el.value = value
          else if (key === 'checked' || key === 'disabled' || key === 'selected' || key === 'hidden') el[key] = Boolean(value)
          else el.setAttribute(key, value === true ? '' : String(value))
        }
      }

      function append(el, children) {
        if (children === undefined || children === null || children === false) return
        if (Array.isArray(children)) {
          for (const child of children) append(el, child)
          return
        }
        el.appendChild(children instanceof Node ? children : document.createTextNode(String(children)))
      }

      function h(tag, props, children) {
        const el = SVG_TAGS[tag] ? document.createElementNS(SVG, tag) : document.createElement(tag)
        applyProps(el, props)
        append(el, children)
        return el
      }

      function clear(el) {
        while (el.firstChild) el.removeChild(el.firstChild)
      }

      function replace(el, children) {
        clear(el)
        append(el, children)
      }

      function button(label, onclick, options) {
        const opts = options || {}
        const cls = 'mt-btn' + (opts.primary ? ' primary' : '') + (opts.danger ? ' danger' : '') + (opts.small ? ' small' : '')
        return h('button', { class: cls, type: 'button', text: label, onclick: onclick, disabled: opts.disabled })
      }

      /* ------------------------------------------------------------------ 样式 */
      const CSS = `
.mt-root{max-width:860px;margin:0 auto;padding:2px 0 32px;color:var(--dsh-text,inherit);font-size:13.5px;line-height:1.55}
.mt-root [hidden]{display:none!important}
.mt-root *,.mt-root *::before,.mt-root *::after{box-sizing:border-box}
.mt-title-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.mt-title{font-size:17px;font-weight:650;letter-spacing:.2px}
.mt-sub{font-size:12.5px;opacity:.62}
.mt-tabs{display:flex;gap:4px;margin:12px 0 14px;border-bottom:1px solid var(--dsh-border,rgba(127,127,127,.22))}
.mt-tab{appearance:none;border:0;background:transparent;color:inherit;font:inherit;padding:7px 12px 9px;cursor:pointer;opacity:.62;border-bottom:2px solid transparent;margin-bottom:-1px;border-radius:7px 7px 0 0}
.mt-tab:hover{opacity:.9;background:rgba(127,127,127,.08)}
.mt-tab.on{opacity:1;font-weight:600;border-bottom-color:var(--dsh-accent,#4f8cff)}
.mt-tab em{font-style:normal;font-size:11px;opacity:.6;margin-left:6px}
.mt-toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:9px}
.mt-search,.mt-input,.mt-select{font:inherit;color:inherit;padding:7px 10px;border-radius:9px;border:1px solid var(--dsh-border,rgba(127,127,127,.32));background:var(--dsh-surface,rgba(127,127,127,.05))}
.mt-search{flex:1 1 220px;min-width:150px}
.mt-select{padding:7px 8px}
.mt-search:focus,.mt-input:focus,.mt-select:focus{outline:none;border-color:var(--dsh-accent,#4f8cff);box-shadow:0 0 0 3px rgba(79,140,255,.16)}
.mt-chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:12px}
.mt-chip{appearance:none;font:inherit;font-size:12.5px;color:inherit;padding:4px 11px;border-radius:999px;cursor:pointer;border:1px solid var(--dsh-border,rgba(127,127,127,.3));background:transparent;opacity:.78}
.mt-chip:hover{opacity:1}
.mt-chip.on{opacity:1;font-weight:600;border-color:var(--dsh-accent,#4f8cff);background:rgba(79,140,255,.14)}
.mt-stats{margin-left:auto;font-size:12px;opacity:.6}
.mt-group{display:flex;align-items:center;gap:8px;margin:16px 0 8px;font-size:12px;letter-spacing:.4px;text-transform:uppercase;opacity:.75}
.mt-group::after{content:'';flex:1;height:1px;background:var(--dsh-border,rgba(127,127,127,.2))}
.mt-group em{font-style:normal;opacity:.65}
.mt-card{border:1px solid var(--dsh-border,rgba(127,127,127,.26));border-radius:12px;padding:10px 12px;margin-bottom:8px;background:var(--dsh-surface,rgba(127,127,127,.04))}
.mt-card:hover{border-color:var(--dsh-border,rgba(127,127,127,.45))}
.mt-card-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.mt-spacer{flex:1}
.mt-badge{font-size:11.5px;padding:1px 7px;border-radius:6px;border:1px solid var(--dsh-border,rgba(127,127,127,.28));opacity:.85;white-space:nowrap}
.mt-date{font-variant-numeric:tabular-nums;opacity:.95}
.mt-track{opacity:.7}
.mt-pin{border-color:rgba(79,140,255,.5);color:var(--dsh-accent,#4f8cff)}
.mt-count{font-size:12px;white-space:nowrap;font-variant-numeric:tabular-nums}
.mt-count.ok{opacity:.7}
.mt-count.warn{color:#e0a63c}
.mt-count.expired{color:#e05b5b}
.mt-count.cold{opacity:.6}
.mt-count.muted{opacity:.55}
.mt-text{margin:7px 0 6px;white-space:pre-wrap;word-break:break-word;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;cursor:pointer;opacity:.92}
.mt-text.open{display:block;-webkit-line-clamp:unset;overflow:visible}
.mt-card-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mt-tags{display:flex;gap:5px;flex-wrap:wrap;flex:1}
.mt-tag{font-size:11.5px;opacity:.7;padding:0 6px;border-radius:5px;background:rgba(127,127,127,.12)}
.mt-actions{display:flex;gap:6px;flex-wrap:wrap}
.mt-btn{appearance:none;font:inherit;font-size:12.5px;color:inherit;padding:5px 11px;border-radius:8px;cursor:pointer;border:1px solid var(--dsh-border,rgba(127,127,127,.35));background:transparent}
.mt-btn:hover{background:rgba(127,127,127,.1)}
.mt-btn:disabled{opacity:.45;cursor:default}
.mt-btn.small{padding:2px 8px;font-size:12px}
.mt-btn.primary{background:var(--dsh-accent,#4f8cff);border-color:var(--dsh-accent,#4f8cff);color:#fff}
.mt-btn.primary:hover{filter:brightness(1.06);background:var(--dsh-accent,#4f8cff)}
.mt-btn.danger{color:#e05b5b;border-color:rgba(224,91,91,.5)}
.mt-btn.danger:hover{background:rgba(224,91,91,.12)}
.mt-pager{display:flex;align-items:center;justify-content:center;gap:10px;margin:14px 0 4px;font-size:12.5px;opacity:.8}
.mt-empty{margin:26px 0;padding:24px 16px;text-align:center;border:1px dashed var(--dsh-border,rgba(127,127,127,.32));border-radius:14px}
.mt-empty b{display:block;font-size:14px;margin-bottom:4px}
.mt-empty span{opacity:.62;font-size:12.5px}
.mt-error{margin:16px 0;padding:12px 14px;border-radius:10px;border:1px solid rgba(224,91,91,.45);background:rgba(224,91,91,.08);font-size:12.5px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.mt-hint-block{padding:16px;text-align:center;opacity:.65;font-size:12.5px}
.mt-bulk{position:sticky;bottom:8px;margin-top:12px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:9px 12px;border-radius:12px;border:1px solid var(--dsh-border,rgba(127,127,127,.3));background:var(--dsh-surface,rgba(32,32,32,.92));box-shadow:0 6px 22px rgba(0,0,0,.22);backdrop-filter:blur(8px);font-size:12.5px}
.mt-bulk .mt-spacer{flex:1}
.mt-set-head{display:flex;align-items:center;gap:10px;margin:0 0 12px}
.mt-set-head .mt-spacer{flex:1}
.mt-dirty{font-size:11.5px;opacity:.62}
.mt-saved{font-size:11.5px;color:#2fa36b;opacity:0;transition:opacity .2s}
.mt-saved.on{opacity:1}
.mt-card-block{border:1px solid var(--dsh-border,rgba(127,127,127,.26));border-radius:12px;padding:13px 15px;margin-bottom:12px;background:var(--dsh-surface,rgba(127,127,127,.03))}
.mt-card-title{margin:0 0 3px;font-size:13.5px;font-weight:650}
.mt-card-hint{font-size:12px;opacity:.6;margin-bottom:10px}
.mt-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px}
.mt-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.mt-label{font-size:12px;opacity:.72}
.mt-hint{font-size:11.5px;opacity:.55}
.mt-check-row{display:flex;align-items:center;gap:8px;padding:3px 0;cursor:pointer;font-size:13px}
.mt-check-row input{margin:0;width:15px;height:15px;cursor:pointer}
.mt-check-row .mt-hint{margin-left:6px}
.mt-radios{display:flex;flex-wrap:wrap;gap:14px;padding-top:2px}
.mt-radio{display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer}
.mt-warn{margin-top:8px;padding:7px 10px;border-radius:8px;font-size:12px;color:#e05b5b;background:rgba(224,91,91,.1);border:1px solid rgba(224,91,91,.35)}
.mt-adapter{border:1px solid var(--dsh-border,rgba(127,127,127,.22));border-radius:10px;padding:11px 12px;margin-top:10px}
.mt-adapter-head{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.mt-adapter-head b{font-size:13px}
.mt-path{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;opacity:.62;word-break:break-all}
.mt-rows{display:flex;flex-direction:column;gap:6px}
.mt-custom-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;border:1px solid var(--dsh-border,rgba(127,127,127,.22));border-radius:9px;font-size:12.5px}
.mt-custom-row .mt-path{flex:1;min-width:140px}
.mt-found-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;border:1px solid var(--dsh-border,rgba(127,127,127,.22));border-radius:9px;font-size:12.5px}
.mt-found-row .mt-path{flex:1;min-width:160px}
.mt-log{max-height:260px;overflow:auto;margin:0;padding:10px 12px;border-radius:9px;border:1px solid var(--dsh-border,rgba(127,127,127,.22));background:rgba(127,127,127,.06);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;line-height:1.5;white-space:pre-wrap;word-break:break-all}
.mt-toasts{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);display:flex;flex-direction:column;gap:8px;align-items:center;z-index:9999;pointer-events:none}
.mt-toast{pointer-events:auto;max-width:min(520px,86vw);padding:9px 15px;border-radius:999px;font-size:13px;border:1px solid var(--dsh-border,rgba(127,127,127,.3));background:var(--dsh-surface,#262626);box-shadow:0 8px 26px rgba(0,0,0,.28);animation:mt-in .16s ease-out}
.mt-toast.error{border-color:rgba(224,91,91,.6)}
.mt-toast.warn{border-color:rgba(224,166,60,.65)}
@keyframes mt-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
`

      function ensureStyle() {
        if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = CSS
        document.head.appendChild(style)
      }

      /* ------------------------------------------------------------- 数据访问 */
      function unwrap(payload, status) {
        if (payload && typeof payload === 'object' && payload.ok === false) {
          throw new Error(payload.error || ('HTTP ' + status))
        }
        if (payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'data')) {
          return payload.data
        }
        return payload
      }

      async function request(path, options) {
        const response = await fetch(API + path, options || {})
        const raw = await response.text()
        let payload = null
        if (raw) {
          try {
            payload = JSON.parse(raw)
          } catch (error) {
            throw new Error('HTTP ' + response.status + ' · ' + raw.slice(0, 160))
          }
        }
        if (!response.ok) {
          throw new Error((payload && payload.error) || ('HTTP ' + response.status))
        }
        return unwrap(payload, response.status)
      }

      function postJSON(path, body) {
        return request(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body || {}),
        })
      }

      /* ---------------------------------------------------------------- 小工具 */
      function clone(value) {
        try {
          return JSON.parse(JSON.stringify(value))
        } catch (error) {
          return value
        }
      }

      function pad2(n) {
        return n < 10 ? '0' + n : String(n)
      }

      function formatDate(ms) {
        const date = new Date(ms)
        return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate())
      }

      function formatTime(ms) {
        if (!ms) return ''
        const date = new Date(ms)
        return formatDate(ms) + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes())
      }

      function startOfToday() {
        const date = new Date()
        date.setHours(0, 0, 0, 0)
        return date.getTime()
      }

      function groupOf(ms) {
        if (!ms) return 'unknown'
        const today = startOfToday()
        if (ms >= today) return 'today'
        if (ms >= today - DAY) return 'yesterday'
        const weekday = new Date(today).getDay()
        const back = (weekday + 6) % 7
        const weekStart = today - back * DAY
        if (ms >= weekStart) return 'week'
        return 'earlier'
      }

      function daysLeft(ms) {
        return Math.max(0, Math.ceil(ms / DAY))
      }

      function basename(path) {
        if (!path) return ''
        const parts = String(path).split(/[\\/]/)
        return parts[parts.length - 1] || ''
      }

      function randomId() {
        return Math.random().toString(16).slice(2, 10)
      }

      function findScrollParent(el) {
        let node = el
        while (node && node !== document.body && node !== document.documentElement) {
          const style = window.getComputedStyle(node)
          const overflow = style.overflowY
          if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight + 8) return node
          node = node.parentElement
        }
        return null
      }

      /* ------------------------------------------------------------------ 状态 */
      const ui = {
        tab: 'memories',
        filter: { state: 'all', adapter: '', q: '' },
        rows: [],
        total: 0,
        page: 1,
        pageSize: 100,
        loading: false,
        pendingRefresh: false,
        error: null,
        selected: new Set(),
        expanded: new Set(),
        state: null,
        settings: null,
        draft: null,
        scan: null,
        log: null,
        logLoading: false,
        savings: 0,
        alive: true,
      }

      let savedAt = 0

      /* ------------------------------------------------------------------ 挂载 */
      function mountApp(host) {
        ensureStyle()
        ui.tab = 'memories'
        ui.alive = true
        host.classList.add('mt-root')

        const headEl = h('div', { class: 'mt-head' })
        const tabEl = h('div', { class: 'mt-tabs' })
        const memoryPane = h('div', { class: 'mt-pane' })
        const settingsPane = h('div', { class: 'mt-pane' })
        const toastHost = h('div', { class: 'mt-toasts' })
        append(host, [headEl, tabEl, memoryPane, settingsPane, toastHost])

        const els = {}
        let debounce = null
        let scrollTarget = null
        let alive = true

        function toast(kind, text) {
          if (!text) return
          const node = h('div', { class: 'mt-toast ' + (kind || 'ok'), text: text })
          append(toastHost, node)
          window.setTimeout(function () {
            if (node.parentNode) node.parentNode.removeChild(node)
          }, kind === 'error' ? 5200 : 2600)
        }

        function renderHeader() {
          const stats = (ui.state && ui.state.stats) || {}
          replace(headEl, [
            h('div', { class: 'mt-title-row' }, [
              h('div', { class: 'mt-title', text: t('app.title') }),
              h('div', { class: 'mt-sub', text: t('app.subtitle') }),
            ]),
          ])
          replace(tabEl, [
            tabButton('memories', t('tab.memories'), stats.active),
            tabButton('settings', t('tab.settings'), null),
          ])
        }

        function tabButton(id, label, count) {
          const node = h('button', {
            class: 'mt-tab' + (ui.tab === id ? ' on' : ''),
            type: 'button',
            dataset: { tab: id },
            onclick: function () {
              if (ui.tab === id) return
              ui.tab = id
              renderHeader()
              memoryPane.hidden = id !== 'memories'
              settingsPane.hidden = id !== 'settings'
              if (id === 'settings') renderSettings()
              else renderList()
            },
          }, [h('span', { text: label }), count === undefined || count === null || count === 0 ? null : h('em', { text: String(count) })])
          return node
        }

        /* -------------------------------------------------------------- 记忆页 */
        function buildMemory() {
          replace(memoryPane, buildMemoryTree())
          memoryPane.hidden = ui.tab !== 'memories'
        }

        function buildMemoryTree() {
          const search = h('input', {
            class: 'mt-search',
            type: 'search',
            placeholder: t('search.placeholder'),
            value: ui.filter.q,
            oninput: function (event) {
              ui.filter.q = event.target.value
              if (debounce) window.clearTimeout(debounce)
              debounce = window.setTimeout(function () {
                refreshEntries(true)
              }, 260)
            },
          })
          els.search = search

          const adapter = h('select', { class: 'mt-select', onchange: function (event) {
            ui.filter.adapter = event.target.value
            refreshEntries(true)
          } })
          els.adapter = adapter

          const chips = h('div', { class: 'mt-chips' })
          els.chips = chips
          const statsEl = h('span', { class: 'mt-stats' })
          els.stats = statsEl
          append(chips, [statsEl])
          for (const id of ['all', 'active', 'archived', 'cold', 'pinned']) {
            chips.insertBefore(h('button', {
              class: 'mt-chip' + (ui.filter.state === id ? ' on' : ''),
              type: 'button',
              dataset: { state: id },
              text: t('filter.' + id),
              onclick: function () {
                if (ui.filter.state === id) return
                ui.filter.state = id
                renderChips()
                refreshEntries(true)
              },
            }), statsEl)
          }

          const listEl = h('div', { class: 'mt-list' })
          els.list = listEl
          const footerEl = h('div', { class: 'mt-footer' })
          els.footer = footerEl
          const bulkEl = h('div', { class: 'mt-bulk', hidden: true })
          els.bulk = bulkEl

          const toolbar = h('div', { class: 'mt-toolbar' }, [
            search,
            adapter,
            button(t('btn.refresh'), function () { refreshEntries(true) }),
            button(t('btn.scan'), function () { runScan() }, { primary: true }),
          ])

          renderChips()
          renderAdapterOptions()
          return [toolbar, chips, listEl, footerEl, bulkEl]
        }

        function renderChips() {
          if (!els.chips) return
          const nodes = els.chips.querySelectorAll('.mt-chip')
          for (const node of nodes) node.classList.toggle('on', node.dataset.state === ui.filter.state)
          const stats = (ui.state && ui.state.stats) || {}
          if (els.stats) {
            els.stats.textContent = t('stats.line', {
              active: stats.active || 0,
              archived: stats.archived || 0,
              cold: stats.cold || 0,
            })
          }
        }

        function renderAdapterOptions() {
          if (!els.adapter) return
          const adapters = (ui.state && ui.state.adapters) || []
          const current = ui.filter.adapter
          replace(els.adapter, h('option', { value: '', text: t('source.all') }))
          let matched = false
          for (const adapter of adapters) {
            const id = adapter && adapter.id
            if (!id) continue
            if (id === current) matched = true
            append(els.adapter, h('option', { value: id, text: adapter.label || id }))
          }
          els.adapter.value = matched ? current : ''
          if (!matched && current) ui.filter.adapter = ''
        }

        function countdownNode(row) {
          const now = Date.now()
          if (row.state === 'cold') return h('span', { class: 'mt-count cold', text: t('ttl.cold') })
          if (row.state === 'archived') {
            if (!row.expiresAt) return h('span', { class: 'mt-count cold', text: t('ttl.cold') })
            const left = row.expiresAt - now
            if (left <= 0) return h('span', { class: 'mt-count expired', text: t('ttl.archiveExpired') })
            const onExpiry = ui.draft && ui.draft.archive && ui.draft.archive.onExpiry
            const key = onExpiry === 'delete' ? 'ttl.archiveLeftDelete' : 'ttl.archiveLeft'
            return h('span', { class: 'mt-count cold', text: t(key, { n: daysLeft(left) }) })
          }
          if (!row.expiresAt) return h('span', { class: 'mt-count muted', text: t('ttl.never') })
          const left = row.expiresAt - now
          if (left <= 0) return h('span', { class: 'mt-count expired', text: t('ttl.expired') })
          const tone = left < DAY ? 'warn' : 'ok'
          return h('span', { class: 'mt-count ' + tone, text: t('ttl.days', { n: daysLeft(left) }) })
        }

        function cardFor(row) {
          const key = row.key
          const check = h('input', {
            type: 'checkbox',
            class: 'mt-check',
            checked: ui.selected.has(key),
            onchange: function (event) {
              if (event.target.checked) ui.selected.add(key)
              else ui.selected.delete(key)
              renderBulk()
            },
          })

          const textNode = h('div', {
            class: 'mt-text' + (ui.expanded.has(key) ? ' open' : ''),
            text: row.text || '',
            onclick: function (event) {
              event.stopPropagation()
              if (ui.expanded.has(key)) ui.expanded.delete(key)
              else ui.expanded.add(key)
              textNode.classList.toggle('open')
            },
          })

          const actions = []
          if (row.state === 'active' || row.state === undefined) {
            actions.push(button(row.pinned ? t('op.unpin') : t('op.pin'), function () {
              runAction(row.pinned ? 'unpin' : 'pin', [key])
            }, { small: true }))
            actions.push(button(t('op.archive'), function () { runAction('archive', [key]) }, { small: true }))
            actions.push(button(t('op.delete'), function () { removeOne(row) }, { small: true, danger: true }))
          } else {
            actions.push(button(t('op.restore'), function () { runAction('restore', [key]) }, { small: true, primary: true }))
            actions.push(button(t('op.delete'), function () { removeOne(row) }, { small: true, danger: true }))
          }

          const tags = h('div', { class: 'mt-tags' })
          for (const tag of (row.tags || []).slice(0, 8)) append(tags, h('span', { class: 'mt-tag', text: '#' + tag }))

          const dateText = row.dateText || (row.date ? formatDate(row.date) : t('group.unknown'))
          const trackLabel = row.track ? (hasKey('track.' + row.track) ? t('track.' + row.track) : String(row.track)) : null

          return h('div', { class: 'mt-card', dataset: { key: key } }, [
            h('div', { class: 'mt-card-head' }, [
              check,
              h('span', { class: 'mt-badge mt-date', text: dateText }),
              h('span', { class: 'mt-badge', text: row.adapterLabel || row.adapterId || '' }),
              trackLabel ? h('span', { class: 'mt-badge mt-track', text: trackLabel }) : null,
              row.pinned ? h('span', { class: 'mt-badge mt-pin', text: t('badge.pinned') }) : null,
              h('span', { class: 'mt-spacer' }),
              countdownNode(row),
            ]),
            textNode,
            h('div', { class: 'mt-card-foot' }, [tags, h('div', { class: 'mt-actions' }, actions)]),
          ])
        }

        function renderList() {
          if (!els.list) return
          if (ui.loading && !ui.rows.length) {
            replace(els.list, h('div', { class: 'mt-hint-block', text: t('list.loading') }))
            renderFooter()
            renderBulk()
            return
          }
          if (ui.error && !ui.rows.length) {
            replace(els.list, h('div', { class: 'mt-error' }, [
              h('span', { text: t('toast.loadFailed') + '：' + ui.error }),
              button(t('btn.retry'), function () { refreshEntries(true) }, { small: true }),
            ]))
            renderFooter()
            renderBulk()
            return
          }
          if (!ui.rows.length) {
            replace(els.list, h('div', { class: 'mt-empty' }, [
              h('b', { text: t('list.empty') }),
              h('span', { text: t('list.emptyHint') }),
            ]))
            renderFooter()
            renderBulk()
            return
          }
          const groups = {}
          for (const row of ui.rows) {
            const name = groupOf(row.date)
            if (!groups[name]) groups[name] = []
            groups[name].push(row)
          }
          const tree = []
          for (const name of ['today', 'yesterday', 'week', 'earlier', 'unknown']) {
            const rows = groups[name]
            if (!rows || !rows.length) continue
            tree.push(h('div', { class: 'mt-group' }, [h('span', { text: t('group.' + name) }), h('em', { text: String(rows.length) })]))
            for (const row of rows) tree.push(cardFor(row))
          }
          replace(els.list, tree)
          renderFooter()
          renderBulk()
        }

        function hasMore() {
          return ui.rows.length < ui.total
        }

        function renderFooter() {
          if (!els.footer) return
          const tree = []
          if (ui.rows.length) {
            tree.push(h('span', {
              text: hasMore()
                ? t('list.loaded', { n: ui.rows.length, total: ui.total })
                : t('list.total', { n: ui.total }),
            }))
          }
          if (hasMore()) {
            tree.push(button(ui.loading ? t('list.loading') : t('btn.more'), function () { loadMore() }, { small: true, disabled: ui.loading }))
          }
          if (ui.error && ui.rows.length) {
            tree.push(h('span', { class: 'mt-hint', text: ui.error }))
          }
          replace(els.footer, tree.length ? h('div', { class: 'mt-pager' }, tree) : null)
        }

        function renderBulk() {
          if (!els.bulk) return
          const count = ui.selected.size
          if (!count) {
            els.bulk.hidden = true
            return
          }
          els.bulk.hidden = false
          replace(els.bulk, [
            h('span', { text: t('bulk.selected', { n: count }) }),
            h('span', { class: 'mt-spacer' }),
            button(t('op.archive'), function () { bulkAction('archive') }, { small: true }),
            button(t('op.delete'), function () { bulkAction('delete') }, { small: true, danger: true }),
            button(t('op.pin'), function () { bulkAction('pin') }, { small: true }),
            button(t('btn.cancel'), function () {
              ui.selected.clear()
              renderList()
            }, { small: true }),
          ])
        }

        function uniqueSources(keys) {
          const names = []
          for (const row of ui.rows) {
            if (keys.indexOf(row.key) === -1) continue
            const label = row.adapterLabel || row.adapterId || ''
            if (label && names.indexOf(label) === -1) names.push(label)
          }
          return names.length ? names.join(' · ') : '—'
        }

        function removeOne(row) {
          const label = row.text ? row.text.slice(0, 60).replace(/\s+/g, ' ') : row.key
          if (!window.confirm(t('confirm.deleteOne', { label: label }))) return
          runAction('delete', [row.key])
        }

        function bulkAction(op) {
          const keys = Array.from(ui.selected)
          if (!keys.length) return
          if (op === 'delete' && !window.confirm(t('confirm.deleteBulk', { n: keys.length, sources: uniqueSources(keys) }))) return
          runAction(op, keys)
        }

        function loadMore() {
          if (ui.loading || !hasMore()) return
          ui.page += 1
          refreshEntries(false)
        }

        /* -------------------------------------------------------------- 设置页 */
        function draftPath(path) {
          const parts = String(path).split('.')
          let node = ui.draft
          if (!node) return undefined
          for (let i = 0; i < parts.length - 1; i += 1) {
            if (!node[parts[i]] || typeof node[parts[i]] !== 'object') return undefined
            node = node[parts[i]]
          }
          return node ? node[parts[parts.length - 1]] : undefined
        }

        function setDraftPath(path, value) {
          if (!ui.draft) ui.draft = {}
          const parts = String(path).split('.')
          let node = ui.draft
          for (let i = 0; i < parts.length - 1; i += 1) {
            if (!node[parts[i]] || typeof node[parts[i]] !== 'object') node[parts[i]] = {}
            node = node[parts[i]]
          }
          node[parts[parts.length - 1]] = value
          if (els.dirty) els.dirty.hidden = false
        }

        function card(title, hint, body) {
          return h('section', { class: 'mt-card-block' }, [
            title ? h('h3', { class: 'mt-card-title', text: title }) : null,
            hint ? h('div', { class: 'mt-card-hint', text: hint }) : null,
            body,
          ])
        }

        function field(label, control, hint) {
          return h('div', { class: 'mt-field' }, [
            h('span', { class: 'mt-label', text: label }),
            control,
            hint ? h('span', { class: 'mt-hint', text: hint }) : null,
          ])
        }

        function numberField(label, value, onInput, options) {
          const opts = options || {}
          const input = h('input', {
            class: 'mt-input',
            type: 'number',
            step: opts.step || '1',
            min: opts.min,
            max: opts.max,
            value: value === undefined || value === null ? '' : String(value),
            disabled: opts.disabled,
            oninput: function (event) {
              const raw = event.target.value
              onInput(raw === '' ? '' : Number(raw))
            },
          })
          return field(label, input, opts.hint)
        }

        function checkRow(label, checked, onChange, hint) {
          return h('label', { class: 'mt-check-row' }, [
            h('input', { type: 'checkbox', checked: checked, onchange: function (event) { onChange(event.target.checked) } }),
            h('span', { text: label }),
            hint ? h('span', { class: 'mt-hint', text: hint }) : null,
          ])
        }

        function selectEl(choices, value, onChange) {
          const select = h('select', { class: 'mt-select', onchange: function (event) { onChange(event.target.value) } })
          for (const choice of choices) append(select, h('option', { value: choice.value, text: choice.label }))
          select.value = value
          return select
        }

        function radioGroup(name, value, choices, onChange) {
          const wrap = h('div', { class: 'mt-radios' })
          for (const choice of choices) {
            const input = h('input', {
              type: 'radio',
              name: name,
              value: choice.value,
              checked: value === choice.value,
              onchange: function () { onChange(choice.value) },
            })
            append(wrap, h('label', { class: 'mt-radio' }, [input, h('span', { text: choice.label })]))
          }
          return wrap
        }

        function adapterInfo(id) {
          const adapters = (ui.state && ui.state.adapters) || []
          for (const adapter of adapters) if (adapter && adapter.id === id) return adapter
          return null
        }

        function renderSettings() {
          if (!ui.settings) {
            replace(settingsPane, h('div', { class: 'mt-hint-block', text: t('list.loading') }))
            settingsPane.hidden = ui.tab !== 'settings'
            return
          }
          const draft = ui.draft || {}
          const curve = draft.curve || {}
          const archive = draft.archive || {}
          const sweep = draft.sweep || {}
          const adapters = draft.adapters || {}
          const fish = adapters.fish || {}
          const evolve = adapters.evolve || {}
          const tracks = evolve.tracks || {}
          const discovery = draft.discovery || {}
          const customAdapters = Array.isArray(draft.customAdapters) ? draft.customAdapters : []
          const state = ui.state || {}

          const saved = h('span', { class: 'mt-saved' + (Date.now() - savedAt < 5000 ? ' on' : ''), text: t('set.saved') })
          els.saved = saved
          const dirty = h('span', { class: 'mt-dirty', text: t('set.dirty'), hidden: Object.keys(draft).length === 0 })
          els.dirty = dirty

          const head = h('div', { class: 'mt-set-head' }, [
            h('div', {}, [
              h('div', { class: 'mt-card-title', text: t('set.title') }),
              h('div', { class: 'mt-hint', text: t('app.subtitle') }),
            ]),
            h('span', { class: 'mt-spacer' }),
            dirty,
            saved,
            button(t('btn.save'), function () { saveSettings() }, { primary: true }),
          ])

          /* 开关 */
          const switches = card(null, null, h('div', {
            style: { display: 'grid', gap: '6px' },
          }, [
            checkRow(t('set.enabled'), draft.enabled !== false, function (value) {
              setDraftPath('enabled', value)
            }, t('set.enabledHint')),
            checkRow(t('set.dryRun'), Boolean(draft.dryRun), function (value) {
              setDraftPath('dryRun', value)
            }, t('set.dryRunHint')),
          ]))

          /* 曲线 */
          const maxDaysInput = numberField(t('set.maxDays'), curve.maxTtlDays, function (value) {
            setDraftPath('curve.maxTtlDays', value)
          }, { step: '1', min: '1', disabled: curve.maxTtlEnabled === false })
          const curveWarn = h('div', { class: 'mt-warn', text: t('set.maxOffWarn'), hidden: curve.maxTtlEnabled !== false })
          const maxToggle = checkRow(t('set.maxTtl'), curve.maxTtlEnabled !== false, function (value) {
            setDraftPath('curve.maxTtlEnabled', value)
            const input = maxDaysInput.querySelector('input')
            if (input) input.disabled = !value
            curveWarn.hidden = value
          })
          const curveCard = card(t('set.curve'), t('set.curveHint'), h('div', {}, [
            h('div', { class: 'mt-row' }, [
              numberField(t('set.base'), curve.baseTtlDays, function (value) {
                setDraftPath('curve.baseTtlDays', value)
              }, { step: '0.5', min: '0' }),
              numberField(t('set.growth'), curve.growth, function (value) {
                setDraftPath('curve.growth', value)
              }, { step: '0.1', min: '1' }),
              maxDaysInput,
            ]),
            h('div', { style: { marginTop: '10px' } }, maxToggle),
            curveWarn,
          ]))

          /* 归档 */
          const archiveCard = card(t('set.archive'), null, h('div', {}, [
            h('div', { class: 'mt-row' }, [
              numberField(t('set.archiveDays'), archive.archiveDays, function (value) {
                setDraftPath('archive.archiveDays', value)
              }, { step: '1', min: '0' }),
            ]),
            h('div', { class: 'mt-field', style: { marginTop: '10px' } }, [
              h('span', { class: 'mt-label', text: t('set.onExpiry') }),
              radioGroup('mt-on-expiry', archive.onExpiry || 'cold', [
                { value: 'cold', label: t('set.onExpiryCold') },
                { value: 'delete', label: t('set.onExpiryDelete') },
              ], function (value) {
                setDraftPath('archive.onExpiry', value)
              }),
            ]),
          ]))

          /* 清扫 */
          const sweepCard = card(t('set.sweep'), null, h('div', {}, [
            h('div', { class: 'mt-row' }, [
              numberField(t('set.interval'), sweep.intervalMinutes, function (value) {
                setDraftPath('sweep.intervalMinutes', value)
              }, { step: '1', min: '1' }),
            ]),
            h('div', { style: { marginTop: '8px' } }, checkRow(t('set.onTurnEnd'), sweep.onTurnEnd !== false, function (value) {
              setDraftPath('sweep.onTurnEnd', value)
            })),
          ]))

          /* 状态 */
          const stats = state.stats || {}
          const firstDone = Boolean(state.firstSweepDone)
          const statusCard = card(t('set.status'), null, h('div', { class: 'mt-rows', style: { fontSize: '12.5px' } }, [
            h('div', {}, [t('set.firstSweep') + '：' + (firstDone ? t('set.done') : t('set.pending'))]),
            h('div', {}, [t('set.lastSweep') + '：' + (state.lastSweepAt ? formatTime(state.lastSweepAt) : t('set.never'))]),
            h('div', {}, [t('stats.line', { active: stats.active || 0, archived: stats.archived || 0, cold: stats.cold || 0 })]),
          ]))

          /* 适配器 */
          const fishInfo = adapterInfo('fish')
          const evolveInfo = adapterInfo('evolve')
          const fishCard = h('div', { class: 'mt-adapter' }, [
            h('div', { class: 'mt-adapter-head' }, [
              h('b', { text: 'fish-memory' }),
              h('span', { class: 'mt-badge', text: fishInfo && typeof fishInfo.count === 'number' ? t('set.count', { n: fishInfo.count }) : '' }),
            ]),
            h('div', { class: 'mt-path', text: t('set.path') + '：' + ((fishInfo && fishInfo.path) || '~/.dsh/fish-memory/*.json') }),
            h('div', { style: { marginTop: '8px', display: 'grid', gap: '8px' } }, [
              checkRow(t('set.enabled'), fish.enabled !== false, function (value) {
                setDraftPath('adapters.fish.enabled', value)
              }),
              h('div', { class: 'mt-row' }, [
                field(t('set.mode'), selectEl([
                  { value: 'archive', label: t('set.modeArchive') },
                  { value: 'delete', label: t('set.modeDelete') },
                ], fish.mode || 'archive', function (value) { setDraftPath('adapters.fish.mode', value) })),
                numberField(t('set.maxEntries'), fish.maxEntries, function (value) {
                  setDraftPath('adapters.fish.maxEntries', value)
                }, { step: '10', min: '0' }),
              ]),
            ]),
          ])

          const trackKeys = ['memory', 'key', 'user', 'project', 'daily']
          const trackWarn = h('div', { class: 'mt-warn', text: t('set.evolveWarn'), hidden: !(tracks.project || tracks.daily) })
          const trackBox = h('div', { style: { display: 'grid', gap: '2px', marginTop: '4px' } })
          for (const track of trackKeys) {
            append(trackBox, checkRow(t('track.' + track), Boolean(tracks[track]), function (value) {
              setDraftPath('adapters.evolve.tracks.' + track, value)
              const next = Object.assign({}, tracks, { [track]: value })
              trackWarn.hidden = !(next.project || next.daily)
            }, track === 'user' ? t('set.trackProtected') : null))
          }
          const evolveCard = h('div', { class: 'mt-adapter' }, [
            h('div', { class: 'mt-adapter-head' }, [
              h('b', { text: 'memory-evolve' }),
              h('span', { class: 'mt-badge', text: evolveInfo && typeof evolveInfo.count === 'number' ? t('set.count', { n: evolveInfo.count }) : '' }),
            ]),
            h('div', { class: 'mt-path', text: t('set.path') + '：' + ((evolveInfo && evolveInfo.path) || '~/.dsh/memories/*.md') }),
            h('div', { style: { marginTop: '8px', display: 'grid', gap: '8px' } }, [
              checkRow(t('set.enabled'), evolve.enabled !== false, function (value) {
                setDraftPath('adapters.evolve.enabled', value)
              }),
              field(t('set.mode'), selectEl([
                { value: 'archive', label: t('set.modeArchive') },
                { value: 'delete', label: t('set.modeDelete') },
              ], evolve.mode || 'archive', function (value) { setDraftPath('adapters.evolve.mode', value) })),
              h('div', { class: 'mt-field' }, [h('span', { class: 'mt-label', text: t('set.tracks') }), trackBox]),
              trackWarn,
            ]),
          ])

          const sourcesCard = card(t('set.sources'), null, h('div', {}, [fishCard, evolveCard]))

          /* 自定义适配器 */
          const customList = h('div', { class: 'mt-rows' })
          if (!customAdapters.length) append(customList, h('div', { class: 'mt-hint', text: t('set.customEmpty') }))
          for (const adapter of customAdapters) {
            append(customList, h('div', { class: 'mt-custom-row' }, [
              h('b', { text: adapter.label || adapter.id }),
              h('span', { class: 'mt-badge', text: adapter.type || '' }),
              h('span', { class: 'mt-path', text: adapter.path || '' }),
              button(t('btn.test'), function () { testAdapter(adapter) }, { small: true }),
              button(t('btn.remove'), function () {
                ui.draft.customAdapters = (ui.draft.customAdapters || []).filter(function (item) { return item.id !== adapter.id })
                renderSettings()
              }, { small: true, danger: true }),
            ]))
          }

          const type = ui.customType || 'file-md'
          const labelInput = h('input', { class: 'mt-input', type: 'text', placeholder: t('set.label') })
          const pathInput = h('input', { class: 'mt-input', type: 'text', placeholder: 'C:\\path\\to\\mem.md' })
          const modeSelect = selectEl([
            { value: 'archive', label: t('set.modeArchive') },
            { value: 'delete', label: t('set.modeDelete') },
          ], 'archive', function () { /* 保存时直接读 select 的值 */ })
          const mdInputs = {
            delimiter: h('input', { class: 'mt-input', type: 'text', placeholder: '\\n§\\n' }),
            dateRegex: h('input', { class: 'mt-input', type: 'text', placeholder: '^\\[(\\d{4}-\\d{2}-\\d{2})\\]\\s*' }),
            encoding: h('input', { class: 'mt-input', type: 'text', value: 'utf8' }),
          }
          const jsonInputs = {
            listPath: h('input', { class: 'mt-input', type: 'text', placeholder: 'memories' }),
            textField: h('input', { class: 'mt-input', type: 'text', placeholder: 'text' }),
            idField: h('input', { class: 'mt-input', type: 'text', placeholder: 'id' }),
            timeFields: h('input', { class: 'mt-input', type: 'text', placeholder: 'createdAt, at' }),
            indent: h('input', { class: 'mt-input', type: 'text', placeholder: '2' }),
            tagsField: h('input', { class: 'mt-input', type: 'text', placeholder: 'tags' }),
          }
          const mdRows = h('div', { class: 'mt-row' }, [
            field(t('fmt.delimiter'), mdInputs.delimiter, t('fmt.delimiterHint')),
            field(t('fmt.dateRegex'), mdInputs.dateRegex),
            field(t('fmt.encoding'), mdInputs.encoding),
          ])
          const jsonRows = h('div', { class: 'mt-row' }, [
            field(t('fmt.listPath'), jsonInputs.listPath),
            field(t('fmt.textField'), jsonInputs.textField),
            field(t('fmt.idField'), jsonInputs.idField),
            field(t('fmt.timeFields'), jsonInputs.timeFields),
            field(t('fmt.indent'), jsonInputs.indent),
            field(t('fmt.tagsField'), jsonInputs.tagsField),
          ])
          mdRows.hidden = type !== 'file-md'
          jsonRows.hidden = type === 'file-md'
          const typeSelect = selectEl([
            { value: 'file-md', label: 'file-md' },
            { value: 'file-json', label: 'file-json' },
          ], type, function (value) {
            ui.customType = value
            mdRows.hidden = value !== 'file-md'
            jsonRows.hidden = value === 'file-md'
          })
          const addForm = h('div', { style: { marginTop: '12px', display: 'grid', gap: '10px' } }, [
            h('div', { class: 'mt-card-title', text: t('set.customAdd') }),
            h('div', { class: 'mt-row' }, [
              field(t('set.customType'), typeSelect),
              field(t('set.label'), labelInput),
              field(t('set.mode'), modeSelect),
            ]),
            field(t('set.filePath'), pathInput),
            h('div', { class: 'mt-label', style: { marginTop: '2px' }, text: t('set.format') }),
            mdRows,
            jsonRows,
            h('div', { class: 'mt-hint' }, [button(t('btn.add'), function () {
              const path = pathInput.value.trim()
              if (!path) {
                toast('warn', t('toast.needPath'))
                return
              }
              const kind = ui.customType || 'file-md'
              const format = {}
              if (kind === 'file-md') {
                format.delimiter = mdInputs.delimiter.value.replace(/\\n/g, '\n').replace(/\\t/g, '\t')
                format.dateRegex = mdInputs.dateRegex.value
                format.encoding = mdInputs.encoding.value || 'utf8'
              } else {
                format.listPath = jsonInputs.listPath.value.trim()
                format.textField = jsonInputs.textField.value.trim() || 'text'
                format.idField = jsonInputs.idField.value.trim()
                const times = jsonInputs.timeFields.value.split(',').map(function (part) { return part.trim() }).filter(Boolean)
                if (times.length) format.timeFields = times
                if (jsonInputs.indent.value.trim() !== '') format.indent = jsonInputs.indent.value.trim()
                format.tagsField = jsonInputs.tagsField.value.trim()
              }
              const item = {
                id: 'custom:' + randomId(),
                type: kind,
                label: labelInput.value.trim() || basename(path) || t('set.custom'),
                path: path,
                mode: modeSelect.value || 'archive',
                format: format,
              }
              ui.draft.customAdapters = (ui.draft.customAdapters || []).concat([item])
              toast('ok', t('toast.added'))
              renderSettings()
            }, { primary: true })]),
          ])

          const customCard = card(t('set.custom'), null, h('div', {}, [customList, addForm]))

          /* 发现 */
          const scanInfo = ui.scan
          const discoveryRows = h('div', { class: 'mt-rows' })
          if (scanInfo) {
            const found = Array.isArray(scanInfo.found) ? scanInfo.found : []
            if (!found.length) append(discoveryRows, h('div', { class: 'mt-hint', text: t('set.noFound') }))
            for (const item of found) {
              const kindLabel = item.kind || 'unknown'
              const actions = []
              if (kindLabel !== 'unknown') {
                actions.push(button(t('btn.enable'), function () { adopt(item) }, { small: true, primary: true }))
              }
              actions.push(button(t('btn.ignore'), function () { deny(item) }, { small: true }))
              append(discoveryRows, h('div', { class: 'mt-found-row' }, [
                h('span', { class: 'mt-badge', text: kindLabel }),
                h('span', { class: 'mt-path', text: item.path || '' }),
                h('span', { class: 'mt-hint', text: t('set.confidence') + ' ' + (typeof item.confidence === 'number' ? item.confidence.toFixed(2) : '—') }),
                h('span', { class: 'mt-hint', text: t('set.count', { n: item.count || 0 }) }),
                h('span', { class: 'mt-spacer' }),
              ].concat(actions)))
            }
            if (scanInfo.skipped && scanInfo.skipped.length) {
              append(discoveryRows, h('div', { class: 'mt-hint', text: t('set.skipped', { n: scanInfo.skipped.length }) }))
            }
          }
          const discoveryCard = card(t('set.discovery'), t('set.discoveryHint'), h('div', { style: { display: 'grid', gap: '8px' } }, [
            checkRow(t('set.discEnabled'), discovery.enabled !== false, function (value) {
              setDraftPath('discovery.enabled', value)
            }),
            checkRow(t('set.autoAdopt'), Boolean(discovery.autoAdoptHighConfidence), function (value) {
              setDraftPath('discovery.autoAdoptHighConfidence', value)
            }),
            h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, [
              button(t('btn.scan'), function () { runScan() }, { small: true }),
            ]),
            scanInfo ? h('div', { class: 'mt-card-title', text: t('set.found') }) : null,
            scanInfo ? discoveryRows : null,
          ]))

          /* 日志 */
          const logLines = ui.log || []
          const logCard = card(t('set.log'), null, h('div', {}, [
            h('div', { style: { marginBottom: '8px', display: 'flex', gap: '8px' } }, [
              button(t('btn.refreshLog'), function () { loadLog() }, { small: true }),
            ]),
            h('pre', { class: 'mt-log', text: logLines.length ? logLines.join('\n') : t('set.logEmpty') }),
          ]))

          replace(settingsPane, [head, switches, curveCard, archiveCard, sweepCard, statusCard, sourcesCard, customCard, discoveryCard, logCard])
          settingsPane.hidden = ui.tab !== 'settings'
        }

        function testAdapter(adapter) {
          const id = adapter && adapter.id
          if (!id) return
          request('/entries?adapter=' + encodeURIComponent(id) + '&pageSize=1')
            .then(function (data) {
              toast('ok', t('toast.tested', { n: (data && data.total) || 0 }))
            })
            .catch(function (error) {
              toast('error', t('toast.actionFailed') + '：' + error.message)
            })
        }

        function defaultFormat(type) {
          if (type === 'file-json') return { listPath: 'memories', textField: 'text', timeFields: ['createdAt', 'at'] }
          return { delimiter: '\n§\n', dateRegex: '^\\[(\\d{4}-\\d{2}-\\d{2})\\]\\s*', encoding: 'utf8' }
        }

        function adopt(found) {
          const type = found.kind === 'file-json' || found.kind === 'fish' ? 'file-json' : 'file-md'
          const suggested = found.suggested && found.suggested.format ? found.suggested.format : null
          const adapter = {
            id: 'custom:' + randomId(),
            type: (found.suggested && found.suggested.type) || type,
            label: basename(found.path) || found.kind || 'memory',
            path: found.path,
            mode: 'archive',
            format: suggested || defaultFormat((found.suggested && found.suggested.type) || type),
          }
          postJSON('/adopt', { adapter: adapter })
            .then(function () {
              toast('ok', t('toast.adopted'))
              return pullState()
            })
            .catch(function (error) {
              toast('error', t('toast.actionFailed') + '：' + error.message)
            })
        }

        function deny(found) {
          postJSON('/adopt', { deny: [found.path] })
            .then(function () {
              toast('ok', t('toast.denied'))
              return pullState()
            })
            .catch(function (error) {
              toast('error', t('toast.actionFailed') + '：' + error.message)
            })
        }

        function buildPatch() {
          const draft = ui.draft || {}
          const patch = {}
          for (const key of ['enabled', 'dryRun']) if (draft[key] !== undefined) patch[key] = draft[key]
          for (const key of ['curve', 'archive', 'sweep', 'mentions', 'adapters', 'discovery', 'board']) {
            if (draft[key] && typeof draft[key] === 'object') patch[key] = clone(draft[key])
          }
          if (Array.isArray(draft.customAdapters)) patch.customAdapters = clone(draft.customAdapters)
          return patch
        }

        function saveSettings() {
          postJSON('/settings', { patch: buildPatch() })
            .then(function (data) {
              if (data && data.settings) {
                ui.settings = data.settings
                ui.draft = clone(data.settings)
              }
              savedAt = Date.now()
              renderSettings()
              renderChips()
              toast('ok', t('toast.saved'))
              const warnings = (data && data.warnings) || []
              if (warnings.length) toast('warn', warnings[0])
              window.setTimeout(function () {
                if (els.saved) els.saved.classList.remove('on')
              }, 4000)
            })
            .catch(function (error) {
              toast('error', t('toast.actionFailed') + '：' + error.message)
            })
        }

        /* ------------------------------------------------------------ 数据加载 */
        async function pullState() {
          try {
            const data = await request('/state')
            ui.state = data || {}
            ui.settings = (data && data.settings) || {}
            ui.draft = clone(ui.settings)
            if (ui.tab === 'settings') renderSettings()
          } catch (error) {
            if (ui.tab === 'settings') renderSettings()
            toast('error', t('toast.loadFailed') + '：' + error.message)
          }
          renderHeader()
          renderChips()
          renderAdapterOptions()
        }

        async function refreshEntries(reset) {
          if (ui.loading) {
            ui.pendingRefresh = true
            return
          }
          ui.loading = true
          if (reset) {
            ui.page = 1
            ui.rows = []
          }
          renderList()
          const params = new URLSearchParams()
          params.set('state', ui.filter.state)
          if (ui.filter.adapter) params.set('adapter', ui.filter.adapter)
          if (ui.filter.q) params.set('q', ui.filter.q)
          params.set('page', String(ui.page))
          params.set('pageSize', String(ui.pageSize))
          try {
            const data = await request('/entries?' + params.toString())
            const rows = (data && data.rows) || []
            ui.rows = reset ? rows : ui.rows.concat(rows)
            ui.total = data && typeof data.total === 'number' ? data.total : ui.rows.length
            ui.error = null
          } catch (error) {
            ui.error = error.message
            if (reset) ui.rows = []
            toast('error', t('toast.loadFailed') + '：' + error.message)
          }
          ui.loading = false
          renderList()
          if (ui.pendingRefresh) {
            ui.pendingRefresh = false
            refreshEntries(true)
          }
        }

        async function refreshAll() {
          await pullState()
          await refreshEntries(true)
        }

        async function runAction(op, keys) {
          if (!keys || !keys.length) return
          try {
            const data = await postJSON('/action', { op: op, keys: keys })
            const results = (data && data.results) || []
            const failed = results.filter(function (item) { return item && item.ok === false })
            if (failed.length) toast('error', (failed[0].error || t('toast.actionFailed')) + ' ×' + failed.length)
            else toast('ok', t('toast.op.' + op, { n: keys.length }))
            for (const key of keys) ui.selected.delete(key)
            await refreshAll()
          } catch (error) {
            toast('error', t('toast.actionFailed') + '：' + error.message)
          }
        }

        function runScan() {
          postJSON('/scan')
            .then(function (data) {
              ui.scan = data || { found: [], skipped: [] }
              const found = (ui.scan && ui.scan.found) || []
              if (found.length) toast('ok', t('toast.scanned', { n: found.length }))
              else toast('ok', t('toast.noNew'))
              renderSettings()
            })
            .catch(function (error) {
              toast('error', t('toast.actionFailed') + '：' + error.message)
            })
        }

        function loadLog() {
          if (ui.logLoading) return
          ui.logLoading = true
          request('/log?lines=50')
            .then(function (data) {
              ui.log = (data && data.lines) || []
            })
            .catch(function (error) {
              ui.log = []
              toast('error', t('toast.loadFailed') + '：' + error.message)
            })
            .finally(function () {
              ui.logLoading = false
              if (ui.tab === 'settings') renderSettings()
            })
        }

        /* ------------------------------------------------------------- 生命周期 */
        function rerenderAll() {
          if (!alive) return
          buildMemory()
          renderHeader()
          renderChips()
          renderAdapterOptions()
          if (ui.tab === 'settings') renderSettings()
          settingsPane.hidden = ui.tab !== 'settings'
          renderList()
        }

        function onScroll() {
          if (!alive || ui.tab !== 'memories' || ui.loading || !hasMore()) return
          const scroller = scrollTarget || findScrollParent(host)
          if (!scroller) return
          const gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
          if (gap < 260) loadMore()
        }

        renderHeader()
        buildMemory()
        settingsPane.hidden = true
        renderList()

        pullState()
        refreshEntries(true)
        loadLog()

        scrollTarget = findScrollParent(host)
        const scrollNode = scrollTarget || window
        scrollNode.addEventListener('scroll', onScroll, { passive: true })

        loadLocale().then(function (changed) {
          if (!changed || !alive) return
          rerenderAll()
        })

        return function dispose() {
          alive = false
          ui.alive = false
          if (debounce) window.clearTimeout(debounce)
          const node = scrollTarget || window
          node.removeEventListener('scroll', onScroll)
          clear(host)
          host.classList.remove('mt-root')
        }
      }

      /* ------------------------------------------------ 宿主 React 只做挂载适配 */
      let React = null
      try {
        React = require('react')
      } catch (error) {
        React = null
      }

      function SettingsPage() {
        if (!React) return null
        const hostRef = React.useRef(null)
        React.useEffect(function () {
          const node = hostRef.current
          if (!node) return undefined
          const dispose = mountApp(node)
          return function () {
            if (dispose) dispose()
          }
        }, [])
        return React.createElement('div', { ref: hostRef, className: 'dsh-memory-tide-host' })
      }

      return {
        inject: ['slots'],
        apply(ctx) {
          ctx.slots.inject('settings.section', function () {
            return ctx.slots.register(
              { name: 'settings.section', id: 'memory-tide', order: 52, label: () => '记忆潮汐' },
              SettingsPage,
            )
          })
        },
      }
    },
  })
})()
