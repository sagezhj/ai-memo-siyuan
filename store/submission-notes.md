# Edge 加载项提交说明（Hidden 上架）

本目录是提交包，`extension/` 是脱敏后的扩展副本，`ai-memo-siyuan-0.1.0.zip` 是上传用压缩包（根级即 manifest.json）。

## 0. 发布前准备（已完成）

- **仓库**：https://github.com/sagezhj/ai-memo-siyuan （公开，源码 + 提交包 + 隐私政策均已推送）
- **联系方式**：隐私政策已设为 GitHub Issues（https://github.com/sagezhj/ai-memo-siyuan/issues）+ 邮箱。
- **隐私政策线上 URL**（填到 Partner Center 隐私页）：**https://sagezhj.github.io/ai-memo-siyuan/docs/**
  - 由 GitHub Pages 托管（main 分支）。当前 Pages 源为根目录，README 在站点根路径、隐私政策在 `/docs/`，上面这个地址已验证可访问（HTTP 200，标题与联系方式正确）。
  - 可选美化：若想让站点根路径直接是隐私政策，到仓库 Settings → Pages 把目录从 `/(root)` 改为 `/docs`，URL 即变为 https://sagezhj.github.io/ai-memo-siyuan/ 。

## 1. 注册与提交（Partner Center 八步）

入口：https://partner.microsoft.com/dashboard/microsoftedge/public/login （微软账号登录，注册免费）

| 步骤 | 本扩展怎么填 |
| --- | --- |
| 1. 上传包 | 上传 `ai-memo-siyuan-0.1.0.zip` |
| 2. 可用性 Availability | Visibility 选 **Hidden**；市场范围保持默认（全部市场）；价格免费 |
| 3. 属性 Properties | 类别选 **Tools**（或 Productivity）；名称/短描述读自 manifest，无需填 |
| 4. 隐私 Privacy | 见下面第 2 节，逐项照抄 |
| 5. 商店详情 Store listings | 中文（简体）描述粘贴 `store-description-zh.txt`；英文描述粘贴 `store-description-en.txt`；logo 上传 `store-logo-300.png`；截图可选（Hidden 自用可不传）；宣传磁贴不传 |
| 6. 认证说明 Notes for certification | 粘贴下面第 3 节（建议用英文版，审核团队通用） |
| 7. 提交 | 确认无误后 Submit |
| 8. 等审核 | 官方口径最多 7 个工作日；通过后在后台拿到 listing URL，其他设备打开该链接安装即可 |

## 2. 隐私页逐项填写内容

**单一用途（Single purpose）**

> 中文：把用户在千问 / DeepSeek / 元宝网页里的 AI 对话自动归档到用户自己配置的思源笔记中，一篇对话一个文档，增量更新。
> English: Automatically archive the user's AI conversations from Qwen / DeepSeek / Yuanbao web pages into the user's own SiYuan notebook — one document per conversation, updated incrementally.

**权限理由（Permission justifications）**

| 权限 | 理由（可直接粘贴） |
| --- | --- |
| `storage` | 在浏览器本地保存扩展设置、对话与思源文档的映射（角色+哈希）以及未同步完成时的临时正文快照。Persist extension settings, conversation-to-document mappings (roles + hashes), and temporary content snapshots until sync succeeds. |
| `alarms` | 定时巡检失败重试队列，思源恢复后自动续传。Periodically sweep the retry queue so failed syncs resume when SiYuan becomes reachable. |
| `tabs` | 向对话页推送同步状态、获取当前活动标签页做页面诊断。Push sync status to conversation tabs and identify the active tab for page diagnostics. |
| 9 个平台 host（chat.deepseek.com / qianwen.com / tongyi.com / tongyi.ai / chat.qwen.ai / yuanbao.tencent.com 等） | 在这些域名注入内容脚本以读取对话正文，这是扩展的核心功能。Inject content scripts on these domains to read conversation content — the core function of the extension. |
| `http://127.0.0.1/*`、`http://localhost/*`、`http://[::1]/*` | 连接本机运行的思源内核 HTTP API（默认端口 6806），把对话写入用户自己的笔记。Connect to the SiYuan kernel HTTP API running on the user's own machine (default port 6806) to write conversations into the user's own notes. |
| 可选主机授权 `optional_host_permissions: http://*/*, https://*/*` | 仅当用户把思源部署在局域网/远程机器时，由用户点击「测试连接」当场触发授权弹窗，授权后才访问该主机。Used only when the user's SiYuan runs on a LAN/remote host; the grant is requested via a user-click-triggered prompt and only for that host. |

