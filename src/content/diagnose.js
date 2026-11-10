/* global AIME */
'use strict';

globalThis.AIME = globalThis.AIME || {};

/**
 * 选择器诊断（content 侧）。
 *
 * 三个 AI 站点的类名会随版本变化，这套工具的职责是：在当前页面上统计
 * 「重复结构」并反推候选选择器，让你在设置页照着填覆盖配置，
 * 而不是打开 DevTools 一个个试。
 */
AIME.diagnose = (function () {
  // 明显是构建产物哈希的类名，不适合当选择器
  var VOLATILE = /^(_|css-|sc-|jsx-|_r_|hover|focus|active|disabled|is-|has-)/i;
  var VOLATILE_HASH = /[0-9a-f]{6,}/i;

  function stableTokens(el) {
    var cls = (el.className && typeof el.className === 'string') ? el.className : '';
    var tokens = cls.split(/\s+/).filter(function (t) {
      if (t.length < 3 || t.length > 28) {
        return false;
      }
      if (VOLATILE.test(t) || VOLATILE_HASH.test(t)) {
        return false;
      }
      return /^[A-Za-z][A-Za-z0-9_-]*$/.test(t);
    });
    return tokens;
  }

  function dataAttrs(el) {
    var out = [];
    if (!el.attributes) {
      return out;
    }
    for (var i = 0; i < el.attributes.length; i++) {
      var a = el.attributes[i];
      if (a.name.indexOf('data-') === 0 && a.name.length > 5) {
        out.push(a.name);
      }
    }
    return out.sort();
  }

  function signature(el) {
    var tokens = stableTokens(el);
    var pick = tokens.length ? tokens[tokens.length - 1] : '';
    var datas = dataAttrs(el);
    var sel = el.tagName.toLowerCase();
    if (datas.length) {
      sel += '[' + datas[0] + ']';
    } else if (pick) {
      sel += '[class*="' + pick + '"]';
    }
    return {
      selector: sel,
      key: sel + '|' + el.tagName + '|' + tokens.slice(0, 3).sort().join('.'),
      tokenCount: tokens.length
    };
  }

  /** 找页面里最像「消息滚动容器」的元素 */
  function scrollContainers(doc) {
    var out = [];
    var all = doc.body ? doc.body.querySelectorAll('div, main, section') : [];
    for (var i = 0; i < all.length && out.length < 6; i++) {
      var el = all[i];
      var overflowY = '';
      try {
        overflowY = window.getComputedStyle(el).overflowY;
      } catch (e) {
        overflowY = '';
      }
      if (overflowY !== 'auto' && overflowY !== 'scroll') {
        continue;
      }
      if (el.scrollHeight > el.clientHeight + 120 && el.clientHeight > 200) {
        out.push(el);
      }
    }
    return out;
  }

  function repeatStats(scope, limit) {
    var buckets = {};
    var order = [];
    var nodes = scope.querySelectorAll('div, section, article, li');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var sig = signature(el);
      if (!sig.selector || !stableTokens(el).length && !dataAttrs(el).length) {
        continue;
      }
      var text = el.textContent || '';
      if (text.length < 8) {
        continue;
      }
      if (!buckets[sig.key]) {
        buckets[sig.key] = { selector: sig.selector, count: 0, textLen: 0, hasPre: 0, sample: '' };
        order.push(sig.key);
      }
      var b = buckets[sig.key];
      b.count++;
      b.textLen += text.length;
      if (el.querySelector('pre')) {
        b.hasPre++;
      }
      if (b.sample.length < 40 && text.length > 20) {
        b.sample = text.slice(0, 40);
      }
    }
    var list = order.map(function (k) {
      var b = buckets[k];
      b.avgTextLen = Math.round(b.textLen / Math.max(1, b.count));
      return b;
    }).filter(function (b) {
      return b.count >= 2;
    });
    // 只保留「不被计数更高的候选包含」的粗筛：按 count 降序，去掉 selector 完全重合前缀的
    list.sort(function (a, b) {
      return b.count - a.count;
    });
    return list.slice(0, limit || 10);
  }

  /** 供设置页展示：当前页面的结构画像 */
  function profile(url) {
    var scope = AIME.engine.pickPlatform(url);
    var containers = scrollContainers(document);
    var stats = [];
    for (var i = 0; i < containers.length; i++) {
      stats = stats.concat(repeatStats(containers[i], 8));
    }
    // 正文锚点候选：包含 pre / 长文本 / markdown 类名
    var anchors = [];
    var cand = document.querySelectorAll('[class*="markdown"], [class*="Markdown"], [class*="prose"], pre');
    var seen = {};
    for (var j = 0; j < cand.length && anchors.length < 8; j++) {
      var s = signature(cand[j]);
      if (!seen[s.selector]) {
        seen[s.selector] = 1;
        anchors.push(s.selector);
      }
    }
    var probe = AIME.engine.extract(url, AIME.C.DEFAULT_SETTINGS, document);
    return {
      url: url,
      platform: scope ? scope.id : '',
      containers: containers.map(function (el) {
        var sig = signature(el);
        return sig.selector + ' (h=' + el.scrollHeight + ')';
      }),
      repeated: stats,
      anchors: anchors,
      extraction: {
        ok: probe.ok,
        warnings: probe.warnings,
        meta: probe.meta,
        messageCount: probe.messages ? probe.messages.length : 0,
        firstRole: probe.messages && probe.messages[0] ? probe.messages[0].role : '',
        sample: probe.messages && probe.messages[0] ? probe.messages[0].text.slice(0, 160) : ''
      }
    };
  }

  return { profile: profile, stableTokens: stableTokens, signature: signature };
})();
