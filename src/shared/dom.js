/* global AIME */
'use strict';

globalThis.AIME = globalThis.AIME || {};

/**
 * DOM 查询助手（仅 content 侧使用）。
 * 所有选择器都以「候选数组」形式提供：AI 网站改版时只要往数组里加一项，
 * 或是在设置页写覆盖配置，不必改代码。
 */
AIME.dom = (function () {
  var NOISE_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, TEXTAREA: 1, SELECT: 1, BUTTON: 1, SVG: 1, CANVAS: 1, IFRAME: 1, VIDEO: 1, AUDIO: 1 };

  function firstMatch(root, selectors) {
    if (!root || !selectors) {
      return null;
    }
    for (var i = 0; i < selectors.length; i++) {
      try {
        var el = root.querySelector(selectors[i]);
        if (el) {
          return el;
        }
      } catch (e) {
        // 非法选择器直接跳过，不让一个坏配置拖垮整次抽取
      }
    }
    return null;
  }

  function allMatches(root, selectors) {
    var out = [];
    if (!root || !selectors) {
      return out;
    }
    for (var i = 0; i < selectors.length; i++) {
      try {
        var list = root.querySelectorAll(selectors[i]);
        if (list && list.length) {
          return Array.prototype.slice.call(list);
        }
      } catch (e) {
        /* ignore */
      }
    }
    return out;
  }

  function closestAny(el, selectors) {
    var cur = el;
    var depth = 0;
    while (cur && cur.nodeType === 1 && depth < 12) {
      for (var i = 0; i < selectors.length; i++) {
        try {
          if (cur.matches(selectors[i])) {
            return cur;
          }
        } catch (e) {
          /* ignore */
        }
      }
      cur = cur.parentElement;
      depth++;
    }
    return null;
  }

  /** 是否大致可见（用于跳过隐藏的历史/草稿节点） */
  function isRendered(el) {
    if (!el || el.nodeType !== 1) {
      return false;
    }
    if (el.hidden) {
      return false;
    }
    var cs = null;
    try {
      cs = window.getComputedStyle(el);
    } catch (e) {
      cs = null;
    }
    if (cs) {
      if (cs.display === 'none' || cs.visibility === 'hidden') {
        return false;
      }
      if (parseFloat(cs.opacity || '1') === 0) {
        return false;
      }
    }
    var r = null;
    try {
      r = el.getBoundingClientRect();
    } catch (e) {
      r = null;
    }
    // 游离节点（自检里的 fixture、尚未挂载的子树）尺寸恒为 0，不能据此判不可见
    var attached = el.isConnected === undefined ? true : el.isConnected;
    if (r && attached && r.width === 0 && r.height === 0) {
      return false;
    }
    return true;
  }

  /** data-* / class 里的角色线索 */
  function roleFromAttributes(el) {
    var keys = ['data-role', 'data-message-role', 'data-from', 'data-sender', 'data-type', 'data-position', 'data-author'];
    for (var i = 0; i < keys.length; i++) {
      var v = el.getAttribute && el.getAttribute(keys[i]);
      if (v) {
        var role = normalizeRole(v);
        if (role !== 'unknown') {
          return role;
        }
      }
    }
    var cls = (el.className && typeof el.className === 'string') ? el.className : '';
    if (/\b(from-user|is-user|user-message|message-user|question)/i.test(cls)) {
      return 'user';
    }
    if (/\b(from-assistant|is-assistant|assistant-message|message-assistant|ai-message|answer|bot)/i.test(cls)) {
      return 'assistant';
    }
    return 'unknown';
  }

  function normalizeRole(raw) {
    var s = String(raw || '').toLowerCase();
    if (/^(user|human|me|question|q)$/.test(s) || s.indexOf('user') >= 0 || s.indexOf('human') >= 0) {
      return 'user';
    }
    if (s === 'ai' || s === 'bot' || s === 'model' || s === 'assistant' || s === 'answer' ||
        s.indexOf('assistant') >= 0 || s.indexOf('ai-') >= 0 || s.indexOf('bot') >= 0 || s.indexOf('model') >= 0) {
      return 'assistant';
    }
    if (s.indexOf('system') >= 0) {
      return 'system';
    }
    return 'unknown';
  }

  function isNoiseTag(el) {
    return !!(el && NOISE_TAGS[el.tagName]);
  }

  /** 供适配器复用：按候选选择器收集消息行，过滤噪声与零宽节点 */
  function collectRows(root, selectors, skipSelectors) {
    var nodes = allMatches(root, selectors);
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!isRendered(el)) {
        continue;
      }
      if (skipSelectors && firstMatch(el, skipSelectors) === el) {
        continue;
      }
      if (el.textContent.replace(/\s+/g, '') === '') {
        continue;
      }
      out.push(el);
    }
    return out;
  }

  return {
    firstMatch: firstMatch,
    allMatches: allMatches,
    closestAny: closestAny,
    isRendered: isRendered,
    roleFromAttributes: roleFromAttributes,
    normalizeRole: normalizeRole,
    isNoiseTag: isNoiseTag,
    collectRows: collectRows
  };
})();
