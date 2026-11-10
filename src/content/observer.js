/* global AIME */
'use strict';

globalThis.AIME = globalThis.AIME || {};

/**
 * 页面监听与提交编排（content 侧）。
 *
 * 思路：不猜「流式结束」的信号，而是做「静默窗口」——
 * DOM 在 DEBOUNCE_MS 内不再变化才提交一次；若页面存在生成中指示，
 * 则把窗口延长到 MAX_WAIT_MS 为止。这样一问一答、边生成边看都不会漏。
 */
AIME.observer = (function () {
  var mo = null;
  var urlTimer = null;
  var timer = null;
  var firstPendingAt = 0;
  var lastFingerprint = '';
  var lastSubmitAt = 0;
  var lastResult = null;
  var cfg = {
    settings: null,
    state: null,
    running: false
  };

  function now() {
    return Date.now();
  }

  function streamingHint() {
    var cand = ['[class*="stop-generating"]', '[aria-label*="停止"]', '[class*="generating"]', '[class*="is-typing"]', '[class*="loading-indicator"]'];
    for (var i = 0; i < cand.length; i++) {
      try {
        if (document.querySelector(cand[i])) {
          return true;
        }
      } catch (e) {
        /* ignore */
      }
    }
    return false;
  }

  function fingerprintOf(res) {
    var parts = [res.platform, res.convId, res.title, String(res.messages.length)];
    for (var i = 0; i < res.messages.length; i++) {
      parts.push(AIME.hash.ofMessage(res.messages[i].role, res.messages[i].text).slice(0, 8));
    }
    return parts.join('|');
  }

  function bubbleState() {
    var st = cfg.state || {};
    return {
      pending: st.pendingCount || 0,
      detail: st.lastError || ''
    };
  }

  function submit(force) {
    if (!cfg.settings) {
      return Promise.resolve({ ok: false, error: 'no-settings' });
    }
    if (!cfg.settings.enabled || !cfg.state || cfg.state.enabled === false) {
      AIME.bubble.set('off', bubbleState());
      return Promise.resolve({ ok: false, error: 'disabled' });
    }
    if (!AIME.engine.platformAllowed(platformId(), cfg.settings)) {
      AIME.bubble.set('off', bubbleState());
      return Promise.resolve({ ok: false, error: 'platform-disabled' });
    }

    var res = AIME.engine.extract(location.href, cfg.settings, document);
    if (!res.ok) {
      lastResult = res;
      AIME.bubble.set(res.warnings.indexOf('no-adapter') >= 0 ? 'unsupported' : 'idle', {
        detail: (res.warnings || []).join(', ')
      });
      return Promise.resolve(res);
    }
    lastResult = res;

    var fp = fingerprintOf(res);
    if (!force && fp === lastFingerprint) {
      AIME.bubble.set(cfg.state.status === 'error' ? 'error' : 'synced', bubbleState());
      return Promise.resolve({ ok: true, unchanged: true, result: res });
    }
    if (!force && now() - lastSubmitAt < 1000) {
      return Promise.resolve({ ok: false, error: 'throttled' });
    }

    lastFingerprint = fp;
    lastSubmitAt = now();
    AIME.bubble.set(cfg.settings.autoSync ? 'syncing' : 'queued', { messages: res.messages.length });

    return AIME.rpc.call(AIME.C.MSG.SUBMIT, {
      platform: res.platform,
      convId: res.convId,
      convIdSource: res.convIdSource,
      url: res.url,
      title: res.title,
      messages: res.messages,
      meta: res.meta,
      warnings: res.warnings,
      force: !!force
    }).then(function (resp) {
      if (!resp || !resp.ok) {
        AIME.bubble.set('error', { error: resp && resp.error, detail: resp && resp.error, pending: resp && resp.pendingCount });
      } else {
        var st = resp.status;
        if (st === AIME.C.ST.SYNCED) {
          AIME.bubble.set('synced', { messages: res.messages.length, pending: resp.pendingCount, detail: resp.path || '' });
        } else if (st === AIME.C.ST.PAUSED) {
          AIME.bubble.set('paused', { pending: resp.pendingCount });
        } else {
          AIME.bubble.set(st === AIME.C.ST.ERROR ? 'error' : 'queued', {
            messages: res.messages.length,
            pending: resp.pendingCount,
            detail: resp.error || ''
          });
        }
      }
      if (resp && typeof resp.pendingCount === 'number') {
        cfg.state = cfg.state || {};
        cfg.state.pendingCount = resp.pendingCount;
      }
      return { ok: true, submitted: true, resp: resp, result: res };
    });
  }

  function platformId() {
    if (lastResult && lastResult.platform) {
      return lastResult.platform;
    }
    var d = AIME.engine.pickPlatform(location.href);
    return d ? d.id : '';
  }

  function schedule() {
    if (!cfg.running) {
      return;
    }
    var t = now();
    if (!firstPendingAt) {
      firstPendingAt = t;
    }
    if (timer) {
      clearTimeout(timer);
    }
    var waited = t - firstPendingAt;
    var overdue = waited >= AIME.C.MAX_WAIT_MS;
    var hold = streamingHint() && !overdue ? Math.min(4000, AIME.C.MAX_WAIT_MS - waited) : AIME.C.DEBOUNCE_MS;
    timer = setTimeout(function () {
      timer = null;
      firstPendingAt = 0;
      submit(false);
    }, Math.max(300, hold));
  }

  function watchUrl() {
    var lastUrl = location.href;
    urlTimer = setInterval(function () {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        lastFingerprint = '';
        firstPendingAt = now();
        schedule();
      }
    }, 800);
  }

  return {
    configure: function (settings, state) {
      cfg.settings = settings || cfg.settings;
      cfg.state = state || cfg.state;
      if (cfg.settings) {
        AIME.bubble.show(cfg.settings.bubbleEnabled !== false);
      }
    },

    start: function () {
      if (cfg.running) {
        return;
      }
      cfg.running = true;
      mo = new MutationObserver(function (records) {
        // 忽略扩展自己插入的气泡
        var relevant = records.some(function (r) {
          var t = r.target;
          return !(t && t.closest && t.closest('#' + 'aime-memo-root'));
        });
        if (relevant) {
          schedule();
        }
      });
      if (document.body) {
        mo.observe(document.body, { childList: true, subtree: true, characterData: true });
      }
      watchUrl();
      window.addEventListener('popstate', schedule, true);
      window.addEventListener('pagehide', function () {
        submit(true);
      }, true);
      schedule();
    },

    stop: function () {
      cfg.running = false;
      if (mo) {
        mo.disconnect();
        mo = null;
      }
      if (urlTimer) {
        clearInterval(urlTimer);
        urlTimer = null;
      }
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },

    scan: function (force) {
      firstPendingAt = 0;
      return submit(force !== false);
    },

    result: function () {
      return lastResult;
    },

    fingerprint: function () {
      return lastFingerprint;
    }
  };
})();
