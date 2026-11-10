/* global AIME */
'use strict';

/**
 * 设置页脚本：纯骨架交互，所有写操作都经 background 走，页面本身不碰思源。
 */
(function () {
  var settings = null;
  var STATUS_TEXT = {
    init: '待写入',
    synced: '已同步',
    pending: '排队中',
    error: '失败',
    paused: '已暂停',
    skipped: '已跳过'
  };

  function $(id) {
    return document.getElementById(id);
  }

  function say(el, text, kind) {
    el.textContent = text;
    el.className = 'mono ' + (kind === 'err' ? 'err' : kind === 'ok' ? 'ok' : 'muted');
  }

  function call(type, payload) {
    return AIME.rpc.call(type, payload).then(function (resp) {
      if (!resp || resp.ok === false) {
        throw new Error(resp && resp.error ? resp.error : '后台返回失败');
      }
      return resp;
    });
  }

  /* -------------------------------------------------- 表单 <-> 设置 */

  function fill(s) {
    $('sy-base').value = s.siyuan.baseUrl || '';
    $('sy-token').value = s.siyuan.token || '';
    $('sy-root').value = s.siyuan.rootPath || '';
    $('sy-folder').value = s.siyuan.folderTemplate || '';
    $('sy-prefix').value = s.siyuan.titlePrefix || '';
    $('sy-inc-url').checked = s.siyuan.includeUrl !== false;
    $('sy-inc-time').checked = s.siyuan.includeTime !== false;
    $('sy-inc-model').checked = !!s.siyuan.includeModel;
    $('opt-enabled').checked = s.enabled !== false;
    $('opt-autosync').checked = s.autoSync !== false;
    $('opt-bubble').checked = s.bubbleEnabled !== false;
    $('opt-debug').checked = !!s.debugLog;
    $('opt-max').value = s.maxMessagesPerDoc || 500;
    $('opt-panel-layout').value = s.panelLayout === 'side' ? 'side' : 'float';
    Array.prototype.forEach.call(document.querySelectorAll('.plat'), function (input) {
      var key = input.getAttribute('data-plat');
      input.checked = !!(s.platforms && s.platforms[key]);
    });
    $('sel-override').value = JSON.stringify(s.selectorOverrides || {}, null, 2);
    fillNotebook(s.siyuan.notebookId, s.siyuan.notebookName);
  }

  function fillNotebook(id, name) {
    var sel = $('sy-notebook');
    sel.innerHTML = '';
    var opt = document.createElement('option');
    opt.value = id || '';
    opt.textContent = name ? (name + '（已保存）') : '点「测试连接并加载笔记本」获取';
    sel.appendChild(opt);
    sel.dataset.selected = id || '';
  }

  function renderNotebooks(list, selectedId) {
    var sel = $('sy-notebook');
    sel.innerHTML = '';
    var blank = document.createElement('option');
    blank.value = '';
    blank.textContent = '（未选择）';
    sel.appendChild(blank);
    list.forEach(function (n) {
      var o = document.createElement('option');
      o.value = n.id;
      o.textContent = (n.icon ? n.icon + ' ' : '') + n.name;
      if (n.id === selectedId) {
        o.selected = true;
      }
      sel.appendChild(o);
    });
  }

  function readSyForm() {
    var sel = $('sy-notebook');
    var chosen = sel.options[sel.selectedIndex];
    return {
      siyuan: {
        baseUrl: $('sy-base').value.trim() || 'http://127.0.0.1:6806',
        token: $('sy-token').value.trim(),
        rootPath: $('sy-root').value.trim() || '/AI对话',
        folderTemplate: $('sy-folder').value.trim(),
        titlePrefix: $('sy-prefix').value,
        includeUrl: $('sy-inc-url').checked,
        includeTime: $('sy-inc-time').checked,
        includeModel: $('sy-inc-model').checked,
        notebookId: sel.value,
        notebookName: chosen ? chosen.textContent.replace(/^[^ ]+ /, '') : ''
      }
    };
  }

  function readOptForm() {
    var platforms = {};
    Array.prototype.forEach.call(document.querySelectorAll('.plat'), function (input) {
      platforms[input.getAttribute('data-plat')] = input.checked;
    });
    return {
      enabled: $('opt-enabled').checked,
      autoSync: $('opt-autosync').checked,
      bubbleEnabled: $('opt-bubble').checked,
      debugLog: $('opt-debug').checked,
      maxMessagesPerDoc: parseInt($('opt-max').value, 10) || 500,
      panelLayout: $('opt-panel-layout').value === 'side' ? 'side' : 'float',
      platforms: platforms
    };
  }

  /* -------------------------------------------------- 权限 */

  // 交给 siyuan.js 统一生成，避免两处规则不一致：
  // 匹配模式不能带端口（带端口 chrome.permissions 会直接报错，授权永远拿不到）
  function originOf(baseUrl) {
    return AIME.siyuan.hostPatternOf(baseUrl);
  }

  function ensurePermission(baseUrl) {
    var origin = originOf(baseUrl);
    if (origin === '') {
      return Promise.reject(new Error('API 地址不是合法 URL'));
    }
    return new Promise(function (resolve) {
      chrome.permissions.contains({ origins: [origin] }, function (has) {
        var cerr = chrome.runtime.lastError;
        if (has) {
          resolve({ granted: true, origin: origin, error: '' });
          return;
        }
        chrome.permissions.request({ origins: [origin] }, function (granted) {
          var rerr = chrome.runtime.lastError;
          resolve({
            granted: !!granted,
            origin: origin,
            error: (rerr && rerr.message) || (cerr && cerr.message) || ''
          });
        });
      });
    });
  }

  /* -------------------------------------------------- 动作 */

  function testConnection() {
    var patch = readSyForm();
    // 授权弹窗必须在点击的同一个同步调用栈里发起：
    // 之前先 await 了一次 SETTINGS_SET，浏览器可能判定用户手势已过期而不弹窗。
    say($('test-out'), '请求访问权限…');
    return ensurePermission(patch.siyuan.baseUrl).then(function (perm) {
      if (!perm.granted) {
        say($('test-out'), '没拿到 ' + perm.origin + ' 的访问权限' +
          (perm.error ? '（' + perm.error + '）' : '') +
          '。请再点一次「测试连接」并在弹窗里选「允许」；若始终不弹窗，先到 edge://extensions 点本扩展的「重新加载」再试。', 'err');
        return null;
      }
      say($('test-out'), '保存配置…');
      return call(AIME.C.MSG.SETTINGS_SET, patch).then(function (resp) {
        settings = resp.settings;
        say($('test-out'), '连接中…（' + perm.origin + '）');
        return call(AIME.C.MSG.SIYUAN_TEST, {});
      });
    }).then(function (res) {
      if (!res) {
        return;
      }
      if (!res.ok) {
        var tips = {
          unreachable: '连不上内核：确认思源已启动，且 API 服务已开启（设置 → API）',
          blocked: '浏览器拦住了跨网段请求：需要授予该主机的访问权限（本机思源请改用 127.0.0.1 地址）。' +
            '若弹窗没出现，去 edge://extensions → 本扩展 → 详情 → 网站访问权限，手动加上 ' + originOf(settings.siyuan.baseUrl),
          'bad-token': '认证码不对：把思源「设置 → API」里的认证码复制过来',
          timeout: '请求超时：内核可能正忙或端口填错'
        };
        var tip = tips[res.error] || res.msg || '内核返回错误';
        var extraMsg = res.msg && tips[res.error] ? '｜内核：' + res.msg : '';
        say($('test-out'), '失败（' + (res.error || res.stage || '?') + '）：' + tip + extraMsg, 'err');
        return;
      }
      renderNotebooks(res.notebooks || [], settings.siyuan.notebookId);
      var extra = res.notebookSelected && !res.notebookAvailable ? '（已保存的笔记本不在打开列表里，可能被关掉了）' : '';
      var closed = (res.closedNotebooks || []).length ? '（另有 ' + res.closedNotebooks.length + ' 个已关闭笔记本未列出）' : '';
      say($('test-out'), 'OK 内核版本 ' + res.version + '，可用笔记本 ' + (res.notebooks || []).length + ' 个' + closed + extra, 'ok');
    }).catch(function (e) {
      say($('test-out'), '异常：' + e.message, 'err');
    });
  }

  function saveForm(patch, outEl, okText) {
    return call(AIME.C.MSG.SETTINGS_SET, patch).then(function (resp) {
      settings = resp.settings;
      say(outEl, okText, 'ok');
      return resp;
    }).catch(function (e) {
      say(outEl, e.message, 'err');
    });
  }

  function saveSelectorOverrides() {
    var raw = $('sel-override').value.trim();
    var parsed = null;
    if (raw === '') {
      parsed = {};
    } else {
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        say($('sel-out'), 'JSON 解析失败：' + e.message, 'err');
        return;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        say($('sel-out'), '顶层必须是 { 平台id: { 字段: [选择器] } }', 'err');
        return;
      }
    }
    saveForm({ selectorOverrides: parsed }, $('sel-out'), '已保存，下次抓取生效');
  }

  function runDiagnose() {
    say($('diag-out'), '扫描活动标签页…');
    $('diag-result').textContent = '';
    return new Promise(function (resolve, reject) {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        var t = tabs && tabs[0];
        if (!t || !t.id) {
          reject(new Error('没找到活动标签页'));
          return;
        }
        if (!/^https?:/.test(t.url || '')) {
          reject(new Error('活动标签页不是普通网页（' + (t.url || '') + '）'));
          return;
        }
        resolve(t);
      });
    }).then(function (tab) {
      return AIME.rpc.pushToTab(tab.id, AIME.C.MSG.DIAGNOSE, {});
    }).then(function (resp) {
      if (!resp || !resp.ok) {
        say($('diag-out'), '页面上没有插件的内容脚本：请先打开一个受支持平台的对话页（' + ((resp && resp.error) || '') + '）', 'err');
        return;
      }
      var p = resp.profile || {};
      say($('diag-out'), '平台 ' + (p.platform || '未识别') + '，抽取 ' + (p.extraction.messageCount || 0) + ' 条', p.extraction.messageCount ? 'ok' : 'err');
      var lines = [];
      lines.push('URL: ' + (p.url || ''));
      lines.push('抽取: ok=' + p.extraction.ok + '  via=' + (p.extraction.meta && p.extraction.meta.via) + '  警告=' + JSON.stringify(p.extraction.warnings || []));
      lines.push('首条角色: ' + (p.extraction.firstRole || '-') + '  样例: ' + (p.extraction.sample || ''));
      lines.push('');
      lines.push('滚动容器候选:');
      (p.containers || []).forEach(function (c) {
        lines.push('  ' + c);
      });
      lines.push('');
      lines.push('重复结构候选（count = 出现次数，越接近消息条数越可能是消息行）:');
      (p.repeated || []).forEach(function (r) {
        lines.push('  ' + r.selector + '  count=' + r.count + '  均文本=' + r.avgTextLen + '  含代码块=' + r.hasPre + '  例:' + r.sample);
      });
      lines.push('');
      lines.push('正文锚点候选:');
      (p.anchors || []).forEach(function (a) {
        lines.push('  ' + a);
      });
      lines.push('');
      lines.push('把上面合适的项写进下方覆盖配置，例如：');
      lines.push('{ "deepseek": { "contentAnchorSelectors": ["' + ((p.anchors || [])[0] || '.ds-markdown') + '"] } }');
      $('diag-result').textContent = lines.join(String.fromCharCode(10));
    }).catch(function (e) {
      say($('diag-out'), e.message, 'err');
    });
  }

  /* -------------------------------------------------- 列表 */

  function renderRecords(resp) {
    var tbody = $('records').querySelector('tbody');
    tbody.innerHTML = '';
    var recs = resp.records || [];
    var q = resp.queue || {};
    recs.forEach(function (r) {
      var tr = document.createElement('tr');
      var qi = q[r.memoKey];
      var cells = [
        r.platform,
        (r.title || '(无名)') + (r.paused ? ' ⏸' : ''),
        (STATUS_TEXT[r.status] || r.status) + (qi ? ' · 重试' + qi.attempts : ''),
        String(r.msgCount || 0),
        (r.lastSyncAt || r.updatedAt || '').slice(0, 16).replace('T', ' '),
        (r.docPath || (r.lastError ? '⚠ ' + r.lastError : '')) +
          ((r.lastWarnings && r.lastWarnings.length) ? ' ⚠' + r.lastWarnings.join(',') : '')
      ];
      cells.forEach(function (text) {
        var td = document.createElement('td');
        td.textContent = text;
        tr.appendChild(td);
      });
      var act = document.createElement('td');
      var rb = document.createElement('button');
      rb.textContent = '重试';
      rb.addEventListener('click', function () {
        call(AIME.C.MSG.RECORD_RETRY, { memoKey: r.memoKey }).then(function (res) {
          say($('queue-out'), res.ok ? '重试完成' : '重试未成功：' + (res.error || '') + ' ' + (res.hint || ''), res.ok ? 'ok' : 'err');
          loadRecords();
        }).catch(function (e) {
          say($('queue-out'), e.message, 'err');
        });
      });
      var db = document.createElement('button');
      db.textContent = '删除记录';
      db.addEventListener('click', function () {
        call(AIME.C.MSG.RECORD_DELETE, { memoKey: r.memoKey }).then(loadRecords).catch(function (e) {
          say($('queue-out'), e.message, 'err');
        });
      });
      act.appendChild(rb);
      act.appendChild(db);
      tr.appendChild(act);
      tbody.appendChild(tr);
    });
    if (!recs.length) {
      var tr2 = document.createElement('tr');
      var td2 = document.createElement('td');
      td2.colSpan = 7;
      td2.textContent = '还没有记录。打开一个对话页，插件抓到内容后这里就会出现。';
      tr2.appendChild(td2);
      $('records').querySelector('tbody').appendChild(tr2);
    }
    var stats = { total: Object.keys(q).length };
    $('badge-summary').textContent = '待同步 ' + stats.total + ' · 记录 ' + recs.length + ' 条';
  }

  function loadRecords() {
    return call(AIME.C.MSG.RECORDS_LIST, {}).then(renderRecords).catch(function (e) {
      say($('queue-out'), e.message, 'err');
    });
  }

  function loadLog() {
    return call(AIME.C.MSG.LOG_GET, {}).then(function (resp) {
      var rows = (resp.log || []).slice(-40).map(function (l) {
        return [l.at, l.level, l.what, l.memoKey || l.platform || '', l.error || l.message || '', l.msg || ''].filter(Boolean).join('  ');
      });
      $('log-out').textContent = rows.join(String.fromCharCode(10)) || '（空）';
    });
  }

  /* -------------------------------------------------- 初始化 */

  function bind() {
    $('btn-test').addEventListener('click', testConnection);
    $('btn-save-sy').addEventListener('click', function () {
      saveForm(readSyForm(), $('test-out'), '连接设置已保存');
    });
    $('btn-save-opt').addEventListener('click', function () {
      saveForm(readOptForm(), $('badge-summary'), '抓取设置已保存');
    });
    $('btn-save-sel').addEventListener('click', saveSelectorOverrides);
    $('btn-diagnose').addEventListener('click', runDiagnose);
    $('btn-flush').addEventListener('click', function () {
      say($('queue-out'), '重试中…');
      call(AIME.C.MSG.QUEUE_FLUSH, {}).then(function (res) {
        say($('queue-out'), '处理 ' + (res.done || 0) + ' 项，等页面 ' + (res.waiting || 0) + ' 项，剩余 ' + (res.total || 0), 'ok');
        loadRecords();
      }).catch(function (e) {
        say($('queue-out'), e.message, 'err');
      });
    });
    $('btn-clear-queue').addEventListener('click', function () {
      call(AIME.C.MSG.QUEUE_FLUSH, { clear: true }).then(function () {
        say($('queue-out'), '队列已清空（思源里已写出的内容不受影响）', 'ok');
        loadRecords();
      }).catch(function (e) {
        say($('queue-out'), e.message, 'err');
      });
    });
    $('btn-reload-records').addEventListener('click', function () {
      loadRecords();
      loadLog();
    });
  }

  function init() {
    call(AIME.C.MSG.SETTINGS_GET, {}).then(function (resp) {
      settings = resp.settings;
      fill(settings);
      return loadRecords();
    }).then(loadLog).catch(function (e) {
      say($('badge-summary'), '后台不可用：' + e.message, 'err');
    });
  }

  bind();
  init();
})();
