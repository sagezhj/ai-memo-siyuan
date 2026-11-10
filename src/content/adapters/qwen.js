/* global AIME */
'use strict';

globalThis.AIME = globalThis.AIME || {};
AIME.adapters = AIME.adapters || {};

/**
 * 千问（www.qianwen.com / tongyi.com / tongyi.ai / chat.qwen.ai）
 * 阿里系前端类名变动频繁，这里给足候选；实际以设置页覆盖为准。
 */
AIME.adapters.qwen = {
  id: 'qwen',
  label: '千问',
  origins: [
    'www.qianwen.com', 'qianwen.com',
    'www.tongyi.com', 'tongyi.com',
    'www.tongyi.ai', 'tongyi.ai',
    'chat.qwen.ai', 'www.chat.qwen.ai'
  ],
  convIdPatterns: [
    '/chat/([0-9a-zA-Z_-]{8,})',
    '/conversation/([0-9a-zA-Z_-]{8,})',
    '/share/([0-9a-zA-Z_-]{8,})',
    '[?&](?:cid|conversationId|conversation_id|chatId)=([0-9a-zA-Z_-]{8,})'
  ],
  scopeSelectors: [
    'main',
    '[class*="chat-content"]',
    '[class*="message-list"]',
    '[class*="conversation"]',
    '[class*="scroll"]'
  ],
  contentAnchorSelectors: [
    '[class*="markdown"]',
    '[class*="Markdown"]',
    '[class*="message-content"]',
    '[class*="answer-content"]',
    '[class*="segment-content"]',
    '[class*="bot-message"] pre'
  ],
  rowSelectors: [
    '[data-message-id]',
    '[class*="chat-message"]',
    '[class*="message-item"]',
    '[class*="messageItem"]',
    '[class*="bubble"]',
    '[class*="msg-item"]'
  ],
  contentSelectors: [
    '[class*="markdown"]',
    '[class*="Markdown"]',
    '[class*="message-content"]',
    '[class*="answer-content"]'
  ],
  userHints: [
    '[data-role="user"]',
    '[class*="user-message"]',
    '[class*="is-user"]',
    '[class*="question"]',
    '[class*="self"]'
  ],
  assistantHints: [
    '[data-role="assistant"]',
    '[class*="bot-message"]',
    '[class*="ai-message"]',
    '[class*="answer"]',
    '[class*="assistant"]'
  ],
  skipSelectors: [
    'button', 'svg', 'style',
    '[class*="actions"]',
    '[class*="operation"]',
    '[class*="copy"]',
    '[class*="think"]',
    '[class*="deep-research-source"]',
    '[class*="reference"]',
    '[class*="quote-list"]'
  ],
  timeSelectors: ['[class*="time"]', 'time'],
  modelSelectors: ['[class*="model"] [class*="name"]', '[class*="model-name"]', '[class*="select-model"]'],
  streamingSelectors: ['[class*="stop"]', '[class*="loading"]', '[class*="generating"]', '[class*="typing"]']
};

AIME.engine.register(AIME.adapters.qwen);
