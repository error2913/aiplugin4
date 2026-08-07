# SealDice 面板自动化参考

## 路由

| 页面 | 路由 |
|---|---|
| 主页（含状态/日志） | `#/home` |
| 日志 | 主页内嵌，无独立路由（访问 `#/log` 会重定向回主页） |
| 扩展功能-JS扩展 | `#/mod/js` |
| 扩展包 | `#/mod/package`（标签：已安装包/商店/其他） |
| 自定义回复/牌堆/帮助/跑团日志/拦截 | `#/mod/{reply,deck,helpdoc,story,censor}` |
| 辅助工具（指令测试/资源/性能） | `#/tool/{test,resource,profile}` |
| 综合设置（基本/备份/群组/黑白名单/公骰/高级） | `#/misc/{base-setting,backup,group,ban,dice-public,advanced-setting}` |

## 解锁流程

1. `page.goto(url + "/#/home", { waitUntil: "domcontentloaded" })`，等待约 3 秒（勿用 `networkidle`，页面有长轮询永不空闲）。
2. 检测 `document.body.innerText` 是否含「输入密码解锁」。
3. Vue 输入框需用原生 setter 赋值并派发 `input` 事件：
   ```js
   const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
   setter.call(el, value);
   el.dispatchEvent(new Event("input", { bubbles: true }));
   ```
4. 点击文本含「确认」的按钮，等待 4 秒。
5. 再次检测锁屏文案；仍存在则密码错误（服务端返回 400「错误的密码」）。

## 日志接口

- 认证方式：非 cookie。解锁成功后前端把 token 存进 `localStorage["t"]`，所有 API 请求需带
  `authorization` 与 `token` 两个请求头（值相同）。
- 解锁后用页面会话 `fetch("/sd-api/log/fetchAndClear", { headers: { authorization: token, token } })` 获取日志数组（level/module/ts/msg）。
- `ts` 为 Unix 秒；页面显示本地时间（Asia/Shanghai）。
- 该接口每次调用返回上次轮询以来的日志并清空服务端缓冲，勿在页面以外反复调用。
- 日志消息含 CQ 码（图片/回复/@），展示时可替换为 `[图片] [回复] [@]`。

## JS 扩展页（#/mod/js）

- 标签页：`控制台`、`插件列表`、`插件设置`（Element Plus tabs，`document.querySelectorAll(".el-tabs__item")`）。
- 按钮：`重载 JS`、`执行代码`、`上传插件`，以及每个插件卡片上的 `更新`/`删除`。
- 插件列表是卡片列表，含插件名、版本、作者、介绍、安装/更新时间。
- 上传插件对应页面里的 `input[type=file]`；上传与重载均会改动线上机器人，必须用户明确批准。

### 插件卡片 DOM（读取安装情况用）

每个插件是 `.el-card.js-item`，关键选择器：

| 字段 | 选择器 |
|---|---|
| 启用/停用 | `input.el-switch__input` 的 checked，或 `.el-switch.is-checked` |
| 插件名 | `b.el-text--large` |
| 版本 | `.js-item-header .el-space__item:nth-child(3) .el-text` |
| 按钮（更新/删除） | 卡片内 `button` 文本 |
| 作者/介绍/主页/许可协议/安装时间/更新时间 | `.el-descriptions__cell` 里的 label/content 对 |

## 故障排查

- 导航超时：SPA 长轮询导致 `networkidle` 永不满足，改用 `domcontentloaded`。
- 面板锁着：所有业务接口 403；先解锁再抓接口。
- 浏览器实例冲突：每次用独立临时 user-data-dir（`puppeteer.launch` 默认）即可，勿复用运行中 Edge 的用户目录。

## 上传插件与重载 JS（scripts/panel.mjs）

命令：`upload-reload [--file <插件文件>]`（默认 `dist/aiplugin4.js`）、`reload`。

- 流程：解锁 → 打开 `#/mod/js` → 文件框上传插件 → **等待上传完成数秒（脚本已等 6 秒）** → 点击「重载 JS」→ 等待完成。
- 重载 JS 影响全部 JS 插件，属写操作：默认需用户批准；**两次重载间隔必须 ≥ 1 分钟**。
- 上传成功可用 `plugins` 确认：目标插件"安装时间"会更新为"几秒前"且仍启用。
- 重载完成后等待数秒，再用 `logs` 查看重载日志（该接口会清空服务端缓冲），确认无报错并把日志摘要写入报告；随后向测试群发 `.ai status` 验证插件仍响应。

## 插件设置与调试配置（aiplugin4「后端」二级页签）

实测结构（SealDice 1.6.0）：

- 「插件设置」页签按插件列出折叠项，条目名是 `aiplugin4`（不是显示名"AI骰娘4"）；点击折叠头 `aiplugin4` 展开配置页签：默认分组/基础/模型/后端/消息接收/消息触发/图片/工具/记忆/回复/对话/prompt模板/资源。
- 「后端」页签含 6 个字符串字段：流式输出（默认 `http://localhost:3010`）、图片转base64（`https://urltobase64.fishwhite.top`）、联网搜索（`https://searxng.fishwhite.top`）、网页读取（`https://webread.fishwhite.top`）、用量图表（`http://usagechart.error2913.com`）、md和html图片渲染（`https://md.fishwhite.top`）。
- 字段名显示在表单内容区（如"流式输出"），`.el-form-item__label` 只显示类型（"字符串配置项:"）。
- **「点我保存」按钮只在修改字段后才渲染**；未修改时页面中不存在该按钮。
- 保存是否生效必须**新开页面**重新进入「后端」读取字段值验证，不能只信当前页面值。

只允许修改 aiplugin4 插件设置中「后端」二级页签内的配置项，其他一律不碰：

1. `panel.mjs inspect` 查看标签页/按钮/字段；必要时 `panel.mjs steps --file steps.json` 分步点击「插件设置」→ 点击折叠头 `aiplugin4` → 点击「后端」。
2. 先用 `steps` 的 dump 记录待改字段的**原始值**（快照）。
3. `steps` 中 `set` 修改目标字段 → `click`「点我保存」→ 等待保存完成 → dump；随后**新开页面**验证已保存。
4. 恢复原样：字段改回快照值 → 再次点击「点我保存」→ **新开页面**验证已恢复。
5. 页面上不属于二级页签的项不点击、不修改；其他插件配置不动。

steps.json 示例：

```json
[
  { "type": "click", "text": "插件设置", "afterMs": 1500 },
  { "type": "click", "text": "aiplugin4", "afterMs": 2500 },
  { "type": "click", "text": "后端", "afterMs": 1000 },
  { "type": "dump" },
  { "type": "set", "label": "流式输出", "value": "<新值>" },
  { "type": "click", "text": "点我保存", "afterMs": 2500 },
  { "type": "dump" }
]
```

`set` 的 `label` 用字段名（如"流式输出"）；`click` 会优先匹配可见的精确文本，页签优先。
