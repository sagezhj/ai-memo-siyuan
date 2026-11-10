/* global AIME */
'use strict';

/**
 * content 入口：拿到全局状态后挂载气泡并启动监听。
 * 只在顶层框架运行（manifest 里 all_frames=false），避免 iframe 重复抓取。
 */
(function () {
  var booted = false;

  function isTopFrame() {
    try {
      return window.top === window;
    } catch (e) {
      return true;
    }
  }

  function onRuntimeMessage(msg, sender, sendResponse) {
    if (!msg || !msg.type) {
      return false;
    }
    if (msg.type === AIME.C.MSG.STATUS_PUSH) {
      var p = msg.payload || {};
      AIME.observer.configure(null, Object.assign({}, AIME.lastState, p));
      var map = {};
      map[AIME.C.ST.SYNCED] = 'synced';
      map[AIME.C.ST.PENDING] = 'queued';
      map[AIME.C.ST.ERROR] = 'error';
      map[AIME.C.ST.PAUSED] = 'paused';
      if (map[p.status]) {
        AIME.bubble.set(map[p.status], {
          pending: p.pendingCount,
          detail: p.error || p.path || ''
        });
      }
      AIME.bubble.notify();
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === AIME.C.MSG.DIAGNOSE) {
      var res = AIME.observer.scan(true);
      Promise.resolve(res).then(function () {
        sendResponse({ ok: true, profile: AIME.diagnose.profile(location.href) });
      });
      return true;
    }
    if (msg.type === AIME.C.MSG.SCAN) {
      Promise.resolve(AIME.observer.scan(true)).then(function (r) {
        sendResponse({ ok: true, result: r && r.result ? r.result : null, changed: r && r.submitted });
      });
      return true;
    }
    return false;
  }

  function boot() {
    if (booted || !isTopFrame()) {
      return;
    }
    booted = true;

    AIME.bubble.mount();
    AIME.bubble.set('scanning', {});
    // 普通点击气泡由 bubble 内部处理（展开/收起会话面板）；
    // Alt/Ctrl 点击保留旧行为：暂停/恢复当前对话
    AIME.bubble.onClick(function (kind) {
      if (kind !== 'pause') {
        return;
      }
      var r = AIME.observer.result();
      if (!r || !r.convId) {
        return;
      }
      AIME.rpc.call(AIME.C.MSG.PAUSE_TOGGLE, {
        memoKey: AIME.C.memoKeyOf(r.platform, r.convId)
      }).then(function (resp) {
        AIME.bubble.set(resp && resp.paused ? 'paused' : 'syncing', { pending: resp && resp.pendingCount });
        AIME.bubble.notify();
      });
    });
    // 面板「立即同步本页」要走 observer 编排（指纹去重 / 静默窗口）
    AIME.bubble.onAction(function (action) {
      if (action === 'sync') {
        AIME.observer.scan(true);
      }
    });

    AIME.rpc.call(AIME.C.MSG.STATE, {}).then(function (resp) {
      if (!resp || !resp.ok) {
        AIME.bubble.set('idle', { detail: '后台未就绪，稍后自动重试' });
        setTimeout(boot_retry, 3000);
        return;
      }
      AIME.lastState = resp.state || {};
      AIME.bubble.configure(resp.settings || {});
      AIME.observer.configure(resp.settings, resp.state);
      AIME.observer.start();
    });
  }

  function boot_retry() {
    booted = false;
    AIME.observer.stop();
    boot();
  }

  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    boot();
  } else {
    window.addEventListener('DOMContentLoaded', boot);
    // SPA 有时 DOMContentLoaded 早于挂载点出现，兜底再来一次
    setTimeout(function () {
      if (!booted) {
        boot();
      } else if (!AIME.observer.result()) {
        AIME.observer.scan(true);
      }
    }, 4000);
  }
})();
