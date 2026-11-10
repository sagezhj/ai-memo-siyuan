/* global AIME */
'use strict';

globalThis.AIME = globalThis.AIME || {};
AIME.adapters = AIME.adapters || {};

/**
 * DeepSeek（chat.deepseek.com）
 *
 * convIdPatterns / 各 selectors 均为「候选数组」，命中即用。
 * 这些猜测需要在真实登录页面里校准一次；改版后优先在设置页
 * 「选择器覆盖」里追加，而不是改这里。
 */
AIME.adapters.deepseek = {
  id: 'deepseek',
  label: 'DeepSeek',
  origins: ['chat.deepseek.com'],
  convIdPatterns: [
    '/a/chat/s/([0-9a-fA-F-]{16,})',
    '/chat/([0-9a-fA-F-]{16,})',
    '[?&]conversation_id=([0-9a-fA-F-]{16,})'
  ],
  scopeSelectors: [
    'main',
    '[class*="chat-content"]',
    '[class*="message-list"]',
    '[id*="messages"]'
  ],
  // 正文锚点：DeepSeek 用 ds-markdown 渲染消息正文
  contentAnchorSelectors: [
    '.ds-markdown',
    '[class*="ds-markdown"]',
    '[class*="markdown-body"]'
  ],
  rowSelectors: [
    '[class*="message-item"]',
    '[class*="MessageItem"]',
    '[id^="chat-message"]',
    '[class*="chat-item"]',
    '[data-role]'
  ],
  contentSelectors: [
    '.ds-markdown',
    '[class*="ds-markdown"]',
    '[class*="markdown-body"]'
  ],
  userHints: [
    '[data-role="user"]',
    '[class*="from-user"]',
    '[class*="user-message"]',
    '[class*="is-user"]'
  ],
  assistantHints: [
    '[data-role="assistant"]',
    '[class*="from-assistant"]',
    '[class*="ai-message"]',
    '[class*="answer"]'
  ],
  skipSelectors: [
    'button',
    'svg',
    'style',
    '[class*="operate"]',
    '[class*="actions"]',
    '[class*="feedback"]',
    '[class*="think-toggle"]',
    '[class*="search-source"]',
    '[class*="citation"]'
  ],
  timeSelectors: ['[class*="time"]', 'time'],
  modelSelectors: ['[class*="model-select"] [class*="label"]', '[class*="model-name"]'],
  streamingSelectors: ['[class*="stop"]', '[class*="loading"]', '[class*="generating"]']
};

AIME.engine.register(AIME.adapters.deepseek);
