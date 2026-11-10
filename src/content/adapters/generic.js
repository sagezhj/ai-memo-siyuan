/* global AIME */
'use strict';

globalThis.AIME = globalThis.AIME || {};
AIME.adapters = AIME.adapters || {};

/**
 * 通用兜底：完全靠结构特征（重复出现的内容块 + 左右对齐）猜消息行。
 * 命中率不如专用描述符，默认关闭，仅作为「新平台先能跑起来」的保底。
 */
AIME.adapters.generic = {
  id: 'generic',
  label: '通用兜底',
  origins: ['*'],
  convIdPatterns: [
    '/chat/([0-9a-zA-Z_-]{8,})',
    '/c/([0-9a-zA-Z_-]{8,})',
    '/conversation/([0-9a-zA-Z_-]{8,})',
    '[?&](?:conversation_id|conversationId|chatId|cid|thread)=([0-9a-zA-Z_-]{6,})'
  ],
  scopeSelectors: ['main', '[class*="chat"]', '[role="main"]'],
  contentAnchorSelectors: [
    '[class*="markdown"]',
    '[class*="prose"]',
    '[class*="message-content"]',
    '[class*="content"] pre'
  ],
  rowSelectors: [
    '[data-message-id]',
    '[data-msg-id]',
    '[data-role]',
    '[class*="message-item"]',
    '[class*="chat-message"]'
  ],
  contentSelectors: [
    '[class*="markdown"]',
    '[class*="prose"]',
    '[class*="message-content"]'
  ],
  userHints: ['[data-role="user"]', '[class*="user-message"]'],
  assistantHints: ['[data-role="assistant"]', '[class*="bot-message"]'],
  skipSelectors: ['button', 'svg', 'style', '[class*="actions"]', '[class*="toolbar"]'],
  timeSelectors: ['[class*="time"]', 'time'],
  modelSelectors: [],
  streamingSelectors: ['[class*="stop"]', '[class*="loading"]'],
  mergeConsecutive: true
};

AIME.engine.register(AIME.adapters.generic);
