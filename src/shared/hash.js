/* global AIME */
'use strict';

globalThis.AIME = globalThis.AIME || {};

/**
 * 32 位 FNV-1a 短哈希。
 * 只用于「这段消息文本是否变过」的判定，不追求密码学强度。
 * content 与 background 共用本实现，结果必须逐位一致，
 * 因此不依赖 TextEncoder / crypto 等平台相关 API。
 */
(function () {
  var SEP = String.fromCharCode(0, 31, 0);

  function mix(h, c) {
    return Math.imul(h ^ c, 0x01000193) >>> 0;
  }

  function fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x100) {
        h = mix(h, c);
      } else {
        h = mix(h, c & 0xff);
        h = mix(h, c >>> 8);
      }
    }
    return h >>> 0;
  }

  function pad(n, len) {
    var s = (n >>> 0).toString(16);
    while (s.length < len) {
      s = '0' + s;
    }
    return s;
  }

  AIME.hash = {
    /** 任意字符串 -> 8 位 hex */
    ofText: function (s) {
      return pad(fnv1a(String(s === null || s === undefined ? '' : s)), 8);
    },

    /** role 与 text 组合 -> 16 位 hex，消息内容指纹 */
    ofMessage: function (role, text) {
      var r = String(role === null || role === undefined ? '?' : role);
      var t = String(text === null || text === undefined ? '' : text);
      var body = [r, SEP, t, SEP, String(t.length)].join('');
      var a = pad(fnv1a(body), 8);
      var b = pad(fnv1a(body.split('').reverse().join('')), 8);
      return a + b;
    }
  };
})();
