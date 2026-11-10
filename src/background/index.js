/* global AIME */
'use strict';

importScripts(
  '/src/shared/constants.js',
  '/src/shared/util.js',
  '/src/shared/hash.js',
  '/src/shared/rpc.js',
  '/src/background/siyuan.js',
  '/src/background/store.js',
  '/src/background/sync.js'
);

/* ---------------------------------------------------------------- 徽标 */

function updateBadge(stats) {
  var text = '';
  var color = '#2563eb';
  var s = stats || { total: 0, retryable: 0, waitingForPage: 0 };
  if (s.total > 0) {
    text = s.total > 99 ? '99+' : String(s.total);
    color = s.retryable > 0 ? '#dc2626' : '#7c3aed';
  }
  try {
    chrome.action.setBadgeText({ text: text });
    chrome.action.setBadgeBackgroundColor({ color: color });
  } catch (e) {
    /* MV3 冷启动瞬间 action 可能还没就绪，忽略 */
  }
}

function refreshBadge() {
  return AIME.store.queueStats().then(updateBadge).catch(function () {
    updateBadge({ total: 0 });
  });
}

/* ---------------------------------------------------------------- 提交处理 */

function handleSubmit(payload, sender) {
  return AIME.store.getSettings().then(function (settings) {
    return AIME.sync.run(payload, settings).then(function (res) {
      var memoKey = res.memoKey || AIME.C.memoKeyOf(payload.platform, payload.convId);
      var needRetry = !res.ok || res.status === AIME.C.ST.ERROR;
      var chain = Promise.resolve(res);
      if (needRetry) {
        chain = AIME.store.enqueue(memoKey, {
          payload: payload,
          lastError: res.error || 'unknown'
        }).then(function () {
          return res;
        });
      } else if (res.status === AIME.C.ST.PENDING && res.error === 'in-flight') {
        chain = AIME.store.enqueue(memoKey, {
          payload: payload,
          lastError: 'in-flight',
          attempts: 1
        }).then(function () {
          return res;
        });
      }
      return chain;
    }).then(function (res) {
      if (settings.debugLog) {
        AIME.store.log({
          level: res.ok ? 'info' : 'warn',
          what: 'submit',
          platform: payload.platform,
          convId: payload.convId,
          count: payload.messages.length,
          status: res.status,
          error: res.error || '',
          ops: res.ops || 0
        });
      }
      return AIME.store.queueStats().then(function (stats) {
        updateBadge(stats);
        if (sender && sender.tab && sender.tab.id !== undefined) {
          AIME.rpc.pushToTab(sender.tab.id, AIME.C.MSG.STATUS_PUSH, {
            status: res.status,
            pendingCount: stats.total,
            error: res.error || '',
            path: res.path || ''
          });
        }
        return Object.assign({ pendingCount: 0, path: '' }, res, {
          pendingCount: stats.total,
          path: res.path || ''
        });
      });
    }).catch(function (e) {
      return AIME.store.queueStats().then(function (stats) {
        updateBadge(stats);
        return { ok: false, status: AIME.C.ST.ERROR, error: String(e), pendingCount: stats.total };
      });
    });
  });
}

/* ---------------------------------------------------------------- 队列巡检 */

function sweep(limit) {
  return AIME.store.getSettings().then(function (settings) {
    if (!settings.enabled || !settings.autoSync) {
      return { ok: true, skipped: 'disabled', done: 0 };
    }
    return AIME.store.dueItems(Date.now(), limit || 5).then(function (items) {
      var chain = Promise.resolve({ done: 0, waiting: 0 });
      items.forEach(function (entry) {
        chain = chain.then(function (acc) {
          if (!entry.item.payload) {
            // 没有正文快照：等用户重新打开该对话页由 content 再提交
            acc.waiting++;
            return AIME.store.enqueue(entry.memoKey, {
              attempts: entry.item.attempts,
              lastError: entry.item.lastError || 'waiting-for-page',
              payload: null
            }).then(function () {
              return acc;
            });
          }
          return AIME.sync.run(entry.item.payload, settings).then(function (res) {
            if (!res.ok || res.status === AIME.C.ST.ERROR) {
              return AIME.store.enqueue(entry.memoKey, {
                payload: entry.item.payload,
                lastError: res.error || 'unknown'
              }).then(function () {
                acc.done++;
                return acc;
              });
            }
            acc.done++;
            return acc;
          });
        });
      });
      return chain;
    }).then(function (r) {
      return AIME.store.queueStats().then(function (stats) {
        updateBadge(stats);
        return { ok: true, done: r.done, waiting: r.waiting, total: stats.total };
      });
    });
  });
}

/* ---------------------------------------------------------------- 路由 */

var ROUTES = {};

ROUTES[AIME.C.MSG.SUBMIT] = function (payload, sender) {
  return handleSubmit(payload, sender);
};

