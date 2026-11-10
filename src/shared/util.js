/* global AIME */
'use strict';

globalThis.AIME = globalThis.AIME || {};

/**
 * 纯逻辑层：不碰 DOM、不碰 chrome.*、不发请求。
 * 因此可以在 selftest 页与设置页里直接跑单元测试。
 */
AIME.util = (function () {
  var NL = String.fromCharCode(10);
  var ROLE_LABEL = {
    user: '用户',
    assistant: 'AI',
    system: '系统',
    unknown: '未知'
  };

  function nowIso() {
    return new Date().toISOString();
  }

  function clamp(text, max) {
    var s = String(text === null || text === undefined ? '' : text);
    if (s.length <= max) {
      return s;
    }
    return s.slice(0, max) + '…';
  }

  /* ---------------------------------------------------------- 命名清洗 */

  /**
   * 思源文档名不允许出现 / 与 #，首尾空白会被去掉。
   * 统一换成全角字符，既保留辨识度又不违反约束。
   */
  function sanitizeSegment(raw, maxLen) {
    var s = String(raw === null || raw === undefined ? '' : raw);
    s = s.split('/').join('／');
    s = s.split('#').join('＃');
    s = s.split(NL).join(' ');
    s = s.replace(/\s+/g, ' ');
    s = s.trim();
    s = s.slice(0, maxLen || 80);
    while (s.length > 1 && (s.charAt(s.length - 1) === '.' || s.charAt(s.length - 1) === ' ')) {
      s = s.slice(0, -1);
    }
    if (s === '' ) {
      s = '未命名对话';
    }
    return s;
  }

  /** 拼接思源 hpath，保证以 / 开头、无空段、无尾斜杠 */
  function joinPath(segments) {
    var out = [];
    for (var i = 0; i < segments.length; i++) {
      var seg = String(segments[i] === null || segments[i] === undefined ? '' : segments[i]);
      var parts = seg.split('/');
      for (var j = 0; j < parts.length; j++) {
        var p = parts[j].trim();
        if (p !== '') {
          out.push(p);
        }
      }
    }
    if (out.length === 0) {
      return '/';
    }
    return '/' + out.join('/');
  }

  /* ---------------------------------------------------------- 文档定位 */

  /**
   * meta: { platformLabel, month, title, convIdShort }
   * 返回 { folder, title, path } —— folder 与 title 分离，便于重命名。
   */
  function buildDocLocation(settings, meta) {
    var sy = settings.siyuan;
    var template = String(sy.folderTemplate || '');
    var folderSegs = template.split('/')
      .map(function (seg) { return renderTemplate(seg, meta); })
      .filter(function (seg) { return seg !== ''; });
    var folder = joinPath([sy.rootPath].concat(folderSegs));
    var title = sanitizeSegment(renderTemplate(sy.titlePrefix + meta.title, meta), 80);
    return {
      folder: folder,
      title: title,
      path: joinPath([folder, title])
    };
  }

  function renderTemplate(str, meta) {
    var s = String(str === null || str === undefined ? '' : str);
    var map = {
      '{yyyy-MM}': meta.month,
      '{platform}': meta.platformLabel,
      '{title}': meta.title,
      '{convId}': meta.convIdShort
    };
    Object.keys(map).forEach(function (k) {
      if (s.indexOf(k) >= 0) {
        s = s.split(k).join(String(map[k] === null || map[k] === undefined ? '' : map[k]));
      }
    });
    return s.trim();
  }

  /* ---------------------------------------------------------- Markdown 组装 */

  /**
   * 文档头部（创建文档时写入）。正文消息一律用 appendBlock 单独追加，
   * 这样才能拿到每条消息对应的块 ID，实现「只改变化的块」。
   */
  function headerMarkdown(meta) {
    var lines = ['# ' + meta.title, ''];
    var props = ['- 平台：' + meta.platformLabel];
    if (meta.time) {
      props.push('- 同步时间：' + meta.time);
    }
    if (meta.url) {
      props.push('- 原对话：' + meta.url);
    }
    if (meta.convIdShort) {
      props.push('- 会话：' + meta.convIdShort);
    }
    if (meta.model) {
      props.push('- 模型：' + meta.model);
    }
    return lines.concat(props).join(NL);
  }

  /**
   * 单条消息渲染成一段 Markdown。
   * 用四级标题做角色分隔，既能在思源大纲里导航，又便于按块删除重建。
   */
  function messageMarkdown(message, index, settings) {
    var role = message.role === 'assistant' ? 'assistant'
      : (message.role === 'user' ? 'user'
        : (message.role === 'system' ? 'system' : 'unknown'));
    var label = ROLE_LABEL[role];
    var head = '#### ' + (index + 1) + '. ' + label;
    if (settings && settings.siyuan && settings.siyuan.includeTime && message.time) {
      head += ' · ' + message.time;
    }
    var body = String(message.text === null || message.text === undefined ? '' : message.text);
    if (body === '') {
      body = '（空消息）';
    }
    return head + NL + NL + body + NL;
  }

  /* ---------------------------------------------------------- 增量比对 */

  function hashList(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      out.push(String(list[i] && list[i].hash ? list[i].hash : ''));
    }
    return out;
  }

  /**
   * 比对已存消息与新抓消息，产出最小操作集。
   *
   * 策略：先裁掉公共前缀与公共后缀，剩下的中段只可能是四种情况——
   *   只有新增  -> append（流式对话的 99% 路径，一次一个块）
   *   只有删除  -> delete
   *   等长替换  -> update（编辑重发 / 重新生成）
   *   其它      -> rebuild（中段长度不等，位置语义已不可靠）
   *
   * @param {Array} oldList 已存记录 messages: [{key,hash,blockIds}]
   * @param {Array} newList 本次抓取 messages: [{key,hash,text,role}]
   * @returns {{kind:string, ops:Array, stats:Object}}
   */
  function diffMessages(oldList, newList) {
    oldList = oldList || [];
    newList = newList || [];
    var o = hashList(oldList);
    var n = hashList(newList);

    var prefix = 0;
    while (prefix < o.length && prefix < n.length && o[prefix] === n[prefix]) {
      prefix++;
    }

    var suffix = 0;
    while (
      suffix < (o.length - prefix) &&
      suffix < (n.length - prefix) &&
      o[o.length - 1 - suffix] === n[n.length - 1 - suffix]
    ) {
      suffix++;
    }

    var oldMid = o.length - prefix - suffix;
    var newMid = n.length - prefix - suffix;
    var stats = { prefix: prefix, suffix: suffix, oldMid: oldMid, newMid: newMid };

    // 只有「变化全部发生在尾部」才是真正的追加 / 删除，
    // 中段插入会让位置语义失效，必须整篇重建正文块。
    var tailAppend = oldMid === 0 && prefix === o.length;
    var tailDelete = newMid === 0 && prefix === n.length;

    if (oldMid === 0 && newMid === 0) {
      return { kind: 'none', ops: [], stats: stats };
    }
    if (tailAppend) {
      var appends = [];
      for (var i = prefix; i < n.length; i++) {
        appends.push({ op: 'append', index: i });
      }
      return { kind: 'append', ops: appends, stats: stats };
    }
    if (tailDelete) {
      var dels = [];
      for (var j = prefix; j < o.length; j++) {
        dels.push({ op: 'delete', index: j });
      }
      return { kind: 'delete', ops: dels, stats: stats };
    }
    if (oldMid === newMid) {
      var ups = [];
      for (var k = prefix; k < prefix + oldMid; k++) {
        ups.push({ op: 'update', index: k });
      }
      return { kind: 'update', ops: ups, stats: stats };
    }
    return { kind: 'rebuild', ops: [{ op: 'rebuild', count: newList.length }], stats: stats };
  }

  /** 由抓取结果构造记录里的 messages 数组（含稳定 key 与内容哈希） */
  function fingerprintMessages(messages) {
    var out = [];
    for (var i = 0; i < messages.length; i++) {
      var m = messages[i];
      var role = String(m.role || 'unknown');
      var text = String(m.text === null || m.text === undefined ? '' : m.text);
      out.push({
        key: 'm' + i + ':' + role,
        role: role,
        text: text,
        time: m.time ? String(m.time) : '',
        hash: AIME.hash.ofMessage(role, text)
      });
    }
    return out;
  }

  /** 保留旧记录的 blockIds，按 key 对齐（前缀未变时可直接复用） */
  function carryBlockIds(oldList, newList) {
    for (var i = 0; i < newList.length; i++) {
      var old = oldList && oldList[i];
      if (old && old.key === newList[i].key && old.hash === newList[i].hash) {
        newList[i].blockIds = (old.blockIds || []).slice();
      } else {
        newList[i].blockIds = [];
      }
    }
    return newList;
  }

  /* ---------------------------------------------------------- 退避 */

  function backoffMs(attempt) {
    var table = AIME.C.BACKOFF_SECONDS;
    var idx = Math.max(0, Math.min(attempt, table.length) - 1);
    if (attempt <= 0) {
      return 0;
    }
    if (attempt > table.length) {
      return table[table.length - 1] * 1000;
    }
    return table[idx] * 1000;
  }

  return {
    NL: NL,
    ROLE_LABEL: ROLE_LABEL,
    nowIso: nowIso,
    clamp: clamp,
    sanitizeSegment: sanitizeSegment,
    joinPath: joinPath,
    buildDocLocation: buildDocLocation,
    renderTemplate: renderTemplate,
    headerMarkdown: headerMarkdown,
    messageMarkdown: messageMarkdown,
    diffMessages: diffMessages,
    fingerprintMessages: fingerprintMessages,
    carryBlockIds: carryBlockIds,
    backoffMs: backoffMs
  };
})();
