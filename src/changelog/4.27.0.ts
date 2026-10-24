// 版本更新日志（数据文件）：4.27.0。正文为 Markdown；行内反引号写作 \`（模板字符串转义）。
// 由 scripts/gen-changelog.mjs 迁移/校验；修改正文后运行 npm run changelog:gen 更新聚合索引。
export default `## 后端配置整合为单 JSON / 论坛独立页签 / 图片 URL 解码

- **「后端配置」**（v1 JSON）取代「后端」页签的 8 个独立地址项：\`{"version":1,"backends":{"image-host":{"url":"…","token":"…"}}}\`。
  在 aiplugin4-backends WebUI 点「📋 复制后端配置」后整段粘贴；**空的「后端配置」= 全部使用出厂默认地址，不报错**；校验失败整份拒绝并回退默认。
  **不迁移、不兼容**：旧 8 个独立键不再注册/读取，升级后请重新复制粘贴；论坛 3 项移到独立「论坛」页签（键名不变、值保留）。
- **MCP 配置**可由启动器「📋 复制 MCP 配置」生成（4 台，含 image-host 的 \`/mcp\`；不写 \`platform\`），粘贴到「MCP → MCP服务器」。
- **图片 URL HTML 实体解码**：解析消息图片时还原 \`&amp;\` / \`&#38;\` / \`&#x26;\`（只解 ampersand 族，\`&notify=1\` 不受影响），旧存量 URL 在加载时治愈；图床返回 \`upstream_status: 4xx\` 时按永久失败处理，不再重试。
- **图床对外地址写进配置（\`image-host.publicUrl\`）**：启动器「复制后端配置」新增「图床对外地址」一栏（留空自动探测本机 IP），导出的 JSON 形如 \`"image-host": {"url": "http://127.0.0.1:46680", "publicUrl": "http://192.168.1.10:46680", "token": "…"}\`。\`url\` 只给插件自己访问图床接口；\`publicUrl\`（IP 或域名）给 QQ 协议端发图与模型取图，**不用再复制完手动改**。未配 \`publicUrl\` 且 \`url\` 是回环时自动降级：发图取 \`/i/<id>/b64\` 落本地文件、模型回退内联 base64，并在启动探测时 WARN 提示。
- **图床 ID 可直接发送**：MCP \`image_search\` 返回的图床 sha256 id 支持 \`[img:ID]\`，发送时用图床稳定地址 \`/i/<id>\`（不落插件 storage、不重复上传）；已入图床的图片发送也统一优先用该地址。
- **所有后端都支持访问 token**：启动器卡片「⚙ 配置」设 token 后，「📋 复制后端配置」会把它写进 \`backends.<名>.token\`，插件请求统一带 \`Authorization: Bearer\`（流式输出/图片转base64/媒体中转/用量图表/图床/核心桥）；设/改 token 后需重启该后端并重新复制，token 不一致会 401 并提示核对哪个 \`backends.<名>.token\`。**复制的 JSON 含明文 token，请勿公开分享。**
- **media-fetch 不再重复请求上游**：二进制取数在配置了 \`backends.media-fetch\` 时**直接由后端代发**（以前先直连一次再让后端重发，TTS 等于双倍合成/计费）；上游 4xx 非 JSON 时后端带回 \`bodyText\`，错误分类与展示不再丢上游原文（需 media-fetch ≥ 1.0.1）。
- **用量图表支持 token 模式**：\`/chart\` 新增 \`base64\` 返回，插件用 \`seal.base64ToImage\` 落本地图发送（token 不进图片 URL、不依赖协议端能访问后端地址）；旧后端回退 \`image_url\`（需 usage-chart ≥ 1.0.1）。
- 修改后约 60 秒生效（核心桥已建立的连接需重连或重载 JS）。
`;
