# AGENT.md — AI 代理协作指南

本文件是给 AI 编码代理（Codex / Claude 等）的入口速查。完整说明以 `docs/` 知识库为准（索引见 `docs/README.md`，开发细节见 `docs/07-开发指南.md`，分层与依赖规则见 `docs/02-架构设计.md`）。

## 项目简介

AI骰娘4（aiplugin4）：运行在 [SealDice](https://docs.sealdice.com/) 上的 AI 对话插件。TypeScript 编写，用 esbuild 打包为单文件 `dist/aiplugin4.js`（生产不压缩，便于用户查错）。核心能力：上下文对话、记忆/知识库、函数调用与提示词工程、MCP 工具、Skills 技能、黑名单/定时器/图片/论坛等工具集，并通过 `globalThis.aiplugin4` 向其他海豹插件暴露 API。

## 常用命令

```bash
npm install                 # 安装依赖
npm run build               # 生产构建 → dist/aiplugin4.js（头部拼接 header.txt）
npm run build-dev           # 开发构建 → dev/aiplugin4.js（带 sourcemap）
npm run lint                # ESLint 检查 src/**/*.ts
npx tsc --noEmit            # 类型检查（直跑 tsconfig，不要加 --strict 覆盖）
npm run smoke               # 冒烟：Node 中用 seal 桩加载产物
npm run test:unit           # 单元测试（esbuild 打包 scripts/unit-test-*.ts）
npm run test:ob11           # OB11 runtime 模拟
npm run sim                 # 上下文成本治理端到端模拟（14 项）
npm run sim:matrix          # 消息顺序/时序矩阵（76 项）
npm run fuzz                # 随机化长跑（FUZZ_SEEDS/FUZZ_ROUNDS 可回放）
npm run package:check       # 构建 + 同步 sealpack 源 + 校验包格式与体积
npm run pack:sealpack       # 打包 → dist/aiplugin4.sealpack
npm run pack:release        # 发布打包：本体 JS + 本体豹包 + 完整豹包
npm run deps:check          # 依赖边界 ratchet（基线 scripts/deps-baseline.json）
npm run deps:update         # 收紧基线（恶化需 --allow-grow 并在 PR 说明）
npm run version:check       # 版本号单一事实源校验（meta.ts VERSION ↔ 其余位置）
npm run version:sync        # 按 meta.ts VERSION 回写其余版本位置
npm run changelog:check     # changelog 数据文件（src/changelog/<版本>.ts）↔ 聚合索引一致
npm run changelog:gen       # 按数据文件重新生成聚合索引 src/changelog.ts
npm run domain:check        # 默认值生成物（config/domain/default_data.ts）↔ 默认值源一致
npm run domain:gen          # 从默认值源重新生成 default_data.ts
npm run docs:manifest       # 文档清单（docs-site/manifest.js ↔ docs/ccdocs/磁盘 ↔ mkdocs nav）
npm run docs:build          # 构建文档站点（需 mkdocs）
```

改完核心逻辑建议执行 `npm run build && npm run smoke`；提交前至少跑 `npx tsc --noEmit`、`npm run lint`、`npm run test:unit`、`npm run deps:check`。

## 代码导航

- `src/index.ts`：装配入口，只做注册；事件处理统一走 `src/pipeline.ts`。装配顺序是契约：`setHost` → `registerConfigAppliers` → `installAuxLlm`/`installPromptMemorySource` → `Config.registerConfig`（warmup）→ 其余 init。
- `src/core/`：宿主端口（HostSeam）——`host.ts` 定义 `storage/clock/fetch/ext` 接口与 `setHost/getHost`，`seal_host.ts` 是唯一直接读 `seal`/`ext` 的适配器；业务代码一律 `getHost()`（单测/模拟器由 `scripts/test-host.ts` 复用 `scripts/harness/seal-env.cjs` 注入）。`core/ports/`：跨层端口——`agent_registry`、`aux_llm`、`session_lookup`、`judge_wait`、`media_notice`；跨层协作「各自注册一半到端口」，不要互相 import（当前 0 环）。
- `src/pipeline.ts` + `src/pipeline/`：消息/事件唯一入口；`dedup`（配对/去重状态机）、`events`（事件提示词）、`inbound`（ob11 段渲染）、`endpoint`（端点解析）。
- `src/agent/`：智能体编排（`run`/`runStream`、错误恢复、`.ai stop`、对外 API `api.ts`、`aux_llm_impl.ts`、`stream.ts`）；`src/subagent/`：独立子代理模块（DSH 对齐：委派/fork、后台 job、可续跑、持久化与唤醒，自管独立上下文、不 import `src/context/**`；公共入口 `src/subagent/index.ts`）。
- `src/session/`、`src/context/`：会话与上下文（session：`setting`/`rhythm`/`persistence`/`inbox`/`outbox`/`tool_listen`；context：`events`/`head`/`keys`、`log/*`、`store`/`service`、`content/*`、`view/*`、`recall`、`compact/*`、`migrate/*`、`commands`/`admin`、`projection`；旧 `archiver`/`window_policy`/`archive_store` 仅迁移/回退使用）；`src/prompt/`：system prompt 组装、模板缓存、记忆数据源端口。
- `src/tool/`：工具系统——`registry.ts` 注册表 / `bootstrap.ts` 装配 / **`executor.ts` 统一执行器**（函数调用、`call_tool`、`.ai tool call` 共用校验/超时/审计）/ `runner.ts` 两路径薄包装 / `tool_group.ts` 工具组开关 / `mcp*`（config/client/mcp.ts 三层）/ `skills.ts`；内置工具在 `src/tool/tools/<分类>/`。
- `src/model/`：模型注册表（`model.ts` + `entry.ts` + `registry_ops.ts`）、能力分类 `catalog.ts`、协议方言 `api_dialect.ts`、请求管道 `provider.ts`/`adapter.ts`、规则 `request_rules.ts`、媒体预设/模板/解析 `media_presets.ts`/`media_template.ts`/`media.ts`、列表 `list.ts`、余额 `balance.ts`、错误分类 `api_error.ts`。
- `src/memory/`：`manager.ts` 门面、知识库 `knowledge_*.ts`、v2 引擎（`engine.ts` + `scoring`/`consolidation`/`mental_models`/`reflection`/`repository`/`storage`/`prompt`/`templates`/`migrate`）。
- `src/resource/`：`image.ts`（实体/注册表）、`image_url`/`image_inbound`/`image_text`/`image_transfer`/`image_health`（纯逻辑叶子）、`image_host`（图床客户端）、`image_index`/`image_gc`（索引与清理）、`image_ref`（CIR v1）、`local_paths`/`local_images`（本地资源）。
- `src/config/`：`config.ts` 总线（20 个分组，60s 缓存）、`configs/*` 只解析、`apply/*` + `hooks.ts` 应用、`ext.ts` 宿主句柄叶子、`v5/`（模型配置 schema/adapt/vendor/default）、`domain/`（角色/技能/MCP/知识库 JSON + `default_data.ts` 生成物）、`static_config/`（常量）。
- `src/cmd/`：`.ai` 根命令与权限（`bootstrap.ts` 装配 27 个子命令）；`src/media/` 媒体任务队列；`src/web/` 联网；`src/pub/` 公开会话；`src/event/notice.ts` 事件文本；`src/judge/` 评分；`src/timer.ts`/`src/block.ts`/`src/usage.ts`/`src/token_calibration.ts`。
- `src/utils/`：通用工具已拆叶子——`message_id`/`path`/`alias`/`similarity`/`id`/`revive`/`timeout`/`json`/`render_tags`/`raw_marker`/`special_id`/`target_id`/`url`/`concurrency`/`backend`/`markdown`/`resource` 等；`utils.ts` 只剩 `replyToSender` 等聚合入口，新代码直接 import 对应叶子。
- `docs/`：项目知识库（01 概览 / 02 架构 / 03 模块 / 04 工具 / 05 命令配置 / 06 存储 / 07 开发指南 / 08 后端 / 09 常见问题 / 10 TODO / 11 核心桥 / 12 配置 JSON 化 / 16、17 图片方案）。
- `skills/aiplugin4-test-suite/`：仓库内置的插件测试技能（Codex 用）；`examples/use-aiplugin4.js`：外部插件调用 API 示例。

## 开发约定（务必遵守）

1. **不要直接在 main 上做功能修改**：先开分支 → PR → review → squash merge 合入 main；合并后清理本地和远程分支。分支名不要用 `codex/` 前缀（用 `feat/`、`fix/`、`docs/`、`chore/`、`refactor/` 等）。纯文档改动也建议走 PR。
2. **PR 合入统一 squash merge**；`on.pull_request` 不要加回 `release.yml`（否则发布 job 会在 PR 上显示 Skipped）。
3. **中文提交信息 / PR 正文通过 UTF-8 文件传递**（如 `.dev/commit-msg.txt`、`.dev/pr-body.json`），不要在 shell 里拼接中文。
4. **依赖只向下**（L0 基础 → L1 纯逻辑 → L2 能力 → L3 领域 → L4 装配）；新增目录必须在 `scripts/lib/deps.mjs` 补 `LAYER_RULES`；跑 `npm run deps:check`，架构调整用 `npm run deps:update`。
5. **宿主能力走端口**：存储/时钟/网络用 `getHost().storage|clock|fetch`；新增模块不要直接 `ext.storageGet/Set` 或裸 `fetch`。
6. **双向协作用 `core/ports/`**：双方各自注册一半，不互相 import；端口实现是动态委派，不要缓存函数引用。
7. **配置解析/应用分离**：`configs/*` 只解析，`config/apply/*` + `hooks.ts` 应用；`Config.registerConfig()` 的预热必须走 `getCache`（`warmup()`），否则应用钩子不执行。
8. **新增消息级能力优先做成工具**（`src/tool/tools/` 下导出 `registerXxx()`，在 `tools/init.ts` 注册）；敏感操作置 `sensitive = true`；工具名不要重复。
9. **`registerTemplateConfig` 默认值不能是空数组**，至少保留一个元素（占位用 `['']`）。
10. **配置页签顺序以 `config.ts` 的 `configMap` 为准**（基础/模型/角色/上下文/消息接收/触发/回复/工具/联网/MCP/技能/子代理/记忆/知识库/图片/后端/论坛/事件/资源/错误处理）。
11. **模板文案放内置模板**（`src/prompt/templates.ts`），不要硬编码在业务逻辑。
12. **日志统一走 `Logger`**（脱敏/截断），不要打明文密钥；网络请求统一 `withTimeout` + `fetchData`/`requestModel`。
13. **修改持久化类字段后检查 `validKeysMap`**（用 `revive()` 恢复）。
14. **tsconfig 启用 `noImplicitThis`**：普通函数里不要用 `this`（需要时显式标注 `this: Host`）；`noUnusedLocals`/`noUnusedParameters`/`noImplicitReturns` 开启。
15. **大文件按叶子模块拆**：单文件单一职责；拆分后原 API 保留同名委派/`re-export`，外部 import 零改动；每步跑全量验证。
16. **新增对外 API**（`globalThis.aiplugin4`）同步更新 `docs/07-开发指南.md` 的 API 表格与示例。
17. **方案/审查/实验/临时分析禁止进入 `docs/`**：放 `.dev/`（gitignore）或 PR 描述；`docs/` 只保留稳定知识库，结构必须与既有编号/插件架构章节一致，不新增插件架构之外的二级章节；实现完成后把最终行为并入对应 02/03/04/05/06/09。

## 开发完成检查清单

发布前必须同步（缺一项 CI 或发版正文就会与代码脱节）：

1. `src/changelog/<版本>.ts`：在对应版本数据文件补充改动条目（`- 描述`），再 `npm run changelog:gen` 生成聚合索引（勿手改 `src/changelog.ts`）；发布工作流读取数据文件生成 GitHub Release 正文。
2. `README.md`：同步配置手册/命令手册/可用工具函数等章节（商店 README 只放用户内容，不放开发章节）。
3. 知识库 `docs/`：涉及命令/配置/工具/架构的改动同步对应文档（常用 03/04/05/09；架构改动同步 02）；方案/审查/实验放 `.dev/`，禁止进入 `docs/`，也不新增插件架构之外的二级章节。
4. 配置项更改（新增/删除/默认值/弃用）在版本数据文件「配置项更改」小节注明；模板等默认值变更在「重要」小节提醒恢复默认。
5. 版本号：改 `meta.ts` 的 `VERSION` 后跑 `npm run version:sync`；`sealpack/info.toml` 由 `prepare-sealpack.js` 同步。
6. 文档清单：新增/删除 `docs/*.md` 后更新 `docs-site/manifest.js` 与 `docs-site/mkdocs.yml`，跑 `npm run docs:manifest`。

## 发布流程

1. 版本推进：`meta.ts` 的 `VERSION`、`header.txt` 的 `@version`、`package.json` / `package-lock.json` 的 `version`、新增 `src/changelog/<版本>.ts` 数据文件（并 `npm run changelog:gen`）；`sealpack/info.toml` 由 `prepare-sealpack.js` 自动同步；走 PR 合并到 main。
2. 推送 `v<版本>` 标签 → `release.yml` 自动：verify（标签与 `VERSION`/changelog 数据文件一致）→ `node scripts/build-release.js` 打包（本体 JS + 本体豹包 + 完整豹包）→ 用 `SEALPACK_TOKEN` 发布两个豹包到 SealRepo → 从数据文件提取版本日志创建 GitHub Release。
3. 完整包依赖插件在 `scripts/deps.cjs` 的 `dependencies` 配置（`url` 为 raw 地址）；包图标 `sealpack/assets/icon.png`；SealRepo Token 放仓库 secrets（`SEALPACK_TOKEN`）。

## CI 工作流

- `_check.yml`：可复用质量门禁（`workflow_call`）——版本/changelog/默认值一致性、lint、`tsc --noEmit`、单测、依赖边界、`package:check`、冒烟。
- `build-check.yml`：push 到 main / `refactor/**` 及 PR 时调用 `_check.yml`。
- `docs.yml`：文档变更时构建站点并校验清单/链接，push main 发布 Pages。
- `release.yml`：推送 `v<版本>` 标签触发发布（流程见上）。

## 测试

- 本地冒烟：`npm run build && npm run smoke`。
- 单测/模拟：`npm run test:unit`、`npm run sim`、`npm run sim:matrix`、`npm run fuzz`、`npm run test:ob11`（共享 seal 桩在 `scripts/harness/seal-env.cjs`，新增 seal API 只改这一处）。
- 海豹面板 / QQ 环境测试：使用 Codex 技能 `aiplugin4-test-suite`（全量/单项/重载/配置调试用例，技能本体在 `skills/aiplugin4-test-suite/`），面板自动化与 qqmcp 复用 `sealdice-plugin-dev` 技能。
- 面板 API 登录注意：新版海豹 signin 不是明文密码——先 `GET /sd-api/signin/salt` 拿盐，密码经 PBKDF2-SHA512(password, salt, 1000, 32) 哈希后拼成 `base64("v01"+salt+迭代数+derived)` 提交（本机工具脚本见 `.dev/panel-api.ps1`、`.dev/sign-hash.mjs`，`.dev/` 已 gitignore）。

## 常见坑速查

- 不要用 `tsc --strict` 覆盖 tsconfig 的严格选项（会静默吞掉联合类型未收窄之类的错误）。
- `deps:check` 报「未分类文件」= 新目录没配 `LAYER_RULES`；报「新增跨层依赖」= 低层 import 高层，改端口注入或下沉叶子。
- PowerShell：主环境已是 pwsh 7（UTF-8）；含中文的 `.ps1` 保留 BOM（5.1 按 ANSI 解析会乱码）。
- 无 gh CLI 时操作 GitHub：用 `git credential fill`（.NET Process 写 stdin）+ REST API，token 不要打印。
- 模板仓库 `sealdice-js-ext-template` 与本仓库的 `release.yml` 都不要带 `on.pull_request`。
