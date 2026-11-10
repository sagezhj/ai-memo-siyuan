/* global AIME */
'use strict';

globalThis.AIME = globalThis.AIME || {};

/**
 * DOM -> Markdown 序列化。
 *
 * AI 站点的正文由前端渲染，直接取 textContent 会把代码块、列表、表格压成一坨。
 * 这里分两趟：块级结构递归下钻，只剩行内内容时整段做一次行内渲染，
 * 因此对 React 那种 div 套 div 的结构也能还原出可读的 Markdown。
 */
AIME.md = (function () {
  var NL = String.fromCharCode(10);
  var BLOCK_TAGS = {
    P: 1, DIV: 1, SECTION: 1, ARTICLE: 1, ASIDE: 1, MAIN: 1, HEADER: 1, FOOTER: 1,
    LI: 1, UL: 1, OL: 1, BLOCKQUOTE: 1, PRE: 1, HR: 1, TABLE: 1, FIGURE: 1,
    FIGCAPTION: 1, FIELDSET: 1, DL: 1, DD: 1, DT: 1
  };
  var HEADING_TAGS = { H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1 };
  var LIST_TAGS = { UL: 1, OL: 1 };
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, IFRAME: 1, CANVAS: 1, VIDEO: 1, AUDIO: 1, SVG: 1 };
  var CONTROL_TAGS = { BUTTON: 1, INPUT: 1, TEXTAREA: 1, SELECT: 1, SUMMARY: 1, LABEL: 1, NAV: 1 };

  function isBlockLevel(el) {
    return !!(el && el.nodeType === 1 && BLOCK_TAGS[el.tagName]);
  }

  function isSpecial(el) {
    if (!el || el.nodeType !== 1) {
      return false;
    }
    var t = el.tagName;
    return !!(isBlockLevel(el) || HEADING_TAGS[t] || LIST_TAGS[t] || t === 'PRE' || t === 'TABLE');
  }

  function txt(s) {
    return String(s === null || s === undefined ? '' : s).split(String.fromCharCode(160)).join(' ');
  }

  function foldWs(s) {
    return txt(s).replace(/[ \t\r\f\v]+/g, ' ');
  }

  /* ------------------------------------------------------------ 代码块 */

  function fenceFor(content) {
    var runs = content.match(/`+/g) || [];
    var max = 0;
    for (var i = 0; i < runs.length; i++) {
      if (runs[i].length > max) {
        max = runs[i].length;
      }
    }
    var f = '';
    for (var j = 0; j < max + 1 && j < 8; j++) {
      f += '`';
    }
    while (f.length < 3) {
      f += '`';
    }
    return f;
  }

  function langOf(pre) {
    var node = pre.querySelector ? (pre.querySelector('code') || pre) : pre;
    var cls = (node.className && typeof node.className === 'string') ? node.className : '';
    var m = cls.match(/(?:^|[\s_-])(?:language|lang)[-_:]?([A-Za-z][A-Za-z0-9_+.#-]*)/i);
    if (m) {
      return m[1].toLowerCase();
    }
    m = cls.match(/(?:^|\s)(javascript|typescript|python|java|golang|go|rust|cpp|csharp|bash|shell|zsh|sql|json|yaml|yml|html|css|scss|markdown|dockerfile|toml|xml|php|ruby|kotlin|swift|lua|perl|powershell|diff|plaintext)(?:\s|$)/i);
    if (m) {
      return m[1].toLowerCase();
    }
    return '';
  }

  /** 去掉站点在代码块左侧塞的行号列（连续递增整数 + 大段空白） */
  function stripGutter(lines) {
    var ok = 0;
    var expect = 1;
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(/^(\d{1,4})([ \t]{2,})(.*)$/);
      if (m && parseInt(m[1], 10) === expect) {
        ok++;
        expect++;
      } else if (lines[i] !== '') {
        return lines;
      }
    }
    if (ok < 2) {
      return lines;
    }
    return lines.map(function (l) {
      var mm = l.match(/^\d{1,4}[ \t]{2,}(.*)$/);
      return mm ? mm[1] : l;
    });
  }

  function codeBlock(pre) {
    var raw = txt(pre.textContent).replace(/\r/g, NL);
    var body = stripGutter(raw.split(NL)).join(NL).replace(/[ \t]+$/g, '');
    body = body.replace(/^`{3,}/, '');
    var f = fenceFor(body);
    return f + langOf(pre) + NL + body + NL + f;
  }

  /* ------------------------------------------------------------ 行内 */

  function imgMd(el) {
    var alt = foldWs(el.getAttribute('alt') || '').trim();
    var src = el.getAttribute('src') || el.getAttribute('data-src') || '';
    if (!src || src.indexOf('data:') === 0 || src.indexOf('blob:') === 0) {
      return alt ? '[图片：' + alt + ']' : '[图片]';
    }
    return '![' + alt + '](' + src + ')';
  }

  function linkMd(el) {
    var href = el.getAttribute('href') || '';
    var inner = inlineOf(el).trim();
    if (!href || href.indexOf('javascript:') === 0 || inner === '') {
      return inner;
    }
    return '[' + inner + '](' + href + ')';
  }

  function codeMd(el) {
    var raw = txt(el.textContent);
    if (raw.trim() === '') {
      return '';
    }
    var f = '`';
    while (raw.indexOf(f) >= 0) {
      f += '`';
    }
    var pad = raw.charAt(0) === '`' || raw.charAt(raw.length - 1) === '`' ? ' ' : '';
    return f + pad + raw + pad + f;
  }

  function wrap(inner, marker) {
    var s = inner.trim();
    if (s === '') {
      return '';
    }
    var lead = inner.charAt(0) === ' ' ? ' ' : '';
    var trail = inner.charAt(inner.length - 1) === ' ' ? ' ' : '';
    return lead + marker + s + marker + trail;
  }

  function inlineNode(node) {
    if (node.nodeType === 3) {
      return txt(node.nodeValue);
    }
    if (node.nodeType !== 1) {
      return '';
    }
    var el = node;
    if (el.getAttribute && el.getAttribute('data-aime-skip') === '1') {
      return '';
    }
    var t = el.tagName;
    if (SKIP_TAGS[t] || CONTROL_TAGS[t]) {
      return '';
    }
    if (t === 'BR') {
      return '  ' + NL;
    }
    if (t === 'HR') {
      return NL + NL + '---' + NL + NL;
    }
    if (t === 'IMG') {
      return imgMd(el);
    }
    if (t === 'A') {
      return linkMd(el);
    }
    if (t === 'CODE') {
      return codeMd(el);
    }
    if (t === 'PRE') {
      return NL + NL + codeBlock(el) + NL + NL;
    }
    if (t === 'STRONG' || t === 'B') {
      return wrap(inlineOf(el), '**');
    }
    if (t === 'EM' || t === 'I') {
      return wrap(inlineOf(el), '*');
    }
    if (t === 'DEL' || t === 'S' || t === 'STRIKE') {
      return wrap(inlineOf(el), '~~');
    }
    if (t === 'MARK') {
      return wrap(inlineOf(el), '==');
    }
    if (t === 'SUP') {
      return '^' + inlineOf(el).trim();
    }
    if (HEADING_TAGS[t] || isBlockLevel(el) || LIST_TAGS[t] || t === 'TABLE') {
      // 行内遍历里撞到块级结构：降级为软换行，交给块级趟去处理内容
      return NL + inlineOf(el);
    }
    return inlineOf(el);
  }

  function inlineOf(node) {
    var out = '';
    for (var c = node.firstChild; c; c = c.nextSibling) {
      out += inlineNode(c);
    }
    return out;
  }

  /* ------------------------------------------------------------ 列表 / 表格 / 引用 */

  function listMd(el, indent) {
    var ordered = el.tagName === 'OL';
    var start = ordered ? (parseInt(el.getAttribute('start') || '1', 10) || 1) : 1;
    var lines = [];
    var idx = 0;
    for (var li = el.firstElementChild; li; li = li.nextElementSibling) {
      if (li.tagName !== 'LI') {
        continue;
      }
      idx++;
      li.querySelectorAll('ul, ol').forEach(function (n) {
        n.setAttribute('data-aime-skip', '1');
      });
      var head = foldWs(inlineOf(li)).replace(/[ \t]+/g, ' ').trim();
      var marker = ordered ? (start + idx - 1) + '. ' : '- ';
      if (head !== '') {
        lines.push(indent + marker + head);
      }
      li.querySelectorAll('ul, ol').forEach(function (n) {
        var sub = listMd(n, indent + (ordered ? '   ' : '  '));
        n.removeAttribute('data-aime-skip');
        if (sub !== '') {
          lines.push(sub);
        }
      });
    }
    return lines.join(NL);
  }

  function rowCells(tr) {
    var cells = [];
    tr.querySelectorAll('th, td').forEach(function (c) {
      cells.push(foldWs(inlineOf(c)).replace(/[ \t]+/g, ' ').replace(/\|/g, '\\|').trim());
    });
    return cells;
  }

  function tableMd(table) {
    var rows = [];
    var body = table.tBodies && table.tBodies.length ? table.tBodies[0] : table;
    var all = Array.prototype.slice.call(body.rows || []);
    var heads = table.tHead ? Array.prototype.slice.call(table.tHead.rows) : [];
    for (var i = 0; i < heads.length; i++) {
      rows.push({ header: true, cells: rowCells(heads[i]) });
    }
    for (var j = 0; j < all.length; j++) {
      if (heads.indexOf(all[j]) < 0) {
        rows.push({ header: false, cells: rowCells(all[j]) });
      }
    }
    rows = rows.filter(function (r) {
      return r.cells.length > 0 && r.cells.join('') !== '';
    });
    if (rows.length === 0) {
      return '';
    }
    var width = 0;
    rows.forEach(function (r) {
      width = Math.max(width, r.cells.length);
    });
    if (rows[0].header !== true) {
      rows.unshift({ header: true, cells: new Array(width).fill('') });
    }
    var out = [];
    out.push('| ' + rows[0].cells.join(' | ') + ' |');
    out.push('| ' + rows[0].cells.map(function () { return '---'; }).join(' | ') + ' |');
    for (var k = 1; k < rows.length; k++) {
      if (rows[k].header) {
        continue;
      }
      var row = rows[k].cells.slice();
      while (row.length < width) {
        row.push('');
      }
      out.push('| ' + row.join(' | ') + ' |');
    }
    return out.join(NL);
  }

  function prefixLines(block, mark) {
    return block.split(NL).map(function (l) {
      return l === '' ? mark.trim() : mark + l;
    }).join(NL);
  }

  /* ------------------------------------------------------------ 块级趟 */

  function pushBlock(el, ctx, out) {
    if (el.getAttribute && el.getAttribute('data-aime-skip') === '1') {
      return;
    }
    var t = el.tagName;
    if (SKIP_TAGS[t]) {
      return;
    }
    if (HEADING_TAGS[t]) {
      var level = Math.min(6, parseInt(t.charAt(1), 10) + (ctx.headingShift || 0));
      var text = foldWs(inlineOf(el)).replace(/[ \t]+/g, ' ').trim();
      if (text !== '') {
        out.push(hashesLevel(level) + ' ' + text);
      }
      return;
    }
    if (t === 'PRE') {
      out.push(codeBlock(el));
      return;
    }
    if (LIST_TAGS[t]) {
      var lmd = listMd(el, '');
      if (lmd !== '') {
        out.push(lmd);
      }
      return;
    }
    if (t === 'TABLE') {
      var tmd = tableMd(el);
      if (tmd !== '') {
        out.push(tmd);
      }
      return;
    }
    if (t === 'BLOCKQUOTE') {
      var inner = collectBlocks(el, ctx, []);
      if (inner.length) {
        out.push(prefixLines(inner.join(NL + NL), '> '));
      }
      return;
    }
    if (t === 'HR') {
      out.push('---');
      return;
    }
    collectBlocks(el, ctx, out);
  }

  function hashesLevel(n) {
    var s = '';
    for (var i = 0; i < n; i++) {
      s += '#';
    }
    return s;
  }

  /** 把 el 的子节点拆成「块级下钻 / 行内成段」，结果追加到 out */
  function collectBlocks(el, ctx, out) {
    var hasSpecial = false;
    for (var c = el.firstElementChild; c; c = c.nextElementSibling) {
      if (isSpecial(c)) {
        hasSpecial = true;
        break;
      }
    }
    if (!hasSpecial) {
      var single = tidy(inlineOf(el));
      if (single !== '') {
        out.push(single);
      }
      return;
    }
    var run = '';
    function flush() {
      var s = foldWs(run).replace(/[ \t]+/g, ' ').trim();
      run = '';
      if (s !== '') {
        out.push(s);
      }
    }
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 1 && isSpecial(n)) {
        flush();
        pushBlock(n, ctx, out);
      } else {
        run += inlineNode(n);
      }
    }
    flush();
    return out;
  }

  function tidy(md) {
    var s = txt(md).replace(/\r/g, NL);
    // 只清理 3 个以上的行尾空白，保留 Markdown 的两空格硬换行
    s = s.replace(/[ \t]{3,}$/gm, '');
    s = s.replace(/\n{3,}/g, NL + NL);
    return s.trim();
  }

  return {
    NL: NL,
    /** 主入口：把一个元素序列化为 Markdown */
    toMarkdown: function (root, opts) {
      if (!root || !root.firstChild) {
        return '';
      }
      var ctx = { headingShift: (opts && typeof opts.headingShift === 'number') ? opts.headingShift : 0 };
      var out = [];
      collectBlocks(root, ctx, out);
      return tidy(out.join(NL + NL));
    },
    /** 只要纯文本（标题、消息兜底用） */
    toPlainText: function (root) {
      if (!root) {
        return '';
      }
      return tidy(foldWs(inlineOf(root)).replace(/[ \t]+/g, ' '));
    },
    /** 标记噪声节点，序列化时整棵跳过 */
    markSkip: function (root, selectors) {
      var marked = [];
      if (!root || !selectors) {
        return marked;
      }
      for (var i = 0; i < selectors.length; i++) {
        try {
          root.querySelectorAll(selectors[i]).forEach(function (el) {
            if (!el.hasAttribute('data-aime-skip')) {
              el.setAttribute('data-aime-skip', '1');
              marked.push(el);
            }
          });
        } catch (e) {
          /* 坏选择器忽略 */
        }
      }
      return marked;
    },
    unmarkSkip: function (marked) {
      (marked || []).forEach(function (el) {
        if (el && el.removeAttribute) {
          el.removeAttribute('data-aime-skip');
        }
      });
    },
    tidy: tidy
  };
})();
