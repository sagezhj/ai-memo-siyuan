/* global AIME */
'use strict';

globalThis.AIME = globalThis.AIME || {};

/**
 * 持久层：全部走 chrome.storage.local。
 * 特意不用 storage.sync —— API Token 与对话正文都不应进浏览器账号同步。
 */
AIME.store = (function () {
  function get(keys) {
    return new Promise(function (resolve) {
      chrome.storage.local.get(keys, function (res) {
        void chrome.runtime.lastError;
        resolve(res || {});
      });
    });
  }

  function set(obj) {
    return new Promise(function (resolve) {
      chrome.storage.local.set(obj, function () {
        void chrome.runtime.lastError;
        resolve({ ok: true });
      });
    });
  }

  function remove(keys) {
    return new Promise(function (resolve) {
      chrome.storage.local.remove(keys, function () {
        void chrome.runtime.lastError;
        resolve({ ok: true });
      });
    });
  }

  function isPlain(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  /** 深合并：对象递归、数组与标量整体替换（数组是用户显式配置的覆盖项） */
  function deepMerge(base, patch) {
    var out = JSON.parse(JSON.stringify(base));
    if (!isPlain(patch)) {
      return out;
    }
    Object.keys(patch).forEach(function (k) {
      var v = patch[k];
      if (isPlain(v) && isPlain(out[k])) {
        out[k] = deepMerge(out[k], v);
      } else {
        out[k] = v;
      }
    });
    return out;
  }

  /* ------------------------------------------------------------ 设置 */

  function getSettings() {
    return get(AIME.C.KEY_SETTINGS).then(function (res) {
      var stored = res[AIME.C.KEY_SETTINGS];
      var merged = deepMerge(AIME.C.DEFAULT_SETTINGS, stored);
      if (!stored || stored.version !== AIME.C.DEFAULT_SETTINGS.version) {
        merged.version = AIME.C.DEFAULT_SETTINGS.version;
        set(mk(AIME.C.KEY_SETTINGS, merged));   // 迁移写回，下次免重复合并
      }
      return merged;
    });
  }

  function mk(k, v) {
    var o = {};
    o[k] = v;
    return o;
  }

  function setSettings(patch) {
    return getSettings().then(function (cur) {
      var next = deepMerge(cur, patch);
      next.version = AIME.C.DEFAULT_SETTINGS.version;
      return set(mk(AIME.C.KEY_SETTINGS, next)).then(function () {
        return next;
      });
    });
  }

  /* ------------------------------------------------------------ 记录 */

  function getRecord(memoKey) {
    return get(AIME.C.recordKeyOf(memoKey)).then(function (res) {
      return res[AIME.C.recordKeyOf(memoKey)] || null;
    });
  }

  function putRecord(rec) {
    rec.updatedAt = AIME.util.nowIso();
    return set(mk(AIME.C.recordKeyOf(rec.memoKey), rec)).then(function () {
      return rec;
    });
  }

  function deleteRecord(memoKey) {
    return remove(AIME.C.recordKeyOf(memoKey));
  }

  /** 列出全部记录（不带正文，量小） */
  function listRecords() {
    return get(null).then(function (all) {
      var out = [];
      Object.keys(all).forEach(function (k) {
        if (k.indexOf(AIME.C.RECORD_PREFIX) === 0 && all[k]) {
          out.push(all[k]);
        }
      });
      out.sort(function (a, b) {
        return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
      });
      return out;
    });
  }

  /* ------------------------------------------------------------ 队列 */

  function getQueue() {
    return get(AIME.C.KEY_QUEUE).then(function (res) {
      return res[AIME.C.KEY_QUEUE] || {};
    });
  }

  function setQueue(q) {
    return set(mk(AIME.C.KEY_QUEUE, q));
  }

  function enqueue(memoKey, item) {
    return getQueue().then(function (q) {
      var prev = q[memoKey] || { attempts: 0 };
      var attempts = typeof item.attempts === 'number' ? item.attempts : (prev.attempts || 0) + 1;
      var delay = AIME.util.backoffMs(attempts);
      q[memoKey] = {
        attempts: attempts,
        nextAt: Date.now() + delay,
        lastError: item.lastError || prev.lastError || '',
        payload: item.payload !== undefined ? item.payload : (prev.payload || null)
      };
      if (attempts > (item.maxAttempts || 12)) {
        q[memoKey].exhausted = true;
        q[memoKey].nextAt = Date.now() + 3600000;
      }
      return setQueue(q).then(function () {
        return q[memoKey];
      });
    });
  }

  function dequeue(memoKey) {
    return getQueue().then(function (q) {
      if (q[memoKey]) {
        delete q[memoKey];
        return setQueue(q);
      }
      return { ok: true };
    });
  }

  function clearQueue() {
    return setQueue({});
  }

  /** 到期条目（含无 payload 的「等页面回来」项，由调用方区分处理） */
  function dueItems(nowTs, limit) {
    return getQueue().then(function (q) {
      var out = [];
      Object.keys(q).forEach(function (k) {
        var it = q[k];
        if (it && (!it.nextAt || it.nextAt <= nowTs)) {
          out.push({ memoKey: k, item: it });
        }
      });
      out.sort(function (a, b) {
        return (a.item.nextAt || 0) - (b.item.nextAt || 0);
      });
      return out.slice(0, limit || 5);
    });
  }

  function queueStats() {
    return getQueue().then(function (q) {
      var keys = Object.keys(q);
      var withPayload = 0;
      var errors = [];
      keys.forEach(function (k) {
        if (q[k] && q[k].payload) {
          withPayload++;
        }
        if (q[k] && q[k].lastError) {
          errors.push(k + ': ' + q[k].lastError);
        }
      });
      return {
        total: keys.length,
        retryable: withPayload,
        waitingForPage: keys.length - withPayload,
        lastErrors: errors.slice(-3)
      };
    });
  }

  /* ------------------------------------------------------------ 日志 */

  function log(entry) {
    return get(AIME.C.KEY_LOG).then(function (res) {
      var arr = res[AIME.C.KEY_LOG] || [];
      arr.push(Object.assign({ at: AIME.util.nowIso() }, entry));
      if (arr.length > AIME.C.LOG_MAX) {
        arr = arr.slice(arr.length - AIME.C.LOG_MAX);
      }
      return set(mk(AIME.C.KEY_LOG, arr));
    });
  }

  function getLog() {
    return get(AIME.C.KEY_LOG).then(function (res) {
      return res[AIME.C.KEY_LOG] || [];
    });
  }

  function clearLog() {
    return set(mk(AIME.C.KEY_LOG, []));
  }

  return {
    get: get,
    set: set,
    deepMerge: deepMerge,
    getSettings: getSettings,
    setSettings: setSettings,
    getRecord: getRecord,
    putRecord: putRecord,
    deleteRecord: deleteRecord,
    listRecords: listRecords,
    getQueue: getQueue,
    enqueue: enqueue,
    dequeue: dequeue,
    clearQueue: clearQueue,
    dueItems: dueItems,
    queueStats: queueStats,
    log: log,
    getLog: getLog,
    clearLog: clearLog
  };
})();
