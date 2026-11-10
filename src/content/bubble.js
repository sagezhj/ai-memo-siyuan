/* global AIME */
'use strict';

globalThis.AIME = globalThis.AIME || {};

/**
 * 页面右下角的悬浮入口 + 可展开的会话面板（Chat Memo 式）。
 *
 *  - 收起时是原来的状态气泡，点击展开面板；面板里列出所有已捕获的对话，
 *    当前页的对话置顶高亮，可搜索、打开原对话、跳思源、暂停/恢复、重试。
 *  - 两种布局：float 悬浮窗（可拖动）/ side 侧边栏（贴右全高），面板内一键切换并持久化。
 *  - 全部 UI 在 shadow DOM 里，站点样式污染不到这里；面板内的 DOM 变化也不会
 *    被 observer 的 MutationObserver 看到（shadow 树独立），不会引起抓取风暴。
 *  - 数据只经 AIME.rpc 走 background，本模块不直接碰思源。
 */
AIME.bubble = (function () {
  var ROOT_ID = 'aime-memo-root';
  var POLL_MS = 5000;        // 面板打开时的兜底刷新间隔（后台巡检不会回推状态）
  var MAX_ROWS = 100;        // 列表渲染上限，超出提示用搜索缩小范围

  var host = null;
  var shadow = null;
  var chip = null;
  var caret = null;
  var panel = null;
  var sumEl = null;
  var searchEl = null;
  var listEl = null;
  var noteEl = null;
  var layoutBtn = null;

  var clickHandler = null;   // 兼容旧 onClick（alt/ctrl 点击暂停）
  var actionHandler = null;  // 面板动作回调（'sync' 需要外部编排）
  var current = '';
  var hidden = false;
  var open = false;
  var layout = 'float';
  var pos = null;            // 悬浮窗拖动后的位置 {right,bottom}
  var records = [];
  var queue = {};
  var query = '';
  var pollTimer = null;
  var notifyTimer = null;
  var noteTimer = null;
  var refreshing = false;

  var VIEWS = {
    idle: { mark: '◦', label: 'AI Memo：监听中', tone: '#64748b' },
    scanning: { mark: '◌', label: 'AI Memo：读取页面', tone: '#0ea5e9' },
    syncing: { mark: '↻', label: 'AI Memo：同步中', tone: '#2563eb' },
    synced: { mark: '✓', label: 'AI Memo：已写入思源', tone: '#16a34a' },
    queued: { mark: '⏶', label: 'AI Memo：排队中', tone: '#7c3aed' },
    error: { mark: '!', label: 'AI Memo：同步失败', tone: '#dc2626' },
    paused: { mark: '‖', label: 'AI Memo：本对话已暂停', tone: '#f59e0b' },
    off: { mark: '—', label: 'AI Memo：已关闭', tone: '#94a3b8' },
    unsupported: { mark: '?', label: 'AI Memo：此页未匹配到适配器', tone: '#94a3b8' }
  };

  var STATUS_TEXT = {
    init: '待写入',
    synced: '已同步',
    pending: '排队中',
    error: '失败',
    paused: '已暂停',
    skipped: '已跳过'
  };

  var PLAT_TONE = {
    deepseek: '#4d6bfe',
    qwen: '#7c3aed',
    yuanbao: '#0aa06e',
    generic: '#64748b'
  };

  var CSS = [
    ':host{all:initial;position:fixed;z-index:2147483647;right:18px;bottom:18px;font:12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}',
    ':host(.hide){display:none}',
    '.chip{display:flex;align-items:center;gap:6px;padding:6px 10px;border-radius:999px;',
    'background:rgba(255,255,255,.94);color:#0f172a;box-shadow:0 2px 10px rgba(15,23,42,.18);cursor:pointer;',
    'user-select:none;max-width:46vw}',
    '.mark{width:18px;height:18px;border-radius:50%;display:grid;place-items:center;color:#fff;font-weight:700;flex:none}',
    '.label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.caret{color:#94a3b8;font-size:10px;flex:none}',
    '.spin{animation:aime-rot 1s linear infinite}',
    '@keyframes aime-rot{to{transform:rotate(360deg)}}',
    '.hide{display:none}',
    /* ---- 面板 ---- */
    '.panel{position:fixed;display:flex;flex-direction:column;background:#fff;color:#0f172a;',
    'border:1px solid #e2e8f0;box-shadow:0 8px 30px rgba(15,23,42,.22);overflow:hidden}',
    '.panel.float{right:18px;bottom:60px;width:340px;max-width:calc(100vw - 24px);height:min(520px,70vh);border-radius:12px}',
    '.panel.side{top:0;right:0;bottom:0;width:320px;max-width:90vw;border-radius:0}',
    ':host(.side-open) .chip{display:none}',
    '.p-head{display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid #eef2f7;cursor:grab;user-select:none}',
    '.panel.side .p-head{cursor:default}',
    '.p-head.dragging{cursor:grabbing}',
    '.p-title{font-weight:700;flex:none}',
    '.p-sum{color:#64748b;font-size:11px;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.p-btn{border:1px solid #e2e8f0;background:#f8fafc;border-radius:6px;padding:2px 7px;cursor:pointer;font-size:11px;color:#334155;flex:none}',
    '.p-btn:hover{background:#eef2f7}',
    '.p-search{margin:8px 10px 4px;padding:5px 8px;border:1px solid #e2e8f0;border-radius:6px;font:inherit;outline:none;flex:none}',
    '.p-search:focus{border-color:#93c5fd}',
    '.p-list{flex:1;overflow-y:auto;padding:4px 6px;min-height:60px}',
    '.row{display:flex;gap:6px;padding:7px 6px;border-radius:8px;border-left:3px solid transparent}',
    '.row:hover{background:#f8fafc}',
    '.row.current{background:#eff6ff;border-left-color:#2563eb}',
    '.row-main{flex:1;min-width:0;cursor:pointer}',
    '.row-top{display:flex;align-items:center;gap:5px;min-width:0}',
    '.plat{font-size:10px;color:#fff;background:#64748b;border-radius:4px;padding:0 4px;flex:none}',
    '.row-title{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}',
    '.tag-cur{font-size:10px;color:#2563eb;border:1px solid #bfdbfe;border-radius:4px;padding:0 3px;flex:none}',
    '.row-sub{display:flex;align-items:center;gap:5px;color:#64748b;font-size:11px;margin-top:2px}',
    '.dot{width:7px;height:7px;border-radius:50%;flex:none;background:#94a3b8}',
    '.dot.synced{background:#16a34a}.dot.error{background:#dc2626}.dot.pending{background:#7c3aed}',
    '.dot.paused{background:#f59e0b}.dot.init{background:#94a3b8}.dot.skipped{background:#cbd5e1}',
    '.row-err{color:#b91c1c;font-size:11px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.row-acts{display:flex;flex-direction:column;gap:3px;flex:none}',
    '.act{border:1px solid #e2e8f0;background:#fff;border-radius:5px;font-size:10px;padding:1px 5px;cursor:pointer;color:#334155}',
    '.act:hover{background:#f1f5f9}',
    '.p-foot{display:flex;align-items:center;gap:6px;padding:7px 10px;border-top:1px solid #eef2f7;flex:none}',
    '.p-note{flex:1;min-width:0;color:#64748b;font-size:11px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
    '.p-note.err{color:#b91c1c}.p-note.ok{color:#15803d}',
    '.empty{color:#94a3b8;text-align:center;padding:24px 8px;font-size:12px}'
  ].join('');

  /* -------------------------------------------------- 纯逻辑（selftest 覆盖） */

  /** ISO 时间 -> 相对时间；nowTs 可注入便于测试 */
  function relTime(iso, nowTs) {
    if (!iso) {
      return '';
    }
    var t = new Date(iso).getTime();
    if (isNaN(t)) {
      return '';
    }
    var diff = (typeof nowTs === 'number' ? nowTs : Date.now()) - t;
    if (diff < 0) {
      diff = 0;
    }
    if (diff < 60000) {
      return '刚刚';
    }
    if (diff < 3600000) {
      return Math.floor(diff / 60000) + ' 分钟前';
    }
    if (diff < 86400000) {
      return Math.floor(diff / 3600000) + ' 小时前';
    }
    if (diff < 2592000000) {
      return Math.floor(diff / 86400000) + ' 天前';
    }
    return String(iso).slice(0, 10);
  }

  /** 一条记录的展示状态：暂停优先，其次队列（重试中），最后记录自身状态 */
  function rowView(rec, qi) {
    rec = rec || {};
    if (rec.paused) {
      return { text: '已暂停', tone: 'paused' };
    }
    if (qi) {
      if (qi.exhausted) {
        return { text: '重试耗尽 · 待处理', tone: 'error' };
      }
      var base = qi.payload ? '待同步' : '等页面回开';
      return { text: base + ' · 重试' + (qi.attempts || 0), tone: 'pending' };
    }
    var st = rec.status || 'init';
    return { text: STATUS_TEXT[st] || st, tone: st };
  }

  /** 搜索过滤 + 当前页会话置顶（其余保持 updatedAt 倒序，依赖稳定排序） */
  function filterRecords(list, q, currentKey) {
    var needle = String(q || '').trim().toLowerCase();
    var out = (list || []).filter(function (r) {
      if (!needle) {
        return true;
      }
      var label = (AIME.C.PLATFORMS[r.platform] || {}).label || r.platform || '';
      var hay = [r.title, label, r.platform, r.url, r.docPath, r.memoKey].join(' ').toLowerCase();
      return hay.indexOf(needle) >= 0;
    });
    if (currentKey) {
      out.sort(function (a, b) {
        return (a.memoKey === currentKey ? 0 : 1) - (b.memoKey === currentKey ? 0 : 1);
      });
    }
    return out;
  }

  function currentMemoKey() {
    try {
      var r = AIME.observer && AIME.observer.result && AIME.observer.result();
      if (r && r.ok && r.convId) {
        return AIME.C.memoKeyOf(r.platform, r.convId);
      }
    } catch (e) {
      /* observer 未就绪 */
    }
    return '';
  }

  /* -------------------------------------------------- 挂载 */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) {
      n.className = cls;
    }
    if (text !== undefined) {
      n.textContent = text;
    }
    return n;
  }

  function btn(cls, text, title, fn) {
    var b = el('button', cls, text);
    b.type = 'button';
    if (title) {
      b.title = title;
    }
    b.addEventListener('click', function (ev) {
      ev.stopPropagation();
      fn(ev);
    });
    return b;
  }

  function mount() {
    if (host && host.isConnected) {
      return;
    }
    if (!document.body) {
      return;
    }
    host = document.createElement('div');
    host.id = ROOT_ID;
    shadow = host.attachShadow({ mode: 'open' });

    var style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);

    chip = el('div', 'chip');
    chip.title = '点击展开会话列表';
    chip.addEventListener('click', function (ev) {
      if (ev.altKey || ev.ctrlKey) {
        if (clickHandler) {
          clickHandler('pause');
        }
        return;
      }
      setOpen(!open);
    });
    shadow.appendChild(chip);

    buildPanel();
    shadow.appendChild(panel);
    document.body.appendChild(host);
    render('idle', {});
    applyLayout();

    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && open) {
        setOpen(false);
      }
    }, true);
    window.addEventListener('focus', notify);
  }

  function buildPanel() {
    panel = el('div', 'panel float hide');

    var head = el('div', 'p-head');
    head.appendChild(el('span', 'p-title', 'AI Memo'));
    sumEl = el('span', 'p-sum', '读取中…');
    head.appendChild(sumEl);
    layoutBtn = btn('p-btn', '侧栏', '切换为贴右侧边栏', function () {
      setLayout(layout === 'side' ? 'float' : 'side', true);
    });
    head.appendChild(layoutBtn);
    head.appendChild(btn('p-btn', '↻', '刷新列表', function () {
      refresh();
    }));
    head.appendChild(btn('p-btn', '×', '收起面板', function () {
      setOpen(false);
    }));
    panel.appendChild(head);
    bindDrag(head);

    searchEl = el('input', 'p-search');
    searchEl.type = 'search';
    searchEl.placeholder = '搜索标题 / 平台 / 文档路径…';
    searchEl.addEventListener('input', function () {
      query = searchEl.value;
      renderList();
    });
    panel.appendChild(searchEl);

    listEl = el('div', 'p-list');
    panel.appendChild(listEl);

    var foot = el('div', 'p-foot');
    foot.appendChild(btn('p-btn', '立即同步本页', '强制重扫当前页并写入思源', function () {
      if (actionHandler) {
        actionHandler('sync');
      }
      note('已触发同步…', '');
    }));
    foot.appendChild(btn('p-btn', '设置', '打开扩展设置页', function () {
      try {
        window.open(chrome.runtime.getURL('src/pages/settings.html'), '_blank');
      } catch (e) {
        note('打开设置失败：' + e.message, 'err');
      }
    }));
    noteEl = el('span', 'p-note', '');
    foot.appendChild(noteEl);
    panel.appendChild(foot);
  }

  /* -------------------------------------------------- 布局 / 拖动 */

  function applyLayout() {
    if (!panel) {
      return;
    }
    panel.classList.toggle('side', layout === 'side');
    panel.classList.toggle('float', layout === 'float');
    host.classList.toggle('side-open', layout === 'side' && open);
    layoutBtn.textContent = layout === 'side' ? '悬浮' : '侧栏';
    layoutBtn.title = layout === 'side' ? '切换为悬浮窗' : '切换为贴右侧边栏';
    if (layout === 'float') {
      var p = pos || { right: 18, bottom: 60 };
      panel.style.right = p.right + 'px';
      panel.style.bottom = p.bottom + 'px';
      panel.style.top = '';
    } else {
      panel.style.right = '';
      panel.style.bottom = '';
      panel.style.top = '';
    }
  }

  function setLayout(mode, persist) {
    layout = mode === 'side' ? 'side' : 'float';
    applyLayout();
    if (persist) {
      AIME.rpc.call(AIME.C.MSG.SETTINGS_SET, { panelLayout: layout });
    }
  }

  function clampPos(right, bottom) {
    var w = (panel && panel.offsetWidth) || 340;
    var h = (panel && panel.offsetHeight) || 400;
    var maxRight = Math.max(0, window.innerWidth - w);
    var maxBottom = Math.max(0, window.innerHeight - h);
    return {
      right: Math.min(Math.max(0, right), maxRight),
      bottom: Math.min(Math.max(0, bottom), maxBottom)
    };
  }

  function bindDrag(head) {
    head.addEventListener('pointerdown', function (ev) {
      if (layout !== 'float' || ev.button !== 0) {
        return;
      }
      if (ev.target && ev.target.closest && ev.target.closest('button')) {
        return;
      }
      ev.preventDefault();
      var start = pos || { right: 18, bottom: 60 };
      var sx = ev.clientX;
      var sy = ev.clientY;
      head.classList.add('dragging');
      try {
        head.setPointerCapture(ev.pointerId);
      } catch (e) {
        /* 某些内核不支持，忽略 */
      }
      function move(e2) {
        pos = clampPos(start.right + (sx - e2.clientX), start.bottom + (sy - e2.clientY));
        panel.style.right = pos.right + 'px';
        panel.style.bottom = pos.bottom + 'px';
      }
      function up() {
        head.classList.remove('dragging');
        head.removeEventListener('pointermove', move);
        head.removeEventListener('pointerup', up);
        head.removeEventListener('pointercancel', up);
        if (pos) {
          AIME.rpc.call(AIME.C.MSG.SETTINGS_SET, { panelPos: pos });
        }
      }
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', up);
      head.addEventListener('pointercancel', up);
    });
  }

  /* -------------------------------------------------- 开关 / 刷新 */

  function setOpen(on) {
    open = !!on;
    if (panel) {
      panel.classList.toggle('hide', !open);
    }
    if (caret) {
      caret.textContent = open ? '▾' : '▴';
    }
    applyLayout();
    if (open) {
      refresh();
      if (!pollTimer) {
        pollTimer = setInterval(function () {
          refresh();
        }, POLL_MS);
      }
    } else if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  /** 状态回推后调用：防抖刷新，只在面板打开时真正请求 */
  function notify() {
    if (!open) {
      return;
    }
    if (notifyTimer) {
      clearTimeout(notifyTimer);
    }
    notifyTimer = setTimeout(function () {
      notifyTimer = null;
      refresh();
    }, 300);
  }

  function note(text, kind) {
    if (!noteEl) {
      return;
    }
    noteEl.textContent = text || '';
    noteEl.className = 'p-note' + (kind ? ' ' + kind : '');
    if (noteTimer) {
      clearTimeout(noteTimer);
    }
    if (text) {
      noteTimer = setTimeout(function () {
        noteEl.textContent = '';
        noteEl.className = 'p-note';
      }, 6000);
    }
  }

  function refresh() {
    if (!open || refreshing) {
      return Promise.resolve();
    }
    refreshing = true;
    return AIME.rpc.call(AIME.C.MSG.RECORDS_LIST, {}).then(function (resp) {
      refreshing = false;
      if (resp && resp.ok) {
        records = resp.records || [];
        queue = resp.queue || {};
        renderList();
      } else {
        note('列表读取失败：' + ((resp && resp.error) || '后台未就绪'), 'err');
      }
    }).catch(function (e) {
      refreshing = false;
      note('列表读取失败：' + e.message, 'err');
    });
  }

  /* -------------------------------------------------- 渲染 */

  function render(status, info) {
    if (!chip) {
      return;
    }
    info = info || {};
    var view = VIEWS[status] || VIEWS.idle;
    var label = view.label;
    if (typeof info.pending === 'number' && info.pending > 0) {
      label += '（待同步 ' + info.pending + '）';
    }
    if (typeof info.messages === 'number') {
      label += ' · ' + info.messages + ' 条';
    }
    chip.title = (info.detail ? info.detail + String.fromCharCode(10) : '') + label + String.fromCharCode(10) + '点击展开会话列表';
    var spin = status === 'syncing' ? ' spin' : '';
    chip.innerHTML = '';
    var mark = el('span', 'mark' + spin);
    mark.style.background = view.tone;
    mark.textContent = view.mark;
    chip.appendChild(mark);
    chip.appendChild(el('span', 'label', label));
    caret = el('span', 'caret', open ? '▾' : '▴');
    chip.appendChild(caret);
    chip.classList.toggle('hide', hidden);
    current = status;
    if (open) {
      notify();
    }
  }

  function renderList() {
    if (!listEl) {
      return;
    }
    var curKey = currentMemoKey();
    var rows = filterRecords(records, query, curKey);
    var pending = Object.keys(queue).length;
    var synced = records.filter(function (r) {
      return r.status === AIME.C.ST.SYNCED && !r.paused && !queue[r.memoKey];
    }).length;
    sumEl.textContent = records.length + ' 个对话 · 已同步 ' + synced + ' · 待同步 ' + pending;

    var scrollTop = listEl.scrollTop;
    listEl.innerHTML = '';
    if (!rows.length) {
      listEl.appendChild(el('div', 'empty', records.length
        ? '没有匹配「' + query + '」的对话'
        : '还没有捕获到对话。打开一个 AI 对话页，抓到内容后会自动出现在这里。'));
      return;
    }
    var shown = rows.slice(0, MAX_ROWS);
    shown.forEach(function (r) {
      listEl.appendChild(renderRow(r, curKey));
    });
    if (rows.length > MAX_ROWS) {
      listEl.appendChild(el('div', 'empty', '仅显示前 ' + MAX_ROWS + ' 条，共 ' + rows.length + ' 条，请用搜索缩小范围'));
    }
    listEl.scrollTop = scrollTop;
  }

  function renderRow(r, curKey) {
    var qi = queue[r.memoKey];
    var view = rowView(r, qi);
    var isCur = !!curKey && r.memoKey === curKey;
    var row = el('div', 'row' + (isCur ? ' current' : ''));

    var main = el('div', 'row-main');
    var tip = [
      r.docPath || '',
      r.url || '',
      r.lastError ? '错误：' + r.lastError : '',
      (r.lastWarnings && r.lastWarnings.length) ? '告警：' + r.lastWarnings.join('，') : ''
    ].filter(Boolean).join(String.fromCharCode(10));
    main.title = tip || r.title || '';
    main.addEventListener('click', function () {
      if (r.url && /^https?:/i.test(r.url)) {
        window.open(r.url, '_blank', 'noopener');
      } else {
        note('该记录没有可打开的对话链接', 'err');
      }
    });

    var top = el('div', 'row-top');
    var plat = el('span', 'plat', (AIME.C.PLATFORMS[r.platform] || {}).label || r.platform || '?');
    plat.style.background = PLAT_TONE[r.platform] || '#64748b';
    top.appendChild(plat);
    top.appendChild(el('span', 'row-title', r.title || '(未命名对话)'));
    if (isCur) {
      top.appendChild(el('span', 'tag-cur', '当前页'));
    }
    main.appendChild(top);

    var sub = el('div', 'row-sub');
    sub.appendChild(el('span', 'dot ' + view.tone));
    sub.appendChild(el('span', '', (r.msgCount || 0) + ' 条 · ' + view.text +
      (r.lastSyncAt || r.updatedAt ? ' · ' + relTime(r.lastSyncAt || r.updatedAt) : '')));
    main.appendChild(sub);

    if (r.status === AIME.C.ST.ERROR && r.lastError && !qi) {
      main.appendChild(el('div', 'row-err', r.lastError));
    }
    row.appendChild(main);

    var acts = el('div', 'row-acts');
    if (r.docId) {
      acts.appendChild(btn('act', '思源', '在思源笔记中打开该文档（需本机装有思源桌面端）' + String.fromCharCode(10) + (r.docPath || ''), function () {
        var a = document.createElement('a');
        a.href = 'siyuan://blocks/' + r.docId;
        a.style.display = 'none';
        shadow.appendChild(a);
        a.click();
        a.remove();
        note('已请求打开思源文档', 'ok');
      }));
    }
    acts.appendChild(btn('act', r.paused ? '恢复' : '暂停', r.paused ? '恢复该对话的自动同步' : '暂停该对话的自动同步', function () {
      AIME.rpc.call(AIME.C.MSG.PAUSE_TOGGLE, { memoKey: r.memoKey }).then(function (resp) {
        if (resp && resp.ok) {
          note(resp.paused ? '已暂停：' + (r.title || r.memoKey) : '已恢复：' + (r.title || r.memoKey), 'ok');
          refresh();
        } else {
          note('操作失败：' + ((resp && resp.error) || ''), 'err');
        }
      });
    }));
    if (qi || r.status === AIME.C.ST.ERROR) {
      acts.appendChild(btn('act', '重试', '立即重试写入该对话', function () {
        note('重试中…', '');
        AIME.rpc.call(AIME.C.MSG.RECORD_RETRY, { memoKey: r.memoKey }).then(function (resp) {
          if (resp && resp.ok) {
            note('重试完成：' + (r.title || r.memoKey), 'ok');
          } else {
            note('重试未成功：' + ((resp && resp.error) || '') + ' ' + ((resp && resp.hint) || ''), 'err');
          }
          refresh();
        });
      }));
    }
    row.appendChild(acts);
    return row;
  }

  /* -------------------------------------------------- 对外接口 */

  return {
    mount: mount,
    set: function (status, info) {
      if (!host) {
        mount();
      }
      render(status, info);
    },
    show: function (on) {
      hidden = !on;
      if (host) {
        host.classList.toggle('hide', hidden);
      }
      if (chip) {
        chip.classList.toggle('hide', hidden);
      }
      if (hidden && open) {
        setOpen(false);
      }
    },
    /** boot 时注入设置：面板布局与位置 */
    configure: function (settings) {
      settings = settings || {};
      if (settings.panelLayout === 'side' || settings.panelLayout === 'float') {
        layout = settings.panelLayout;
      }
      if (settings.panelPos && typeof settings.panelPos.right === 'number' && typeof settings.panelPos.bottom === 'number') {
        pos = clampPos(settings.panelPos.right, settings.panelPos.bottom);
      }
      applyLayout();
    },
    onClick: function (fn) {
      clickHandler = fn;
    },
    onAction: function (fn) {
      actionHandler = fn;
    },
    toggle: function () {
      setOpen(!open);
    },
    isOpen: function () {
      return open;
    },
    refresh: refresh,
    notify: notify,
    status: function () {
      return current;
    },
    destroy: function () {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (notifyTimer) {
        clearTimeout(notifyTimer);
        notifyTimer = null;
      }
      if (host && host.remove) {
        host.remove();
      }
      host = null;
      shadow = null;
      chip = null;
      panel = null;
      listEl = null;
    },
    helpers: {
      relTime: relTime,
      rowView: rowView,
      filterRecords: filterRecords,
      STATUS_TEXT: STATUS_TEXT
    }
  };
})();
