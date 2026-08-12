# AGENT.md — AI 代理协作指南

本文件是给 AI 编码代理（Codex / Claude 等）的入口速查。完整说明以 `docs/` 知识库为准（索引见 `docs/README.md`，开发细节见 `docs/07-开发指南.md`）。

## 项目简介

AI骰娘4（aiplugin4）：运行在 [SealDice](https://docs.sealdice.com/) 上的 AI 对话插件。TypeScript 编写，用 esbuild 打包为单文件 `dist/aiplugin4.js`（生产不压缩，便于用户查错）。核心能力：上下文对话、记忆/知识库、函数调用与提示词工程、MCP 工具、Skills 技能、黑名单/定时器/图片/论坛等工具集，并通过 `globalThis.aiplugin4` 向其他海豹插件暴露 API。

## 常用命令

```bash
npm install                 # 安装依赖
npm run build               # 生产构建 → dist/aiplugin4.js（头部拼接 header.txt）
npm run build-dev           # 开发构建 → dev/aiplugin4.js（带 sourcemap）
npm run lint                # ESLint 检查 src/**/*.ts
npx tsc --noEmit            # 类型检查（tsconfig 为 bundler 解析模式）
npm run smoke               # 冒烟：Node 中用 seal 桩加载产物，提前发现加载期错误
npm run package:check       # 构建 + 同步 sealpack 源 + 校验包格式与体积
npm run pack:sealpack       # 打包 → dist/aiplugin4.sealpack
npm run pack:release        # 发布打包：本体 JS + 本体豹包 + 完整豹包
```

改完核心逻辑建议执行 `npm run build && npm run smoke`。

## 代码导航

- `src/index.ts`：装配入口，只做注册；事件处理统一走 `src/pipeline.ts`。
- `src/event/`：事件接入与分发（含 ob11 数组消息、文件/卡片/合并转发展开等特殊路径）。
- `src/agent/`：智能体编排（run/runStream、对外 API `globalThis.aiplugin4`）。
- `src/context/`、`src/session/`：会话与上下文管理；`src/prompt/`：提示词组装。
- `src/tool/`：工具系统（注册表、MCP、skills、按需加载；内置工具在 `src/tool/tools/`）。
- `src/config/`：配置注册/读取与静态常量；`src/model/`：对话/图片/嵌入模型。
- `src/cmd/`：`.ai` 命令系统与权限；`src/memory/`：记忆与知识库；`src/resource/`：资源；`src/utils/`：通用工具。
- `docs/`：项目知识库（01 概览 / 02 架构 / 04 工具系统 / 05 命令配置 / 07 开发指南 / 09 常见问题）。
- `skills/aiplugin4-test-suite/`：仓库内置的插件测试技能（Codex 用）。
- `examples/use-aiplugin4.js`：演示外部插件调用对外 API 的可加载示例。

## 开发约定（务必遵守）

1. **不要直接在 main 上做功能修改**：先开分支 → PR → review → squash merge 合入 main；合并后清理本地和远程分支。分支名不要用 `codex/` 前缀（用 `feat/`、`fix/`、`docs/`、`chore/` 等）。纯文档改动也建议走 PR。
2. **PR 合入统一 squash merge**；`on.pull_request` 不要加回 `release.yml`（否则发布 job 会在 PR 上显示 Skipped）。
3. **中文提交信息 / PR 正文通过 UTF-8 文件传递**（如 `.dev/commit-msg.txt`、`.dev/pr-body.json`），不要在 shell 里拼接中文。
4. **新增消息级能力优先做成"工具"**（`src/tool/tools/` 下新建文件导出 `registerXxx()`，在 `src/tool/tools/init.ts` 注册）；敏感操作（发消息/禁言/改名等）置 `sensitive = true`；工具名不要与已有工具重复。
5. **`registerTemplateConfig` 默认值不能是空数组**，至少保留一个元素（占位用 `['']`）。
6. **配置项描述要引导用户**：写清格式、必填/可选参数、示例；配置页签按重要性排列（基础/模型/对话/消息接收/消息触发/回复/工具/记忆/图片/后端/prompt模板/资源）。
7. **模板文案放配置模板**（`src/config/configs/prompt.ts`），不要硬编码在业务逻辑。
8. **日志统一走 `Logger`**（脱敏/截断），不要直接打明文密钥；网络请求统一 `withTimeout` + `fetchData`/`requestModel`，避免卡死。
9. **修改持久化类字段后检查 `validKeysMap`** 是否需要同步更新（用 `revive()` 恢复）。
10. **新增对外 API**（`globalThis.aiplugin4`）时同步更新 `docs/07-开发指南.md` 的「为其他插件提供 API」表格与示例。

## 开发完成检查清单

每个功能/改动开发完成并验证后，发布前必须同步三处，否则发版说明与用户文档会脱节：

1. `src/update.ts`：在 `updateInfo` 的最新版本条目补充本次改动（`- 描述`），发布工作流读取它生成 GitHub Release 正文。
2. `README.md`：同步配置手册/命令手册/可用工具函数等章节（商店 README 只放用户内容，不要放开发章节）。
3. 知识库 `docs/`：涉及命令/配置/工具/架构的改动同步对应文档（常用 04/05/03/09）。

## 发布流程

1. 版本推进：`src/config/static_config/meta.ts` 的 `VERSION`、`header.txt` 的 `@version`、`sealpack/info.toml` 的 `version`（由 `scripts/prepare-sealpack.js` 自动同步）、`src/update.ts` 新增对应版本条目，走 PR 合并到 main。
2. 推送 `v<版本>` 标签 → GitHub Actions `release.yml` 自动：verify（校验标签与 VERSION/update.ts 一致）→ `node scripts/build-release.js` 打包（本体 JS + 本体豹包 + 完整豹包）→ 用 `SEALPACK_TOKEN` 发布两个豹包到 SealRepo → 从 `update.ts` 提取版本日志创建 GitHub Release。
3. 完整包依赖插件在 `scripts/deps.cjs` 的 `dependencies` 配置（`url` 为 raw 地址）；包图标 `sealpack/assets/icon.png`；SealRepo Token 放仓库 secrets（`SEALPACK_TOKEN`）。

## CI 工作流

- `build-check.yml`：push 到 main / `refactor/**` 及 PR 时跑 lint、类型检查与构建，保证主分支可编译。
- `release.yml`：推送 `v<版本>` 标签触发发布（流程见上）。

## 测试

- 本地冒烟：`npm run build && npm run smoke`。
- 海豹面板 / QQ 环境测试：使用 Codex 技能 `aiplugin4-test-suite`（全量/单项/重载/配置调试用例，技能本体在 `skills/aiplugin4-test-suite/`），面板自动化与 qqmcp 复用 `sealdice-plugin-dev` 技能。
- 面板 API 登录注意：新版海豹 signin 不是明文密码——先 `GET /sd-api/signin/salt` 拿盐，密码经 PBKDF2-SHA512(password, salt, 1000, 32) 哈希后拼成 `base64("v01"+salt+迭代数+derived)` 提交（本机工具脚本见 `.dev/panel-api.ps1`、`.dev/sign-hash.mjs`，`.dev/` 已 gitignore）。

## 常见坑速查

- PowerShell：主环境已是 pwsh 7（UTF-8）；含中文的 `.ps1` 保留 BOM（5.1 按 ANSI 解析会乱码）。
- 无 gh CLI 时操作 GitHub：用 `git credential fill`（.NET Process 写 stdin）+ REST API，token 不要打印。
- 模板仓库 `sealdice-js-ext-template` 与本仓库的 `release.yml` 都不要带 `on.pull_request`。