**远程代码（Remote code）**：选 **No**。全部脚本随包分发，无 eval 远程代码、无外部脚本加载。

**数据使用认证（Data usage）**：会处理「个人通信内容」（用户自己的 AI 对话）。数据只存浏览器本地并发送到用户自己配置的思源地址；不出售、不转让给第三方、不用于广告或信用评估。隐私政策 URL 填第 0 节托管好的地址。

## 3. 认证说明（Notes for certification，建议粘贴英文版）

> This extension archives the user's own AI chat conversations into the user's own SiYuan note instance.
>
> How to test:
> 1. Install and open the extension's options page (toolbar icon).
> 2. The extension requires a running SiYuan desktop kernel (free open-source note app, https://b3log.org/siyuan/en/) with its API enabled. Without it, the extension safely captures conversations locally and queues them for retry — no data is lost and no error is thrown at the user.
> 3. Conversation capture only happens on logged-in sessions of chat.deepseek.com, qianwen.com / tongyi.com / tongyi.ai / chat.qwen.ai, and yuanbao.tencent.com. Reviewers without accounts on these third-party services can still verify: the options page loads, the connection test reports "unreachable" gracefully when no SiYuan kernel is running, and the in-page panel shows an idle status chip.
> 4. All processing is local: content goes only from the page to chrome.storage.local and then to the SiYuan address the user explicitly configures (default http://127.0.0.1:6806). No third-party servers, no remote code, no analytics.
> 5. The optional host permission prompt appears only when the user clicks "Test connection" with a non-loopback SiYuan address.
>
> 中文补充：扩展需登录第三方 AI 平台后才能看到对话内容；写入目标需用户自行运行思源内核。未配置时扩展只做本地捕获并安全排队，不影响审核对设置页与状态气泡的验证。

## 4. 素材清单

| 文件 | 用途 | 状态 |
| --- | --- | --- |
| `store-logo-300.png` | 商店详情 logo（1:1，300×300） | 已备好 |
| `store-description-zh.txt` | 中文描述（≥250 字符） | 已备好 |
| `store-description-en.txt` | 英文描述（≥250 字符） | 已备好 |
| `privacy-policy.html` | 隐私政策（双语，已托管，URL 见 §0） | 已就绪 |
| 截图 1280×800（可选） | 商店详情展示 | 未做；Hidden 自用可省略 |

## 5. 以后更新版本

1. 在开发目录改代码，递增 `manifest.json` 的 `version`（如 0.1.1）。
2. 重新复制目录到发布副本，并重做脱敏（本包相对开发目录的全部改动）：
   - `manifest.json`：删除 `host_permissions` 里的个人局域网主机行；
   - `README.md`：个人 IP 段落改为通用说明；
   - `src/background/siyuan.js` 注释、`src/pages/selftest.js` 测试夹具里的示例 IP 改为 `192.168.50.11`。
3. 重新打 zip（根级是 manifest.json），Partner Center 里该扩展 → 更新 → 上传新包 → 重新提交审核。
4. 审核通过后，所有已安装设备（包括你其他终端）会自动更新。

## 6. 多终端使用的事实边界

- 扩展本体：其他设备打开 Hidden listing URL 安装，之后自动更新。
- 设置（思源地址 / Token / 笔记本）：存在每台设备的 `chrome.storage.local`，**不跨设备同步**，每台新设备装完配置一次。
- 对话数据：靠思源自己的多端同步汇聚，与扩展无关。