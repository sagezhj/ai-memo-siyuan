/* global AIME */
'use strict';

/**
 * 自检套件。
 *
 * 本机没有 Node，无法用 jest/mocha；这个页面把真实模块（constants/util/hash/
 * markdown/siyuan/适配器与引擎）加载进来直接跑断言，等价于单元测试。
 * 覆盖：哈希、命名清洗、文档定位、增量 diff 的五种形态、块 ID 提取、
 * DOM->Markdown 序列化、以及引擎在 fixture 页面上的端到端抽取。
 */
(function () {
  var out = document.getElementById('out');
  var sum = document.getElementById('sum');
  var NL = String.fromCharCode(10);
  var pass = 0;
  var fail = 0;
  var current = '';

  function line(html, cls) {
    var d = document.createElement('div');
    d.innerHTML = html;
    if (cls) {
      d.className = cls;
    }
    out.appendChild(d);
    return d;
  }

  function esc(s) {
    return String(s).replace(/[&<>]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;';
    });
  }

  function suite(name) {
    current = name;
    line('<div class="suite">' + esc(name) + '</div>');
  }

  function eq(actual, expected, label) {
    var a = JSON.stringify(actual);
    var b = JSON.stringify(expected);
    if (a !== b) {
      throw new Error((label || '值不符') + NL + '  期望 ' + b + NL + '  实际 ' + a);
    }
    return true;
  }

  function truthy(v, label) {
    if (!v) {
      throw new Error((label || '期望为真') + '，实际 ' + JSON.stringify(v));
    }
    return true;
  }

  function test(name, fn) {
    try {
      fn();
      pass++;
      line('  <span class="pass">PASS</span> ' + esc(name));
    } catch (e) {
      fail++;
      line('  <span class="fail">FAIL</span> ' + esc(name));
      var d = document.createElement('div');
      d.className = 'detail';
      d.textContent = String(e && e.message ? e.message : e);
      out.appendChild(d);
    }
  }

  /* =============================================== 纯逻辑 */

  suite('1. 哈希与指纹');

  test('同一内容哈希稳定', function () {
    var a = AIME.hash.ofMessage('user', '你好，世界');
    var b = AIME.hash.ofMessage('user', '你好，世界');
    eq(a, b);
    eq(a.length, 16);
  });

  test('内容或角色变化都会改哈希', function () {
    var base = AIME.hash.ofMessage('user', '甲');
    truthy(base !== AIME.hash.ofMessage('user', '乙'), '文本变化');
    truthy(base !== AIME.hash.ofMessage('assistant', '甲'), '角色变化');
  });

  test('指纹数组带 key/role/hash', function () {
    var list = AIME.util.fingerprintMessages([{ role: 'user', text: '一' }, { role: 'assistant', text: '二' }]);
    eq(list.length, 2);
    eq(list[0].key, 'm0:user');
    eq(list[1].key, 'm1:assistant');
    eq(list[0].hash.length, 16);
    eq(list[0].blockIds, undefined);
  });

  test('carryBlockIds 只在 key 与 hash 都相同时保留块', function () {
    var old = AIME.util.fingerprintMessages([{ role: 'user', text: '一' }, { role: 'assistant', text: '二' }]);
    old[0].blockIds = ['b1', 'b2'];
    old[1].blockIds = ['b3'];
    var neu = AIME.util.fingerprintMessages([{ role: 'user', text: '一' }, { role: 'assistant', text: '改了' }]);
    AIME.util.carryBlockIds(old, neu);
    eq(neu[0].blockIds, ['b1', 'b2'], '未变的消息保留块引用');
    eq(neu[1].blockIds, [], '内容变了必须清空');
  });

  suite('2. 命名清洗与文档定位');

  test('斜杠与井号替换为全角', function () {
    eq(AIME.util.sanitizeSegment('a/b#c', 80), 'a／b＃c');
  });

  test('空白与空串兜底', function () {
    eq(AIME.util.sanitizeSegment('   ', 80), '未命名对话');
    eq(AIME.util.sanitizeSegment('  多  空格  ', 80), '多 空格');
  });

  test('超长截断', function () {
    var long = '';
    for (var i = 0; i < 100; i++) {
      long += 'x';
    }
    eq(AIME.util.sanitizeSegment(long, 80).length, 80);
  });

  test('joinPath 规范化', function () {
    eq(AIME.util.joinPath([]), '/');
    eq(AIME.util.joinPath(['/', '/a//', 'b/']), '/a/b');
    eq(AIME.util.joinPath(['/AI对话', '2026-11', 'DeepSeek']), '/AI对话/2026-11/DeepSeek');
  });

  test('buildDocLocation 按模板展开', function () {
    var s = JSON.parse(JSON.stringify(AIME.C.DEFAULT_SETTINGS));
    s.siyuan.rootPath = '/AI对话';
    s.siyuan.folderTemplate = '{yyyy-MM}/{platform}';
    s.siyuan.titlePrefix = '';
    var meta = { platformLabel: 'DeepSeek', month: '2026-11', title: '关于 / 重构#1', convIdShort: 'abcd1234' };
    var loc = AIME.util.buildDocLocation(s, meta);
    eq(loc.folder, '/AI对话/2026-11/DeepSeek');
    eq(loc.title, '关于 ／ 重构＃1');
    eq(loc.path, '/AI对话/2026-11/DeepSeek/关于 ／ 重构＃1');
  });

  test('文档头：只写非空的元信息行', function () {
    var md = AIME.util.headerMarkdown({
      title: '测试对话',
      platformLabel: 'DeepSeek',
      time: '',
      url: 'https://chat.deepseek.com/a/chat/s/abc',
      convIdShort: 'abc',
      model: 'deepseek-chat'
    });
    eq(md, '# 测试对话' + NL + NL +
      '- 平台：DeepSeek' + NL +
      '- 原对话：https://chat.deepseek.com/a/chat/s/abc' + NL +
      '- 会话：abc' + NL +
      '- 模型：deepseek-chat');
  });

  test('标题前缀参与清洗', function () {
    var s = JSON.parse(JSON.stringify(AIME.C.DEFAULT_SETTINGS));
    s.siyuan.titlePrefix = 'AI ';
    var loc = AIME.util.buildDocLocation(s, { platformLabel: '元宝', month: '2026-11', title: '写周报', convIdShort: 'x1' });
    eq(loc.title, 'AI 写周报');
  });

  test('退避曲线单调且封顶', function () {
    var b = AIME.util.backoffMs;
    eq(b(0), 0);
    truthy(b(1) < b(2), '递增');
    truthy(b(2) < b(3), '递增');
    eq(b(99), AIME.C.BACKOFF_SECONDS[AIME.C.BACKOFF_SECONDS.length - 1] * 1000);
  });

  /* =============================================== 增量 diff */

  suite('3. 增量 diff（决定写思源的块操作）');

  function fp(texts) {
    return AIME.util.fingerprintMessages(texts.map(function (t, i) {
      return { role: i % 2 === 0 ? 'user' : 'assistant', text: t };
    }));
  }

  function kinds(oldTexts, newTexts) {
    return AIME.util.diffMessages(fp(oldTexts), fp(newTexts));
  }

  test('完全一致 -> none，零写入', function () {
    var d = kinds(['一', '二'], ['一', '二']);
    eq(d.kind, 'none');
    eq(d.ops.length, 0);
  });

  test('尾部新增一条 -> append 1 个块（流式对话的主路径）', function () {
    var d = kinds(['一', '二'], ['一', '二', '三']);
    eq(d.kind, 'append');
    eq(d.ops.map(function (o) { return o.index; }), [2]);
    eq(d.stats.prefix, 2);
  });

  test('一次新增多条 -> 按索引升序 append', function () {
    var d = kinds(['一'], ['一', '二', '三', '四']);
    eq(d.kind, 'append');
    eq(d.ops.map(function (o) { return o.index; }), [1, 2, 3]);
  });

  test('中间某条被改 -> update 且只针对该索引', function () {
    var d = kinds(['一', '二', '三'], ['一', '改', '三']);
    eq(d.kind, 'update');
    eq(d.ops.map(function (o) { return o.index; }), [1]);
  });

  test('多条同时被改（重新生成） -> 逐条 update', function () {
    var d = kinds(['一', '二', '三'], ['一', '改2', '改3']);
    eq(d.kind, 'update');
    eq(d.ops.map(function (o) { return o.index; }), [1, 2]);
  });

  test('尾部删除 -> delete', function () {
    var d = kinds(['一', '二', '三'], ['一', '二']);
    eq(d.kind, 'delete');
    eq(d.ops.map(function (o) { return o.index; }), [2]);
  });

  test('中段插入不能误判为 append -> rebuild', function () {
    var d = kinds(['一', '二', '三'], ['一', '插', '二', '三']);
    truthy(d.kind !== 'append', '必须不是 append，实际 ' + d.kind);
    eq(d.kind, 'rebuild');
  });

  test('中段删除 -> rebuild', function () {
    var d = kinds(['一', '二', '三'], ['一', '三']);
    eq(d.kind, 'rebuild');
  });

  test('空记录 -> 全部视为 rebuild/append 起点', function () {
    var d = AIME.util.diffMessages([], fp(['一', '二']));
    eq(d.kind, 'append');
    eq(d.ops.length, 2);
  });

  /* =============================================== DOM -> Markdown */

  suite('4. DOM -> Markdown 序列化');

  function h(html) {
    var d = document.createElement('div');
    d.innerHTML = html;
    return d;
  }

  test('行内格式：粗体 / 行内码', function () {
    eq(AIME.md.toMarkdown(h('<div><p>Hello <strong>world</strong> and <code>x=1</code>.</p></div>')),
      'Hello **world** and `x=1`.');
  });

  test('div 套 div 不产生多余空行', function () {
    eq(AIME.md.toMarkdown(h('<div><div><p>a</p></div><div><p>b</p></div></div>')), 'a' + NL + NL + 'b');
  });

  test('标题按 headingShift 降级', function () {
    eq(AIME.md.toMarkdown(h('<div><h2>标题</h2><p>正文</p></div>'), { headingShift: 2 }),
      '#### 标题' + NL + NL + '正文');
  });

  test('代码块保留围栏与语言', function () {
    eq(AIME.md.toMarkdown(h('<pre><code class="language-python">print(1)</code></pre>')),
      '```python' + NL + 'print(1)' + NL + '```');
  });

  test('代码块行号列被剔除', function () {
    var fx = '<pre><code>1    line one' + NL + '2    line two</code></pre>';
    eq(AIME.md.toMarkdown(h(fx)), '```' + NL + 'line one' + NL + 'line two' + NL + '```');
  });

  test('围栏长度自动避让内容里的反引号', function () {
    var fx = '<pre><code>a ``` b</code></pre>';
    eq(AIME.md.toMarkdown(h(fx)), '````' + NL + 'a ``` b' + NL + '````');
  });

  test('嵌套列表缩进', function () {
    eq(AIME.md.toMarkdown(h('<ul><li>一</li><li>二<ul><li>子</li></ul></li></ul>')),
      '- 一' + NL + '- 二' + NL + '  - 子');
  });

  test('嵌套有序列表保留编号与三空格缩进', function () {
    eq(AIME.md.toMarkdown(h('<ul><li>一</li><li>二<ol><li>子</li></ol></li></ul>')),
      '- 一' + NL + '- 二' + NL + '  1. 子');
  });

  test('表格转 Markdown 并转义竖线', function () {
    var fx = '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>x|y</td></tr></tbody></table>';
    eq(AIME.md.toMarkdown(h(fx)),
      '| A | B |' + NL + '| --- | --- |' + NL + '| 1 | x\\|y |');
  });

  test('引用块前缀', function () {
    eq(AIME.md.toMarkdown(h('<blockquote><p>引用</p></blockquote>')), '> 引用');
  });

  test('按钮与 svg 不混进正文', function () {
    eq(AIME.md.toMarkdown(h('<div><p>正文</p><button>复制</button><svg></svg></div>')), '正文');
  });

  test('br 保留为两空格硬换行', function () {
    eq(AIME.md.toMarkdown(h('<p>第一行<br>第二行</p>')), '第一行  ' + NL + '第二行');
  });

  test('空容器返回空串', function () {
    eq(AIME.md.toMarkdown(h('')), '');
    eq(AIME.md.toMarkdown(h('<div><span> </span></div>')), '');
  });

  test('markSkip 临时屏蔽噪声子树', function () {
    var el = h('<div><p>keep</p><span class="op">按钮</span></div>');
    var marked = AIME.md.markSkip(el, ['.op']);
    var md = AIME.md.toMarkdown(el);
    AIME.md.unmarkSkip(marked);
    eq(md, 'keep');
    eq(el.querySelector('.op').hasAttribute('data-aime-skip'), false, '标记已还原');
  });

  test('混合 loose 文本与块级结构', function () {
    eq(AIME.md.toMarkdown(h('<div>前导<p>段落</p>尾部</div>')),
      '前导' + NL + NL + '段落' + NL + NL + '尾部');
  });

  /* =============================================== 思源响应解析 */

  suite('5. 思源 API 响应解析');

  test('normalizeBase 补协议、去尾斜杠、空值兜底', function () {
    eq(AIME.siyuan.normalizeBase(''), 'http://127.0.0.1:6806');
    eq(AIME.siyuan.normalizeBase('http://a:6806/'), 'http://a:6806');
    eq(AIME.siyuan.normalizeBase('127.0.0.1:6806'), 'http://127.0.0.1:6806');
    eq(AIME.siyuan.normalizeBase('https://note.local/siyuan'), 'https://note.local/siyuan');
  });

  test('host 权限模式必须去端口（带端口 Chrome 会拒绝授权）', function () {
    eq(AIME.siyuan.hostPatternOf('http://192.168.50.11:8026'), 'http://192.168.50.11/*');
    eq(AIME.siyuan.hostPatternOf('192.168.50.11:8026'), 'http://192.168.50.11/*');
    eq(AIME.siyuan.hostPatternOf('https://note.local:8443/siyuan'), 'https://note.local/*');
    eq(AIME.siyuan.hostPatternOf('http://[::1]:6806'), 'http://[::1]/*');
    truthy(!/:\d+\//.test(AIME.siyuan.hostPatternOf('http://192.168.50.11:8026')), '模式里不能残留端口');
  });

  test('回环判定：本机地址免弹窗，局域网地址需要授权', function () {
    truthy(AIME.siyuan.isLoopbackHost('http://127.0.0.1:6806'), '127.0.0.1');
    truthy(AIME.siyuan.isLoopbackHost('http://localhost:6806'), 'localhost');
    truthy(!AIME.siyuan.isLoopbackHost('http://192.168.50.11:8026'), '局域网地址不是回环');
    truthy(!AIME.siyuan.isLoopbackHost('https://note.local'), '域名不是回环');
  });

  test('索引未就绪识别为可重试的 transient 错误', function () {
    truthy(AIME.siyuan.isIndexNotReady({ ok: false, error: 'siyuan--1', msg: 'document metadata is not ready' }), 'msg 命中');
    truthy(AIME.siyuan.isIndexNotReady({ ok: false, error: 'siyuan--1', msg: '', data: { reason: 'indexUnavailable' } }), 'reason 命中');
    truthy(!AIME.siyuan.isIndexNotReady({ ok: false, error: 'bad-token', msg: 'Auth failed' }), '认证错不算');
    truthy(!AIME.siyuan.isIndexNotReady({ ok: true, data: 'x' }), '成功不算');
  });

  test('从 doOperations 抽取顶层块 ID', function () {
    var data = [{
      doOperations: [
        { action: 'insert', id: 'i1', parentID: 'doc1' },
        { action: 'insert', id: 'i2', parentID: 'doc1' },
        { action: 'insert', id: 'i3', parentID: 'other' },
        { action: 'update', id: 'i4' }
      ]
    }];
    eq(AIME.siyuan.collectBlockIds(data, 'doc1'), ['i1', 'i2', 'i4']);
  });

  test('parentID 全缺失时退回全量，避免拿不到 ID', function () {
    var data = [{ doOperations: [{ action: 'insert', id: 'x1' }, { action: 'insert', id: 'x2' }] }];
    eq(AIME.siyuan.collectBlockIds(data, 'doc1'), ['x1', 'x2']);
  });

  test('兼容 data 直接是对象 / 数组 / 空', function () {
    eq(AIME.siyuan.collectBlockIds({ id: 'solo' }, ''), ['solo']);
    eq(AIME.siyuan.collectBlockIds([], 'doc1'), []);
    eq(AIME.siyuan.collectBlockIds(undefined, 'doc1'), []);
  });

  /* =============================================== 引擎 */

  suite('6. 抽取引擎与适配器');

  function settingsCopy(mut) {
    var s = JSON.parse(JSON.stringify(AIME.C.DEFAULT_SETTINGS));
    if (mut) {
      mut(s);
    }
    return s;
  }

  function fakeDoc(html, title) {
    var body = document.createElement('div');
    body.innerHTML = html;
    return {
      body: body,
      title: title || '未命名',
      querySelector: function (sel) {
        return body.querySelector(sel);
      },
      querySelectorAll: function (sel) {
        return Array.prototype.slice.call(body.querySelectorAll(sel));
      }
    };
  }

  var DS_URL = 'https://chat.deepseek.com/a/chat/s/12345678-90ab-cdef-1234-567890abcdef';

  var DS_FIXTURE =
    '<div class="chat">' +
    '<div class="message-item from-user"><div class="ds-markdown"><p>问题一</p></div></div>' +
    '<div class="message-item from-assistant"><div class="ds-markdown"><p>回答一</p>' +
    '<pre><code class="language-js">let a=1</code></pre><button>复制</button></div></div>' +
    '<div class="message-item from-user"><div class="ds-markdown"><p>问题二</p></div></div>' +
    '</div>';

  test('pickPlatform 按域名路由', function () {
    eq(AIME.engine.pickPlatform(DS_URL).id, 'deepseek');
    eq(AIME.engine.pickPlatform('https://yuanbao.tencent.com/chat/abc12345').id, 'yuanbao');
    eq(AIME.engine.pickPlatform('https://www.qianwen.com/chat/abc12345').id, 'qwen');
    eq(AIME.engine.pickPlatform('https://chat.qwen.ai/chat/abc12345').id, 'qwen');
    eq(AIME.engine.pickPlatform('https://example.com/x').id, 'generic');
    eq(AIME.engine.pickPlatform('not-a-url'), null);
  });

  test('选择器覆盖按顺序前置', function () {
    var s = settingsCopy(function (x) {
      x.selectorOverrides = { deepseek: { rowSelectors: ['.my-row'] } };
    });
    var d = AIME.engine.getDescriptor('deepseek', s);
    eq(d.rowSelectors[0], '.my-row');
    truthy(d.rowSelectors.length > 1, '原始候选仍保留在后面');
  });

  test('平台开关关闭时不抽取', function () {
    var s = settingsCopy(function (x) {
      x.platforms.deepseek = false;
    });
    var r = AIME.engine.extract(DS_URL, s, fakeDoc(DS_FIXTURE, '测试对话 - DeepSeek'));
    eq(r.ok, false);
    eq(r.warnings, ['platform-disabled']);
  });

  test('DeepSeek fixture：行数 / 角色 / convId / 代码块 / 标题', function () {
    var r = AIME.engine.extract(DS_URL, settingsCopy(), fakeDoc(DS_FIXTURE, '测试对话 - DeepSeek'));
    eq(r.ok, true);
    eq(r.platform, 'deepseek');
    eq(r.convId, '12345678-90ab-cdef-1234-567890abcdef');
    eq(r.convIdSource, 'url');
    eq(r.messages.length, 3);
    eq(r.messages.map(function (m) { return m.role; }), ['user', 'assistant', 'user']);
    eq(r.messages[0].text, '问题一');
    truthy(r.messages[1].text.indexOf('```js' + NL + 'let a=1') >= 0, '代码块应保留，实到：' + r.messages[1].text);
    eq(r.messages[1].text.indexOf('复制'), -1);
    eq(r.title, '测试对话');
    eq(r.meta.via, 'rows');
  });

  test('行选择器全落空时用正文锚点反推行', function () {
    var fx = '<div class="chat"><div><div class="ds-markdown"><p>问</p></div></div>' +
      '<div><div class="ds-markdown"><p>答</p></div></div></div>';
    var r = AIME.engine.extract(DS_URL, settingsCopy(), fakeDoc(fx, '锚点会话'));
    eq(r.ok, true);
    eq(r.meta.via, 'anchors');
    eq(r.messages.length, 2);
    eq(r.messages.map(function (m) { return m.role; }), ['user', 'assistant']);
    truthy(r.warnings.indexOf('rows-by-anchor-fallback') >= 0, '应记录降级警告');
  });

  test('URL 无会话 ID 时退化为指纹 ID 并警告', function () {
    var r = AIME.engine.extract('https://chat.deepseek.com/', settingsCopy(), fakeDoc(DS_FIXTURE, '无 ID 会话'));
    eq(r.ok, true);
    eq(r.convIdSource, 'fingerprint');
    truthy(/^sig-/.test(r.convId), 'convId 以 sig- 开头');
    truthy(r.warnings.indexOf('no-conv-id-in-url') >= 0);
  });

  test('空页面安全返回，不抛异常', function () {
    var r = AIME.engine.extract(DS_URL, settingsCopy(), fakeDoc('<div></div>', '空'));
    eq(r.ok, false);
    truthy(r.warnings.indexOf('no-rows') >= 0);
    eq(r.messages.length, 0);
  });

  test('连续同角色合并为一条（保留一问一答语义）', function () {
    var fx = '<div class="chat">' +
      '<div class="message-item from-assistant"><div class="ds-markdown"><p>上半</p></div></div>' +
      '<div class="message-item from-assistant"><div class="ds-markdown"><p>下半</p></div></div>' +
      '</div>';
    var r = AIME.engine.extract(DS_URL, settingsCopy(), fakeDoc(fx, '合并'));
    eq(r.messages.length, 1);
    eq(r.messages[0].role, 'assistant');
    eq(r.messages[0].text, '上半' + NL + NL + '下半');
  });

  test('消息数超上限被截断并警告', function () {
    var rows = '';
    for (var i = 0; i < 6; i++) {
      rows += '<div class="message-item ' + (i % 2 === 0 ? 'from-user' : 'from-assistant') +
        '"><div class="ds-markdown"><p>第' + i + '条</p></div></div>';
    }
    var s = settingsCopy(function (x) {
      x.maxMessagesPerDoc = 3;
    });
    var r = AIME.engine.extract(DS_URL, s, fakeDoc(rows, '超长'));
    eq(r.messages.length, 3);
    truthy(r.warnings.indexOf('over-max-messages-truncated') >= 0);
  });

  test('元宝 / 千问描述符可用且锚点候选非空', function () {
    var y = AIME.engine.getDescriptor('yuanbao', settingsCopy());
    var q = AIME.engine.getDescriptor('qwen', settingsCopy());
    truthy(y.contentAnchorSelectors.length > 0, '元宝需要锚点候选');
    truthy(q.contentAnchorSelectors.length > 0, '千问需要锚点候选');
    truthy(y.convIdPatterns.length > 0 && q.convIdPatterns.length > 0, '需要 URL 会话 ID 正则');
    // 描述符要能安全 JSON 克隆（正则字面量会丢字段，故必须存字符串）
    eq(typeof y.convIdPatterns[0], 'string');
    eq(JSON.stringify(q).indexOf('[object RegExp]') < 0, true);
  });

  suite('7. 会话面板纯逻辑');

  test('relTime 相对时间分档与兜底', function () {
    var h = AIME.bubble.helpers;
    var now = Date.UTC(2026, 10, 9, 12, 0, 0);
    eq(h.relTime('', now), '');
    eq(h.relTime('not-a-date', now), '');
    eq(h.relTime(new Date(now - 30000).toISOString(), now), '刚刚');
    eq(h.relTime(new Date(now - 5 * 60000).toISOString(), now), '5 分钟前');
    eq(h.relTime(new Date(now - 3 * 3600000).toISOString(), now), '3 小时前');
    eq(h.relTime(new Date(now - 2 * 86400000).toISOString(), now), '2 天前');
    eq(h.relTime('2026-01-02T03:04:05Z', now), '2026-01-02');
    // 未来时间按 0 处理，不出现负数
    eq(h.relTime(new Date(now + 60000).toISOString(), now), '刚刚');
  });

  test('rowView 暂停优先 / 队列覆盖 / 状态兜底', function () {
    var h = AIME.bubble.helpers;
    eq(h.rowView({ paused: true, status: 'error' }, { attempts: 2, payload: {} }), { text: '已暂停', tone: 'paused' });
    eq(h.rowView({ status: 'error' }, { attempts: 3, payload: { messages: [] } }), { text: '待同步 · 重试3', tone: 'pending' });
    eq(h.rowView({ status: 'synced' }, { attempts: 1, payload: null }), { text: '等页面回开 · 重试1', tone: 'pending' });
    eq(h.rowView({ status: 'error' }, { attempts: 13, exhausted: true, payload: {} }).tone, 'error');
    truthy(h.rowView({ status: 'error' }, { attempts: 13, exhausted: true, payload: {} }).text.indexOf('重试耗尽') >= 0);
    eq(h.rowView({ status: 'synced' }, null), { text: '已同步', tone: 'synced' });
    eq(h.rowView({}, null), { text: '待写入', tone: 'init' });
    eq(h.rowView({ status: 'weird' }, null), { text: 'weird', tone: 'weird' });
  });

  test('filterRecords 搜索命中平台显示名 / 标题 / 路径，当前会话置顶且其余顺序不变', function () {
    var h = AIME.bubble.helpers;
    var recs = [
      { memoKey: 'qwen:a', platform: 'qwen', title: '你好世界', url: 'https://chat.qwen.ai/a', docPath: '/AI对话/2026-11/千问/你好世界', updatedAt: '2026-11-09T10:00:00Z' },
      { memoKey: 'deepseek:b', platform: 'deepseek', title: '测试 DeepSeek', url: 'https://chat.deepseek.com/b', docPath: '/AI对话/2026-11/DeepSeek/测试', updatedAt: '2026-11-09T09:00:00Z' },
      { memoKey: 'yuanbao:c', platform: 'yuanbao', title: '元宝聊天', url: 'https://yuanbao.tencent.com/c', docPath: '/AI对话/2026-11/元宝/元宝聊天', updatedAt: '2026-11-09T08:00:00Z' }
    ];
    eq(h.filterRecords(recs, 'deepseek', '').map(function (r) { return r.memoKey; }), ['deepseek:b']);
    eq(h.filterRecords(recs, '千问', '').map(function (r) { return r.memoKey; }), ['qwen:a']);
    eq(h.filterRecords(recs, '2026-11/元宝', '').map(function (r) { return r.memoKey; }), ['yuanbao:c']);
    eq(h.filterRecords(recs, 'zzz不存在', ''), []);
    var pinned = h.filterRecords(recs, '', 'yuanbao:c');
    eq(pinned.map(function (r) { return r.memoKey; }), ['yuanbao:c', 'qwen:a', 'deepseek:b']);
    // 不改动原数组
    eq(recs[0].memoKey, 'qwen:a');
    eq(h.filterRecords([], '', 'x'), []);
  });

  /* =============================================== 汇总 */

  function finish() {
    var text = fail === 0
      ? '全部通过：' + pass + ' 项'
      : '通过 ' + pass + ' 项，失败 ' + fail + ' 项';
    sum.innerHTML = '<span class="' + (fail === 0 ? 'pass' : 'fail') + '">' + esc(text) + '</span>' +
      ' <span class="detail">覆盖：哈希 / 清洗 / diff / Markdown / 思源响应解析 / 抽取引擎 / 会话面板</span>';
    document.title = (fail === 0 ? '✓ ' : '✗ ') + text;
    if (fail > 0) {
      var firstBad = document.querySelector('.fail');
      if (firstBad && firstBad.scrollIntoView) {
        firstBad.scrollIntoView({ block: 'center' });
      }
    }
  }

  finish();
})();
