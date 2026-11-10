/* global AIME */
'use strict';

globalThis.AIME = globalThis.AIME || {};

/**
 * 写入编排：把「一次抓取结果」映射成最小块操作集，逐条执行并即时落库。
 *
 * 关键设计
 *  - 文档正文一律用 appendBlock 逐条追加：只有这样才能拿到每条消息的块 ID，
 *    从而实现「只改动过的那一条」而不是整篇重写。
 *  - 每个操作成功后立刻写 record，失败重试时从断点继续，不会重复追加。
 *  - 记录里只存角色与哈希，不存正文；正文只暂存在待同步队列中。
 */
AIME.sync = (function () {
  var util = AIME.util;
  var busy = {};

  function metaOf(payload, settings) {
    var label = (AIME.C.PLATFORMS[payload.platform] || {}).label || payload.platform;
    var title = payload.title || '未命名对话';
    return {
      platform: payload.platform,
      platformLabel: label,
      month: AIME.C.monthOf(),
      title: title,
      convIdShort: String(payload.convId || '').slice(0, 8),
      url: settings.siyuan.includeUrl ? (payload.url || '') : '',
      time: settings.siyuan.includeTime ? new Date().toISOString().slice(0, 19).replace('T', ' ') : '',
      model: settings.siyuan.includeModel ? ((payload.meta && payload.meta.model) || '') : ''
    };
  }

  function newRecord(memoKey, payload) {
    return {
      memoKey: memoKey,
      platform: payload.platform,
      convId: payload.convId,
      convIdSource: payload.convIdSource || 'url',
      url: payload.url || '',
      title: payload.title || '',
      notebook: '',
      docId: '',
      docFolder: '',
      docTitle: '',
      docPath: '',
      messages: [],
      status: AIME.C.ST.INIT,
      lastError: '',
      lastWarnings: [],
      lastSyncAt: '',
      createdAt: util.nowIso(),
      msgCount: 0
    };
  }

  function err(text, detail) {
    var e = new Error(text);
    e.aime = detail || {};
    return e;
  }

  function docExists(settings, docId) {
    if (!docId) {
      return Promise.resolve(false);
    }
    // getBlockKramdown 是只读探测：文档被手动删除时会返回非 0 code
    return AIME.siyuan.request('/api/block/getBlockKramdown', { id: docId }, {
      baseUrl: settings.siyuan.baseUrl,
      token: settings.siyuan.token
    }).then(function (r) {
      return !!(r && r.ok && r.data);
    });
  }

  function appendOne(settings, docId, msg, index) {
    var md = util.messageMarkdown(msg, index, settings);
    return AIME.siyuan.appendMarkdown(settings, docId, md).then(function (r) {
      if (!r.ok) {
        throw err('append 失败：' + (r.error || '') + ' ' + (r.msg || ''), r);
      }
      return r.ids || [];
    });
  }

  function deleteBlocks(settings, ids) {
    var chain = Promise.resolve();
    (ids || []).forEach(function (id) {
      chain = chain.then(function () {
        return AIME.siyuan.deleteBlock(settings, id).then(function (r) {
          // 块可能已随父块删除，删除类错误不阻断整体流程
          if (!r.ok) {
            AIME.store.log({ level: 'warn', what: 'deleteBlock', id: id, error: r.error, msg: r.msg });
          }
        });
      });
    });
    return chain;
  }

  function wait(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function createDoc(settings, meta) {
    var loc = util.buildDocLocation(settings, meta);
    var header = util.headerMarkdown(meta);
    var attempt = 0;
    function once() {
      return AIME.siyuan.createDoc(settings, settings.siyuan.notebookId, loc.folder, loc.title, header).then(function (r) {
        if (r.ok) {
          return { docId: r.docId, path: r.path, folder: loc.folder, title: loc.title };
        }
        // 索引未就绪是 transient：短间隔重试几次，通常几秒内就好
        if (AIME.siyuan.isIndexNotReady(r) && attempt < 4) {
          attempt++;
          return wait(1200 * attempt).then(once);
        }
        var hint = AIME.siyuan.isIndexNotReady(r)
          ? '（思源索引未就绪，重试仍失败：请在思源里打开目标笔记本、等索引/重建索引完成后再点「立即重试待同步」）'
          : '';
        throw err('建文档失败：' + (r.error || '') + ' ' + (r.msg || '') + hint, r);
      });
    }
    return once();
  }

  /**
   * 核心：执行一次同步。
   * @param {Object} payload {platform, convId, url, title, messages:[{role,text,time}]}
   * @param {Object} settings
   * @returns {Promise<{ok, status, memoKey, path, error, changed, stats}>}
   */
  function run(payload, settings) {
    if (!payload || !payload.convId || !payload.messages || !payload.messages.length) {
      return Promise.resolve({ ok: false, status: AIME.C.ST.ERROR, error: 'empty-payload' });
    }
    var memoKey = AIME.C.memoKeyOf(payload.platform, payload.convId);
    if (busy[memoKey]) {
      return Promise.resolve({ ok: true, status: AIME.C.ST.PENDING, memoKey: memoKey, error: 'in-flight', changed: false });
    }
    busy[memoKey] = true;

    return AIME.store.getRecord(memoKey).then(function (rec) {
      var record = rec || newRecord(memoKey, payload);
      if (record.paused) {
        return { ok: true, status: AIME.C.ST.PAUSED, memoKey: memoKey, changed: false };
      }
      if (settings.enabled === false) {
        return { ok: true, status: AIME.C.ST.SKIPPED, memoKey: memoKey, error: 'extension-disabled', changed: false };
      }
      if (settings.autoSync === false) {
        record.status = AIME.C.ST.SKIPPED;
        record.lastError = 'autoSync 已关闭';
        return AIME.store.putRecord(record).then(function () {
          return { ok: true, status: AIME.C.ST.SKIPPED, memoKey: memoKey, changed: false };
        });
      }
      if (!settings.siyuan.notebookId) {
        return fail(record, 'no-notebook', '设置里还没选择思源笔记本');
      }

      var meta = metaOf(payload, settings);
      var newMsgs = util.fingerprintMessages(payload.messages);
      util.carryBlockIds(record.messages || [], newMsgs);
      var diff = util.diffMessages(record.messages || [], newMsgs);

      if (diff.kind === 'none' && record.docId && record.docTitle === metaTitle(settings, meta)) {
        record.url = payload.url || record.url;
        record.title = payload.title || record.title;
        record.messages = newMsgs;
        record.status = AIME.C.ST.SYNCED;
        record.lastError = '';
        return AIME.store.putRecord(record).then(function () {
          AIME.store.dequeue(memoKey);
          return { ok: true, status: AIME.C.ST.SYNCED, memoKey: memoKey, changed: false, path: record.docPath };
        });
      }

      var stage = Promise.resolve();

      // 1. 确保文档存在
      stage = stage.then(function () {
        if (record.docId) {
          return docExists(settings, record.docId).then(function (exists) {
            if (exists) {
              return null;
            }
            // 文档被删了：丢掉旧的块引用，重建
            record.docId = '';
            (record.messages || []).forEach(function (m) {
              m.blockIds = [];
            });
            diff = { kind: 'rebuild', ops: [{ op: 'rebuild' }], stats: diff.stats };
            return null;
          });
        }
        return null;
      });

      stage = stage.then(function () {
        if (record.docId) {
          return null;
        }
        return createDoc(settings, meta).then(function (created) {
          record.docId = created.docId;
          record.docPath = created.path;
          record.docFolder = created.folder;
          record.docTitle = created.title;
          record.notebook = settings.siyuan.notebookId;
          record.messages = [];
        });
      });

      // 2. rebuild：先清空所有已记录的块
      stage = stage.then(function () {
        if (diff.kind !== 'rebuild') {
          return null;
        }
        var ids = [];
        (record.messages || []).forEach(function (m) {
          ids = ids.concat(m.blockIds || []);
        });
        return deleteBlocks(settings, ids).then(function () {
          record.messages = [];
        });
      });

      // 3. delete：仅删块
      stage = stage.then(function () {
        if (diff.kind !== 'delete') {
          return null;
        }
        var chain = Promise.resolve();
        diff.ops.forEach(function (op) {
          chain = chain.then(function () {
            var old = (record.messages || [])[op.index];
            var ids = old && old.blockIds ? old.blockIds : [];
            return deleteBlocks(settings, ids);
          });
        });
        return chain;
      });

      // 4. 逐条处理 update / append（按索引升序，保证文档内顺序稳定）
      //    update 只有在「原位可锚定」时才安全，否则升级为整篇重建
      if (diff.kind === 'update' && updatesNeedRebuild(record, diff.ops)) {
        diff = { kind: 'rebuild', ops: [{ op: 'rebuild', count: newMsgs.length }], stats: diff.stats };
      }

      var work = [];
      if (diff.kind === 'update') {
        diff.ops.forEach(function (op) {
          work.push({ kind: 'update', index: op.index });
        });
      }
      if (diff.kind === 'append') {
        diff.ops.forEach(function (op) {
          work.push({ kind: 'append', index: op.index });
        });
      }
      if (diff.kind === 'rebuild') {
        for (var i = 0; i < newMsgs.length; i++) {
          work.push({ kind: 'append', index: i });
        }
      }

      stage = stage.then(function () {
        var chain = Promise.resolve();
        work.forEach(function (job) {
          chain = chain.then(function () {
            var target = newMsgs[job.index];
            if (!target) {
              return null;
            }
            if (job.kind === 'update') {
              return updateOne(settings, record, newMsgs, job.index);
            }
            return appendOne(settings, record.docId, target, job.index).then(function (ids) {
              target.blockIds = ids;
            });
          }).then(function () {
            // 每个操作后立即落库，失败重试可从断点继续
            record.messages = newMsgs;
            record.msgCount = newMsgs.length;
            return AIME.store.putRecord(record);
          });
        });
        return chain;
      });

      // 5. 标题变化 -> 重命名（失败不影响正文，记录里保留期望标题）
      stage = stage.then(function () {
        var wantTitle = metaTitle(settings, meta);
        if (!record.docId || record.docTitle === wantTitle) {
          return null;
        }
        return AIME.siyuan.renameDoc(settings, record.notebook, record.docPath, wantTitle).then(function (r) {
          if (r.ok) {
            record.docTitle = wantTitle;
            record.docPath = util.joinPath([record.docFolder, wantTitle]);
          } else {
            AIME.store.log({ level: 'warn', what: 'renameDoc', memoKey: memoKey, error: r.error, msg: r.msg });
          }
        });
      });

      // 6. 收尾
      stage = stage.then(function () {
        record.messages = newMsgs;
        record.msgCount = newMsgs.length;
        record.url = payload.url || record.url;
        record.title = payload.title || record.title;
        record.status = AIME.C.ST.SYNCED;
        record.lastSyncAt = util.nowIso();
        record.lastError = '';
        // 抓取侧的告警（如超上限截断、URL 无会话 ID）随记录留下，设置页里可见
        record.lastWarnings = payload.warnings || [];
        return AIME.store.putRecord(record);
      }).then(function () {
        return AIME.store.dequeue(memoKey).then(function () {
          return {
            ok: true,
            status: AIME.C.ST.SYNCED,
            memoKey: memoKey,
            changed: true,
            path: record.docPath,
            docId: record.docId,
            stats: diff.stats,
            ops: work.length
          };
        });
      });

      return stage.catch(function (e) {
        return fail(record, 'apply', String(e && e.message ? e.message : e), e.aime);
      });
    }).then(function (res) {
      delete busy[memoKey];
      return Object.assign({ memoKey: memoKey }, res);
    }).catch(function (e) {
      delete busy[memoKey];
      return { ok: false, status: AIME.C.ST.ERROR, memoKey: memoKey, error: String(e) };
    });
  }

  /** 该消息落在文档里的最后一个块 ID，用作 insertBlock 的同级锚点 */
  function lastIdOf(m) {
    var ids = m && m.blockIds ? m.blockIds : [];
    return ids.length ? ids[ids.length - 1] : '';
  }

  function prevAnchorId(record, newMsgs, index) {
    var prev = newMsgs[index - 1] || (record.messages || [])[index - 1];
    return lastIdOf(prev);
  }

  /**
   * 是否必须整篇重建：
   *   - 旧消息恰好一个块 -> updateBlock 原位替换，最省事；
   *   - 多块但能找到前一条消息的尾块 -> 删旧块 + insertBlock(previousID) 原位插入；
   *   - 第 0 条消息多块 / 旧记录压根没有块引用 -> 无锚点，只能重建。
   */
  function updatesNeedRebuild(record, ops) {
    return (ops || []).some(function (op) {
      var old = (record.messages || [])[op.index] || {};
      var ids = old.blockIds || [];
      if (ids.length === 1) {
        return false;
      }
      if (ids.length === 0 || op.index === 0) {
        return true;
      }
      var prev = (record.messages || [])[op.index - 1];
      return !(prev && prev.blockIds && prev.blockIds.length);
    });
  }

  function updateOne(settings, record, newMsgs, index) {
    var target = newMsgs[index];
    var old = (record.messages || [])[index] || {};
    var oldIds = (old.blockIds || []).slice();
    var md = util.messageMarkdown(target, index, settings);

    if (oldIds.length === 1) {
      return AIME.siyuan.updateBlock(settings, oldIds[0], md).then(function (r) {
        if (!r.ok) {
          throw err('update 失败：' + (r.error || '') + ' ' + (r.msg || ''), r);
        }
        target.blockIds = (r.ids && r.ids.length) ? r.ids : oldIds;
      });
    }

    var anchor = prevAnchorId(record, newMsgs, index);
    return deleteBlocks(settings, oldIds).then(function () {
      if (!anchor) {
        throw err('update 缺少锚点');
      }
      return AIME.siyuan.insertMarkdown(settings, md, { previousID: anchor });
    }).then(function (r) {
      if (!r.ok) {
        throw err('insert 失败：' + (r.error || '') + ' ' + (r.msg || ''), r);
      }
      target.blockIds = r.ids || [];
    });
  }

  function metaTitle(settings, meta) {
    return util.buildDocLocation(settings, meta).title;
  }

  function fail(record, stageName, message, detail) {
    record.status = AIME.C.ST.ERROR;
    record.lastError = stageName + ': ' + message;
    return AIME.store.putRecord(record).then(function () {
      return AIME.store.log({
        level: 'error',
        what: stageName,
        memoKey: record.memoKey,
        message: message,
        detail: detail && (detail.error || detail.msg) ? String(detail.error) + '/' + String(detail.msg) : ''
      });
    }).then(function () {
      return {
        ok: false,
        status: AIME.C.ST.ERROR,
        memoKey: record.memoKey,
        error: record.lastError,
        changed: false
      };
    });
  }

  return {
    run: run,
    docExists: docExists,
    isBusy: function (memoKey) {
      return !!busy[memoKey];
    }
  };
})();
