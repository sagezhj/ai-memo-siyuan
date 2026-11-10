/* global AIME */
'use strict';

globalThis.AIME = globalThis.AIME || {};

/**
 * chrome.runtime 消息封装。
 * content / background / 设置页三端共用同一套 promise 化调用，
 * 避免各处重复写回调与错误处理。
 */
AIME.rpc = (function () {
  function available() {
    return !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage);
  }

  function call(type, payload) {
    if (!available()) {
      return Promise.resolve({ ok: false, error: 'no-runtime' });
    }
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage({ type: type, payload: payload || {} }, function (resp) {
          var lastErr = null;
          try {
            lastErr = chrome.runtime.lastError;
          } catch (e) {
            lastErr = { message: String(e) };
          }
          if (lastErr) {
            resolve({ ok: false, error: lastErr.message || 'runtime-error' });
            return;
          }
          resolve(resp || { ok: false, error: 'empty-response' });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e) });
      }
    });
  }

  /** 广播给所有标签页的 content script（background 侧使用） */
  function pushToTab(tabId, type, payload) {
    if (!available()) {
      return Promise.resolve({ ok: false, error: 'no-runtime' });
    }
    return new Promise(function (resolve) {
      try {
        chrome.tabs.sendMessage(tabId, { type: type, payload: payload || {} }, function (resp) {
          void chrome.runtime.lastError;
          resolve(resp || { ok: true });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e) });
      }
    });
  }

  return { call: call, pushToTab: pushToTab, available: available };
})();
