/* global AIME */
'use strict';

globalThis.AIME = globalThis.AIME || {};

/**
 * 抽取引擎：适配器只是「选择器描述符」，算法集中在引擎里，
 * 这样 AI 网站改版时的修复面只剩描述符（还可在设置页热覆盖）。
 *
 * 角色判定三级降级：
 *   1) 描述符里的 userHints / assistantHints 命中；
 *   2) 消息体在页面里的横向对齐聚类（聊天 UI 的通用特征：一问一答分居两侧）；
 *   3) 首行当用户、之后交替。
 */
AIME.engine = (function () {
  var descriptors = {};
  var order = [];

  function register(desc) {
    descriptors[desc.id] = desc;
    order.push(desc.id);
  }

  function getDescriptor(id, settings) {
    var base = descriptors[id];
    if (!base) {
      return null;
    }
    var copy = JSON.parse(JSON.stringify(base));
    var overrides = (settings && settings.selectorOverrides && settings.selectorOverrides[id]) || null;
    if (overrides) {
      Object.keys(overrides).forEach(function (k) {
        var v = overrides[k];
        if (Array.isArray(v) && Array.isArray(copy[k])) {
          copy[k] = v.concat(copy[k]);
        } else if (typeof v === 'string' && v !== '') {
          copy[k] = [v];
        }
      });
    }
    return copy;
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch (e) {
      return '';
    }
  }

  function pickPlatform(url) {
    var host = hostOf(url);
    if (host === '') {
      return null;
    }
    for (var i = 0; i < order.length; i++) {
      var d = descriptors[order[i]];
      if (d.id === AIME.C.PLATFORM_GENERIC_ID) {
        continue;
      }
      for (var j = 0; j < d.origins.length; j++) {
        var o = d.origins[j].toLowerCase();
        if (host === o || host.indexOf('.' + o) >= 0) {
          return d;
        }
      }
    }
    return descriptors[AIME.C.PLATFORM_GENERIC_ID] || null;
  }

  function convIdFromUrl(url, patterns) {
    for (var i = 0; i < (patterns || []).length; i++) {
      var re = new RegExp(patterns[i], 'i');
      var m = url.match(re);
      if (m && m[1]) {
        return { convId: m[1], source: 'url' };
      }
    }
    return { convId: '', source: 'none' };
  }

  function textBySelectors(scope, selectors, maxLen) {
    if (!scope) {
      return '';
    }
    var el = AIME.dom.firstMatch(scope, selectors || []);
    if (!el) {
      return '';
    }
    var plain = AIME.md.toPlainText(el).replace(/\s+/g, ' ');
    return AIME.util.clamp(plain, maxLen || 120);
  }

  function pageFallbackTitle(doc) {
    var t = String(doc && doc.title ? doc.title : '');
    t = t.replace(/\s*[-–—|]\s*(DeepSeek|千问|通义|元宝|Qwen|Tencent|腾讯).*$/i, '');
    return AIME.util.clamp(t.replace(/\s+/g, ' ').trim(), 80);
  }

  /** 主作用域：把侧边栏、输入框排除在外 */
  function mainScope(doc, desc) {
    var scope = AIME.dom.firstMatch(doc, desc.scopeSelectors || []);
    if (scope) {
      return scope;
    }
    return doc.body;
  }

  /** 找出「不被其它候选行包含」的行，避免容器套容器重复抽取 */
  function dedupeRows(rows) {
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var nested = false;
      for (var j = 0; j < rows.length; j++) {
        if (i !== j && rows[j].contains(rows[i])) {
          nested = true;
          break;
        }
      }
      if (!nested) {
        out.push(rows[i]);
      }
    }
    return out;
  }

  /**
   * 备用定位：行选择器全部落空时，从「正文锚点」（markdown 渲染容器）反推消息行。
   * 沿单一子节点的包装层向上爬，爬到第一个有兄弟节点的元素即认为是行容器。
   * 这条路径对 React 聊天 UI 比猜行类名可靠得多。
   */
  function climbToRow(el, scope) {
    var cur = el;
    for (var i = 0; i < 6; i++) {
      var par = cur.parentElement;
      if (!par || par === scope) {
        break;
      }
      if (par.children && par.children.length > 1) {
        return cur;
      }
      cur = par;
    }
    return cur;
  }

  function rowsFromAnchors(scope, desc) {
    var anchors = AIME.dom.allMatches(scope, desc.contentAnchorSelectors);
    var rows = [];
    var seen = [];
    for (var i = 0; i < anchors.length; i++) {
      if (!AIME.dom.isRendered(anchors[i])) {
        continue;
      }
      if (anchors[i].textContent.replace(/\s+/g, '') === '') {
        continue;
      }
      var row = desc.rowSelectors && desc.rowSelectors.length
        ? (AIME.dom.closestAny(anchors[i], desc.rowSelectors) || climbToRow(anchors[i], scope))
        : climbToRow(anchors[i], scope);
      if (!row || seen.indexOf(row) >= 0) {
        continue;
      }
      seen.push(row);
      rows.push(row);
    }
    return dedupeRows(rows);
  }

  function roleByHints(row, desc) {
    if (AIME.dom.firstMatch(row, desc.userHints || [])) {
      return 'user';
    }
    if (AIME.dom.firstMatch(row, desc.assistantHints || [])) {
      return 'assistant';
    }
    var attr = AIME.dom.roleFromAttributes(row);
    return attr;
  }

  /**
   * 横向对齐聚类：按消息内容块左边缘分组，
   * 右边缘整体更靠右、宽度更小的那一簇判为用户气泡。
   */
  function assignRolesByAlignment(items) {
    if (items.length < 2) {
      return false;
    }
    var lefts = items.map(function (it) {
      return it.rect.left;
    }).sort(function (a, b) {
      return a - b;
    });
    var min = lefts[0];
    var max = lefts[lefts.length - 1];
    if (max - min < 48) {
      return false;                       // 几乎同侧，判不出
    }
    var mid = min + (max - min) / 2;
    var rightCount = 0;
    items.forEach(function (it) {
      it.side = it.rect.left > mid ? 'right' : 'left';
      if (it.side === 'right') {
        rightCount++;
      }
    });
    if (rightCount === 0 || rightCount === items.length) {
      return false;
    }
    items.forEach(function (it) {
      it.inferred = it.side === 'right' ? 'user' : 'assistant';
    });
    return true;
  }

  function looksStreaming(scope, desc) {
    if (AIME.dom.firstMatch(scope, desc.streamingSelectors || [])) {
      return true;
    }
    return false;
  }

  /** 用单个描述符跑一遍抽取 */
  function runOnce(desc, url, settings, doc) {
    var warnings = [];
    desc = getDescriptor(desc.id, settings) || desc;

    var scope = mainScope(doc, desc);
    var rows = AIME.dom.collectRows(scope, desc.rowSelectors, desc.skipSelectors);
    rows = dedupeRows(rows);
    var via = 'rows';
    if (rows.length === 0) {
      rows = rowsFromAnchors(scope, desc);
      via = 'anchors';
      warnings.push('rows-by-anchor-fallback');
    }

    if (rows.length === 0) {
      return { ok: false, platform: desc.id, warnings: warnings.concat(['no-rows']), messages: [] };
    }

    // 逐行取正文
    var items = [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var contentEl = AIME.dom.firstMatch(row, desc.contentSelectors) || row;
      if (contentEl === row && desc.requireContentEl === true) {
        continue;
      }
      var marked = AIME.md.markSkip(row, desc.skipSelectors);
      var md = AIME.md.toMarkdown(contentEl, { headingShift: 2 });
      AIME.md.unmarkSkip(marked);
      if (md === '') {
        continue;
      }
      var rect;
      try {
        rect = contentEl.getBoundingClientRect();
      } catch (e) {
        rect = { left: 0, right: 0, width: 0, height: 0 };
      }
      items.push({
        index: items.length,
        el: row,
        rect: rect,
        text: md,
        hint: roleByHints(row, desc),
        time: textBySelectors(row, desc.timeSelectors, 40),
        truncated: md.length > 400000
      });
    }

    if (items.length === 0) {
      return { ok: false, platform: desc.id, warnings: warnings.concat(['empty-content']), messages: [] };
    }

    // 角色：提示 -> 对齐 -> 交替
    var aligned = assignRolesByAlignment(items);
    for (var k = 0; k < items.length; k++) {
      var it = items[k];
      if (it.hint !== 'unknown') {
        it.role = it.hint;
      } else if (aligned && it.inferred) {
        it.role = it.inferred;
      } else {
        it.role = (k % 2 === 0) ? 'user' : 'assistant';
      }
    }

    // 连续同角色：第一条之外视为「同一条消息的分段」，合并以保持一问一答语义
    var messages = [];
    for (var m = 0; m < items.length; m++) {
      var cur = items[m];
      var prev = messages.length ? messages[messages.length - 1] : null;
      if (prev && prev.role === cur.role && desc.mergeConsecutive !== false) {
        prev.text += AIME.util.NL + AIME.util.NL + cur.text;
        if (!prev.time && cur.time) {
          prev.time = cur.time;
        }
      } else {
        messages.push({ role: cur.role, text: cur.text, time: cur.time });
      }
    }

    var urlId = convIdFromUrl(url, desc.convIdPatterns);
    var convId = urlId.convId;
    var convIdSource = urlId.source;
    if (!convId && messages.length) {
      convId = 'sig-' + AIME.hash.ofText(messages[0].role + '|' + messages[0].text.slice(0, 400));
      convIdSource = 'fingerprint';
      warnings.push('no-conv-id-in-url');
    }

    var title = textBySelectors(doc, desc.titleSelectors, 80) || pageFallbackTitle(doc) || '未命名对话';
    var model = textBySelectors(doc, desc.modelSelectors, 40);

    if (looksStreaming(scope, desc)) {
      warnings.push('streaming');
    }

    var max = settings.maxMessagesPerDoc || 500;
    if (messages.length > max) {
      messages = messages.slice(0, max);
      warnings.push('over-max-messages-truncated');
    }

    return {
      ok: true,
      platform: desc.id,
      convId: convId,
      convIdSource: convIdSource,
      title: title,
      url: url,
      messages: messages,
      meta: { model: model, rowCount: items.length, messageCount: messages.length, via: via },
      warnings: warnings
    };
  }

  function platformAllowed(id, settings) {
    if (descEnabled(id) === false) {
      return false;
    }
    var table = (settings && settings.platforms) || AIME.C.DEFAULT_SETTINGS.platforms;
    if (Object.prototype.hasOwnProperty.call(table, id)) {
      return table[id] !== false;
    }
    return id === AIME.C.PLATFORM_GENERIC_ID ? false : true;
  }

  function descEnabled(id) {
    var d = descriptors[id];
    return d && d.enabled === false ? false : true;
  }

  /**
   * 抽取当前页面对话。
   * 专用描述符抓不到行时，若「通用兜底」开启则再试一次。
   * @returns {{ok:boolean, platform, convId, convIdSource, title, url, messages, meta, warnings}}
   */
  function extract(url, settings, doc) {
    doc = doc || document;
    settings = settings || AIME.C.DEFAULT_SETTINGS;
    var picked = pickPlatform(url);
    if (!picked) {
      return { ok: false, warnings: ['no-adapter'], messages: [] };
    }
    if (!platformAllowed(picked.id, settings)) {
      return { ok: false, platform: picked.id, warnings: ['platform-disabled'], messages: [] };
    }

    var result = runOnce(picked, url, settings, doc);
    var generic = descriptors[AIME.C.PLATFORM_GENERIC_ID];
    if (!result.ok && generic && picked.id !== generic.id && platformAllowed(generic.id, settings)) {
      var retry = runOnce(generic, url, settings, doc);
      if (retry.ok) {
        retry.warnings = retry.warnings.concat(['by-generic', 'specific-failed:' + picked.id]);
        return retry;
      }
      result.warnings = result.warnings.concat(['generic-also-failed']);
    }
    return result;
  }

  return {
    register: register,
    pickPlatform: pickPlatform,
    getDescriptor: getDescriptor,
    platformAllowed: platformAllowed,
    extract: extract,
    ids: function () { return order.slice(); }
  };
})();