ROUTES[AIME.C.MSG.STATE] = function () {
  return Promise.all([AIME.store.getSettings(), AIME.store.queueStats()]).then(function (rs) {
    return {
      ok: true,
      settings: rs[0],
      state: {
        enabled: rs[0].enabled,
        autoSync: rs[0].autoSync,
        bubbleEnabled: rs[0].bubbleEnabled,
        pendingCount: rs[1].total,
        waitingForPage: rs[1].waitingForPage
      }
    };
  });
};

ROUTES[AIME.C.MSG.SETTINGS_GET] = function () {
  return Promise.all([AIME.store.getSettings(), AIME.store.queueStats()]).then(function (rs) {
    return { ok: true, settings: rs[0], stats: rs[1] };
  });
};

ROUTES[AIME.C.MSG.SETTINGS_SET] = function (patch) {
  return AIME.store.setSettings(patch).then(function (s) {
    return refreshBadge().then(function () {
      return { ok: true, settings: s };
    });
  });
};

ROUTES[AIME.C.MSG.PAUSE_TOGGLE] = function (payload) {
  var memoKey = payload.memoKey;
  return AIME.store.getRecord(memoKey).then(function (rec) {
    if (!rec) {
      return { ok: false, error: 'no-record' };
    }
    rec.paused = !rec.paused;
    rec.status = rec.paused ? AIME.C.ST.PAUSED : rec.status;
    var chain = AIME.store.putRecord(rec);
    if (rec.paused) {
      chain = chain.then(function () {
        return AIME.store.dequeue(memoKey);
      });
    }
    return chain.then(function () {
      return AIME.store.queueStats();
    }).then(function (stats) {
      updateBadge(stats);
      return { ok: true, paused: rec.paused, pendingCount: stats.total };
    });
  });
};

ROUTES[AIME.C.MSG.SIYUAN_TEST] = function () {
  return AIME.store.getSettings().then(function (s) {
    return AIME.siyuan.health(s);
  });
};

ROUTES[AIME.C.MSG.SIYUAN_NOTEBOOKS] = function () {
  return AIME.store.getSettings().then(function (s) {
    return AIME.siyuan.lsNotebooks(s);
  });
};

ROUTES[AIME.C.MSG.RECORDS_LIST] = function () {
  return Promise.all([AIME.store.listRecords(), AIME.store.getQueue()]).then(function (rs) {
    return { ok: true, records: rs[0], queue: rs[1] };
  });
};

ROUTES[AIME.C.MSG.RECORD_RETRY] = function (payload) {
  return AIME.store.getQueue().then(function (q) {
    var item = q[payload.memoKey];
    if (!item || !item.payload) {
      return { ok: false, error: 'need-page', hint: '请重新打开该对话页面，插件会自动补写' };
    }
    item.attempts = 0;
    item.nextAt = 0;
    return AIME.store.getSettings().then(function (s) {
      return AIME.sync.run(item.payload, s);
    });
  });
};

ROUTES[AIME.C.MSG.RECORD_DELETE] = function (payload) {
  // 只删本地映射，不动思源里的文档
  return AIME.store.deleteRecord(payload.memoKey).then(function () {
    return AIME.store.dequeue(payload.memoKey);
  }).then(function () {
    return AIME.store.queueStats();
  }).then(function (stats) {
    updateBadge(stats);
    return { ok: true };
  });
};

ROUTES[AIME.C.MSG.QUEUE_FLUSH] = function (payload) {
  if (payload && payload.clear) {
    return AIME.store.clearQueue().then(function () {
      return refreshBadge();
    }).then(function () {
      return { ok: true, cleared: true };
    });
  }
  return sweep(20);
};

ROUTES[AIME.C.MSG.LOG_GET] = function () {
  return AIME.store.getLog().then(function (l) {
    return { ok: true, log: l };
  });
};

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type || !ROUTES[msg.type]) {
    return false;
  }
  ROUTES[msg.type](msg.payload || {}, sender).then(function (res) {
    sendResponse(res || { ok: true });
  }).catch(function (e) {
    sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
  });
  return true;
});

/* ---------------------------------------------------------------- 生命周期 */

chrome.runtime.onInstalled.addListener(function (details) {
  // 读一次设置触发默认值迁移，然后刷新徽标
  refreshBadge();
  if (details && details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onStartup.addListener(function () {
  refreshBadge();
  setTimeout(function () {
    sweep(5);
  }, 5000);
});

chrome.action.onClicked.addListener(function () {
  chrome.runtime.openOptionsPage();
});

chrome.alarms.create(AIME.C.ALARM_SWEEP, { periodInMinutes: AIME.C.SWEEP_PERIOD_MINUTES });
chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm && alarm.name === AIME.C.ALARM_SWEEP) {
    sweep(5);
  }
});

refreshBadge();
