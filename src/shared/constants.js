/* global AIME */
'use strict';

// 统一命名空间：content script 与 background service worker 共用同一批 classic script，
// 不需要打包工具。background 通过 importScripts 载入本文件。
globalThis.AIME = globalThis.AIME || {};
AIME.C = AIME.C || {};

/* ---------------------------------------------------------------- 存储键 */
AIME.C.KEY_SETTINGS = 'settings';
AIME.C.KEY_QUEUE = 'queue';
AIME.C.KEY_LOG = 'log';
AIME.C.RECORD_PREFIX = 'record:';
AIME.C.LOG_MAX = 200;

/* ---------------------------------------------------------------- 消息类型 */
AIME.C.MSG = {
  SUBMIT: 'AIME_SUBMIT',            // content -> background：一次抽取结果
  STATE: 'AIME_STATE',             // content -> background：拉取全局状态
  STATUS_PUSH: 'AIME_STATUS',      // background -> content：状态回推
  SCAN: 'AIME_SCAN',               // background/settings -> content：立即重扫
  DIAGNOSE: 'AIME_DIAGNOSE',       // settings -> content：回传页面结构画像
  PAUSE_TOGGLE: 'AIME_PAUSE_TOGGLE',
  SETTINGS_GET: 'AIME_SETTINGS_GET',
  SETTINGS_SET: 'AIME_SETTINGS_SET',
  SIYUAN_TEST: 'AIME_SIYUAN_TEST',
  SIYUAN_NOTEBOOKS: 'AIME_SIYUAN_NOTEBOOKS',
  RECORDS_LIST: 'AIME_RECORDS_LIST',
  RECORD_RETRY: 'AIME_RECORD_RETRY',
  RECORD_DELETE: 'AIME_RECORD_DELETE',
  QUEUE_FLUSH: 'AIME_QUEUE_FLUSH',
  LOG_GET: 'AIME_LOG_GET'
};

/* ---------------------------------------------------------------- 同步状态 */
AIME.C.ST = {
  INIT: 'init',          // 已抓取，尚未写入
  SYNCED: 'synced',      // 与思源一致
  PENDING: 'pending',    // 排队 / 重试中
  ERROR: 'error',        // 失败，等待退避
  PAUSED: 'paused',      // 用户暂停该对话
  SKIPPED: 'skipped'     // 平台开关关闭
};

/* ---------------------------------------------------------------- 退避 */
// 单位：秒。超出数组长度后固定用最后一档。
AIME.C.BACKOFF_SECONDS = [10, 30, 60, 300, 900, 1800, 3600];
AIME.C.ALARM_SWEEP = 'aime-sweep';
AIME.C.SWEEP_PERIOD_MINUTES = 2;

/* ---------------------------------------------------------------- 去抖 */
AIME.C.DEBOUNCE_MS = 1500;       // 页面静默多久后提交
AIME.C.MAX_WAIT_MS = 12000;      // 持续流式输出时的最长等待
AIME.C.STREAMING_HINT = true;    // 检测到疑似流式输出时延长等待

/* ---------------------------------------------------------------- 平台定义 */
// 这里只放「产品级」元数据（显示名、开关键）。
// 抓取相关的 URL 正则与选择器一律在各平台描述符里，避免出现两份真相。
AIME.C.PLATFORMS = {
  deepseek: { id: 'deepseek', label: 'DeepSeek' },
  qwen: { id: 'qwen', label: '千问' },
  yuanbao: { id: 'yuanbao', label: '元宝' },
  generic: { id: 'generic', label: '通用兜底' }
};

// 兜底平台：任何未被专用适配器命中的对话页也可用启发式抽取（默认关闭）。
AIME.C.PLATFORM_GENERIC_ID = 'generic';

/* ---------------------------------------------------------------- 默认设置 */
AIME.C.DEFAULT_SETTINGS = {
  version: 1,
  enabled: true,
  autoSync: true,          // 关闭后只抓取本地，不写思源
  bubbleEnabled: true,     // 页面悬浮入口（气泡 + 会话面板）
  panelLayout: 'float',    // 会话面板布局：float 悬浮窗 / side 侧边栏
  panelPos: null,          // 悬浮窗拖动后的位置 {right,bottom}，null 表示默认右下角
  debugLog: false,         // 记录每次抽取的调试信息
  maxMessagesPerDoc: 500,  // 安全阈值，超过则截断并在文档内标注
  platforms: {
    deepseek: true,
    qwen: true,
    yuanbao: true,
    generic: false
  },
  siyuan: {
    baseUrl: 'http://127.0.0.1:6806',
    token: '',
    notebookId: '',
    notebookName: '',
    // 文档落位：/AI对话/2026-11/DeepSeek/标题   （{yyyy-MM} {platform} {title}）
    rootPath: '/AI对话',
    folderTemplate: '{yyyy-MM}/{platform}',
    titlePrefix: '',
    // 写入文档头部的元信息
    includeUrl: true,
    includeTime: true,
    includeModel: false
  },
  // 平台选择器覆盖：{ deepseek: { row: ['.xxx'], ... } }
  selectorOverrides: {},
  retry: {
    maxAttempts: 12
  }
};

/* ---------------------------------------------------------------- 工具 */
AIME.C.memoKeyOf = function (platform, convId) {
  return String(platform) + ':' + String(convId);
};

AIME.C.recordKeyOf = function (memoKey) {
  return AIME.C.RECORD_PREFIX + memoKey;
};

AIME.C.monthOf = function (dateOrIso) {
  var d = dateOrIso ? new Date(dateOrIso) : new Date();
  if (isNaN(d.getTime())) d = new Date();
  var m = String(d.getMonth() + 1);
  if (m.length < 2) m = '0' + m;
  return d.getFullYear() + '-' + m;
};
