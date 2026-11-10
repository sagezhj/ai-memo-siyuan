/* global AIME */
'use strict';

globalThis.AIME = globalThis.AIME || {};

/**
 * 思源内核 HTTP 客户端（只在 background 里调用）。
 *
 * 响应包络：{ code: 0, msg: '', data: ... }，code 非 0 视为业务失败。
 * 块操作返回 data 为数组，每项含 doOperations，块的 id 在 op.id 上，
 * 因此这里统一抽成「本次新建/删除的块 ID 列表」。
 *
 * 走 background 而不是 content：一是 content script 向 127.0.0.1 发起请求
 * 会被混合内容/私有网络访问策略拦，二是集中一处便于统一鉴权与重试。
 */
AIME.siyuan = (function () {
  function normalizeBase(baseUrl) {
    var s = String(baseUrl || 'http://127.0.0.1:6806').trim();
    if (s === '') {
      s = 'http://127.0.0.1:6806';
    }
    s = s.replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(s)) {
      s = 'http://' + s;
    }
    return s;
  }

  function headers(token) {
    var h = { 'Content-Type': 'application/json;charset=utf-8' };
    var t = String(token || '').trim();
    if (t !== '') {
      h.Authorization = 'Token ' + t;
    }
    return h;
  }

  /**
   * @returns {Promise<{ok:boolean, data:*, code:number, msg:string, error:string, httpStatus:number}>}
   */
  function request(path, body, cfg) {
    var url = normalizeBase(cfg.baseUrl) + path;
    var controller = null;
    var timedOut = false;
    try {
      controller = new AbortController();
    } catch (e) {
      controller = null;
    }
    var timer = controller ? setTimeout(function () {
      timedOut = true;
      controller.abort();
    }, Math.max(3000, cfg.timeoutMs || 15000)) : null;

    return fetch(url, {
      method: 'POST',
      headers: headers(cfg.token),
      body: JSON.stringify(body || {}),
      credentials: 'omit',
      cache: 'no-store',
      signal: controller ? controller.signal : undefined
    }).then(function (resp) {
      if (timer) {
        clearTimeout(timer);
      }
      if (!resp.ok) {
        // 401/403/404 的内核都会带一句人话（如 Auth failed [session]），
        // 不读回来的话设置页只能显示一个空错误，没法判断是端口错还是认证错
        var statusErr = resp.status === 401 || resp.status === 403 ? 'bad-token' : 'http-' + resp.status;
        return resp.text().catch(function () {
          return '';
        }).then(function (text) {
          var hint = String(text || '').slice(0, 200);
          try {
            var j = JSON.parse(text);
            if (j && j.msg) {
              hint = String(j.msg).slice(0, 200);
            }
          } catch (e) {
            void hint;
          }
          return {
            ok: false,
            error: statusErr,
            httpStatus: resp.status,
            code: -1,
            msg: hint,
            data: null
          };
        });
      }
      return resp.text().then(function (text) {
        var json = null;
        try {
          json = JSON.parse(text);
        } catch (e) {
          return { ok: false, error: 'bad-json', httpStatus: resp.status, code: -1, msg: text.slice(0, 200), data: null };
        }
        if (json && typeof json.code === 'number' && json.code !== 0) {
          return { ok: false, error: 'siyuan-' + json.code, code: json.code, msg: json.msg || '', data: json.data };
        }
        return { ok: true, data: json ? json.data : null, code: json ? json.code : 0, msg: json ? json.msg : '', httpStatus: resp.status };
      });
    }).catch(function (err) {
      if (timer) {
        clearTimeout(timer);
      }
      var isType = !!(err && err.name === 'TypeError');
      // 非回环地址上的 fetch 抛 TypeError：内核多半是通的，是浏览器把跨网段请求拦了
      // （思源对预检回 Access-Control-Allow-Private-Network: false，必须靠 host 权限绕过）
      var blocked = isType && !timedOut && !isLoopbackHost(cfg.baseUrl);
      var name = timedOut ? 'timeout' : (blocked ? 'blocked' : (isType ? 'unreachable' : 'error'));
      return {
        ok: false,
        error: name,
        code: -1,
        msg: timedOut ? '请求超时' : (blocked
          ? '被浏览器拦截：未授予访问 ' + hostPatternOf(cfg.baseUrl) + ' 的权限'
          : String(err && err.message ? err.message : err)),
        httpStatus: 0,
        data: null
      };
    });
  }

  /** 从块操作响应里提取块 ID；优先取 parentID 对得上的顶层块 */
  function collectBlockIds(data, parentID) {
    var top = [];
    var all = [];
    var groups = [];
    if (Array.isArray(data)) {
      groups = data;
    } else if (data && typeof data === 'object') {
      groups = [data];
    }
    groups.forEach(function (g) {
      if (!g) {
        return;
      }
      var ops = g.doOperations;
      if (!ops && g.id) {
        ops = [g];
      }
      (ops || []).forEach(function (op) {
        if (!op || !op.id) {
          return;
        }
        if (all.indexOf(op.id) < 0) {
          all.push(op.id);
        }
        var sameParent = !op.parentID || op.parentID === parentID;
        if (sameParent && top.indexOf(op.id) < 0) {
          top.push(op.id);
        }
      });
    });
    return top.length ? top : all;
  }

  function cfgOf(settings) {
    var sy = (settings && settings.siyuan) || {};
    return { baseUrl: sy.baseUrl, token: sy.token, timeoutMs: sy.timeoutMs || 15000 };
  }

  var LOOPBACK_RE = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i;

  /** 是否本机回环地址：清单里已预授权，不需要再弹权限窗 */
  function isLoopbackHost(baseUrl) {
    return LOOPBACK_RE.test(normalizeBase(baseUrl));
  }

  /**
   * 思源地址 → host 权限匹配模式。
   * Chrome/Edge 的匹配模式不允许带端口，所以必须丢掉端口：
   * http://192.168.50.11:8026 → http://192.168.50.11/*（同主机任意端口都覆盖）。
   * 带端口会让 chrome.permissions.request 直接报 Invalid pattern，
   * 于是局域网/远程思源永远拿不到授权，请求被 Private Network Access 拦掉。
   */
  function hostPatternOf(baseUrl) {
    var s = normalizeBase(baseUrl);
    var m = s.match(/^(https?:\/\/[^/?#]+)/i);
    if (!m) {
      return '';
    }
    return m[1].replace(/:\d+$/, '') + '/*';
  }

  /**
   * 思源「文档元数据索引未就绪」是** transient **错误：
   * 内核刚启动 / 笔记本刚打开 / 正在重建索引时，createDocWithMd 解析 h-path
   * 会返回 code=-1 msg="document metadata is not ready"（data.reason=indexUnavailable）。
   * 索引就绪后同样的请求就会成功，所以应当短间隔重试而不是当成永久失败。
   */
  function isIndexNotReady(r) {
    if (!r || r.ok) {
      return false;
    }
    if (r.data && r.data.reason === 'indexUnavailable') {
      return true;
    }
    return /metadata is not ready|indexUnavailable/i.test(String(r.msg || ''));
  }

  function sqlLit(s) {
    return "'" + String(s === null || s === undefined ? '' : s).replace(/'/g, "''") + "'";
  }

  /** 按 hpath 批量查已存在的文档 id，返回 {hpath: id} */
  function findDocIdsByPaths(settings, notebook, paths) {
    if (!paths.length) {
      return Promise.resolve({ ok: true, map: {} });
    }
    var stmt = 'SELECT id, hpath FROM blocks WHERE type=' + sqlLit('d') +
      ' AND box=' + sqlLit(notebook) +
      ' AND hpath IN (' + paths.map(sqlLit).join(',') + ')';
    return request('/api/query/sql', { stmt: stmt }, cfgOf(settings)).then(function (r) {
      if (!r.ok) {
        return r;
      }
      var map = {};
      (Array.isArray(r.data) ? r.data : []).forEach(function (row) {
        if (row && row.hpath) {
          map[row.hpath] = row.id;
        }
      });
      return { ok: true, map: map };
    });
  }

  /** 在精确 hpath 建一个文档（不拼 folder/title） */
  function createDocAtPath(settings, notebook, path, markdown) {
    return request('/api/filetree/createDocWithMd', {
      notebook: notebook,
      path: path,
      markdown: markdown
    }, cfgOf(settings)).then(function (r) {
      if (!r.ok) {
        return r;
      }
      var docId = typeof r.data === 'string' ? r.data : (r.data && r.data.id) || '';
      return { ok: !!docId, docId: docId, path: path, error: docId ? '' : 'no-doc-id', raw: r };
    });
  }

  /**
   * 思源 3.8.x 的 createDocWithMd **不会自动创建父文档**：
   * 父 hpath 缺失时直接报 indexUnavailable（"document metadata is not ready"）。
   * 所以建叶子文档前，先把 /A/B/C 这条父链自上而下补齐（已存在的跳过）。
   */
  function ensureFolder(settings, notebook, folder) {
    var parts = String(folder || '').split('/').filter(function (p) { return p !== ''; });
    var prefixes = [];
    var cur = '';
    parts.forEach(function (p) {
      cur += '/' + p;
      prefixes.push(cur);
    });
    if (!prefixes.length) {
      return Promise.resolve({ ok: true });
    }
    return findDocIdsByPaths(settings, notebook, prefixes).then(function (r) {
      if (!r.ok) {
        return r;
      }
      var chain = Promise.resolve({ ok: true });
      prefixes.forEach(function (p) {
        chain = chain.then(function (acc) {
          if (!acc.ok || r.map[p]) {
            return acc;
          }
          return createDocAtPath(settings, notebook, p, '').then(function (cr) {
            if (!cr.ok) {
              return { ok: false, error: cr.error, msg: '创建父目录 ' + p + ' 失败：' + (cr.msg || '') };
            }
            r.map[p] = cr.docId;
            return { ok: true };
          });
        });
      });
      return chain;
    });
  }

  return {
    normalizeBase: normalizeBase,
    isLoopbackHost: isLoopbackHost,
    hostPatternOf: hostPatternOf,
    isIndexNotReady: isIndexNotReady,
    findDocIdsByPaths: findDocIdsByPaths,
    ensureFolder: ensureFolder,
    collectBlockIds: collectBlockIds,
    request: request,
    cfgOf: cfgOf,

    version: function (settings) {
      return request('/api/system/version', {}, cfgOf(settings));
    },

    lsNotebooks: function (settings) {
      return request('/api/notebook/lsNotebooks', {}, cfgOf(settings)).then(function (r) {
        if (!r.ok) {
          return r;
        }
        var list = (r.data && r.data.notebooks) || [];
        return {
          ok: true,
          notebooks: list.filter(function (n) {
            return !n.closed;
          }).map(function (n) {
            return { id: n.id, name: n.name, icon: n.icon || '', closed: !!n.closed };
          }),
          closed: list.filter(function (n) {
            return !!n.closed;
          }).map(function (n) {
            return { id: n.id, name: n.name };
          })
        };
      });
    },

    /** 用 Markdown 建文档；folder 为 hpath 目录，title 为文档名。先补齐父目录链。 */
    createDoc: function (settings, notebook, folder, title, markdown) {
      var path = AIME.util.joinPath([folder, title]);
      return ensureFolder(settings, notebook, folder).then(function (fr) {
        if (!fr.ok) {
          return fr;
        }
        return createDocAtPath(settings, notebook, path, markdown);
      });
    },

    appendMarkdown: function (settings, parentID, markdown) {
      return request('/api/block/appendBlock', {
        dataType: 'markdown',
        data: markdown,
        parentID: parentID
      }, cfgOf(settings)).then(function (r) {
        if (!r.ok) {
          return r;
        }
        return { ok: true, ids: collectBlockIds(r.data, parentID), raw: r };
      });
    },

    /**
     * 在指定块之后插入（同级），用于「更新中间某条消息」时保持文档顺序。
     * previousID 与 parentID 二者按需给一个。
     */
    insertMarkdown: function (settings, markdown, anchor) {
      var body = { dataType: 'markdown', data: markdown };
      if (anchor && anchor.previousID) {
        body.previousID = anchor.previousID;
      }
      if (anchor && anchor.parentID) {
        body.parentID = anchor.parentID;
      }
      return request('/api/block/insertBlock', body, cfgOf(settings)).then(function (r) {
        if (!r.ok) {
          return r;
        }
        return { ok: true, ids: collectBlockIds(r.data, anchor && anchor.parentID ? anchor.parentID : ''), raw: r };
      });
    },

    deleteBlock: function (settings, id) {
      return request('/api/block/deleteBlock', { id: id }, cfgOf(settings));
    },

    updateBlock: function (settings, id, markdown) {
      return request('/api/block/updateBlock', {
        dataType: 'markdown',
        data: markdown,
        id: id
      }, cfgOf(settings)).then(function (r) {
        if (!r.ok) {
          return r;
        }
        return { ok: true, ids: collectBlockIds(r.data, ''), raw: r };
      });
    },

    renameDoc: function (settings, notebook, path, title) {
      return request('/api/filetree/renameDoc', {
        notebook: notebook,
        path: path,
        title: title
      }, cfgOf(settings));
    },

    removeDoc: function (settings, notebook, path) {
      return request('/api/filetree/removeDoc', { notebook: notebook, path: path }, cfgOf(settings));
    },

    setBlockAttrs: function (settings, id, attrs) {
      return request('/api/attr/setBlockAttrs', { id: id, attrs: attrs }, cfgOf(settings));
    },

    /**
     * 连通性体检：版本 + 笔记本 + 目标目录可写性。
     * 只读接口 + 一次「建完即删」的探针文档，避免只测到半通状态。
     */
    health: function (settings) {
      var v = null;
      return AIME.siyuan.version(settings).then(function (r) {
        if (!r.ok) {
          return { ok: false, stage: 'version', error: r.error, msg: r.msg };
        }
        v = r.data;
        return AIME.siyuan.lsNotebooks(settings);
      }).then(function (r) {
        if (!r.ok) {
          return { ok: false, stage: 'notebooks', error: r.error, msg: r.msg, version: v };
        }
        var nb = (settings.siyuan || {}).notebookId;
        var found = nb ? r.notebooks.filter(function (x) {
          return x.id === nb;
        }) : [];
        return {
          ok: true,
          version: v,
          notebooks: r.notebooks,
          closedNotebooks: r.closed,
          notebookSelected: !!nb,
          notebookAvailable: found.length > 0
        };
      });
    }
  };
})();
