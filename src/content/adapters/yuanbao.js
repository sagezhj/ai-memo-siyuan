/* global AIME */
'use strict';

globalThis.AIME = globalThis.AIME || {};
AIME.adapters = AIME.adapters || {};

/**
 * 腾讯元宝（yuanbao.tencent.com/chat/<id>）
 * 元宝同时可切换混元与 DeepSeek 模型，但抓的是页面渲染结果，与模型无关。
 */
AIME.adapters.yuanbao = {
  id: 'yuanbao',
  label: '元宝',
  origins: ['yuanbao.tencent.com'],
  convIdPatterns: [
    '/chat/([0-9a-zA-Z_-]{8,})',
    '/conversation/([0-9a-zA-Z_-]{8,})',
    '/share/([0-9a-zA-Z_-]{8,})',
    '[?&](?:conversation_id|conversationId|chatId|cid)=([0-9a-zA-Z_-]{8,})'
  ],
  scopeSelectors: [
    'main',
    '[class*="chat-content"]',
    '[class*="message-list"]',
    '[class*="conversation-content"]',
    '[class*="scroll-container"]'
  ],
  contentAnchorSelectors: [
    '[class*="markdown"]',
    '[class*="message-content"]',
    '[class*="answer"]',
    '[class*="bot-content"]',
    '[class*="rich-text"]'
  ],
  rowSelectors: [
    '[data-message-id]',
    '[data-msg-id]',
    '[class*="message-item"]',
    '[class*="chat-message"]',
    '[class*="msg-item"]',
    '[class*="bubble"]'
  ],
  contentSelectors: [
    '[class*="markdown"]',
    '[class*="message-content"]',
    '[class*="answer"]',
    '[class*="rich-text"]'
  ],
  userHints: [
    '[data-role="user"]',
    '[class*="user-message"]',
    '[class*="self-message"]',
    '[class*="question"]'
  ],
  assistantHints: [
    '[data-role="assistant"]',
    '[class*="bot-message"]',
    '[class*="ai-message"]',
    '[class*="answer"]'
  ],
  skipSelectors: [
    'button', 'svg', 'style',
    '[class*="actions"]',
    '[class*="operation"]',
    '[class*="copy"]',
    '[class*="reference"]',
    '[class*="source-list"]',
    '[class*="doc-card"]',
    '[class*="quote"]'
  ],
  timeSelectors: ['[class*="time"]', 'time'],
  modelSelectors: ['[class*="model"] [class*="name"]', '[class*="model-name"]'],
  streamingSelectors: ['[class*="stop"]', '[class*="loading"]', '[class*="generating"]']
};

AIME.engine.register(AIME.adapters.yuanbao);
