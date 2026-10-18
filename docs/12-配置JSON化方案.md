# 12 - 角色 / 技能 / MCP / 知识库配置 JSON 化方案

> 状态：**已实现**（插件分支 `feat/config-json`；生成器分支 `feat/domain-tabs`）。本文件从方案保留为格式与实现说明。
>
> 已确认的产品决策：
> - **不做迁移、不做兼容**：新配置用**新键名**，旧键名不再读取，旧值留在配置文件里但界面上隐藏。
> - 四个配置项都改成 **String 配置（一份 JSON）**，不再用多框模板。
> - 生成器默认生成的内容与当前插件默认配置一致；新版本默认配置解析后与当前默认行为一致。
> - 校验失败**整份拒绝**（与模型 v5 一致）。
> - 生成器每个条目都有**启用开关**，但开关只控制“是否写进生成配置”，**不写 `enabled` 字段**（关闭 = 该条目直接不出现在 JSON 里）；角色不加平台限制；暂不做“全部分区配置包”。

## 1. 背景

配置生成器（<https://error2913.github.io/aiplugin4-config/>）原来只覆盖「模型」和「联网」。本次扩展为 6 个页签，其中四个内容分区的生成器侧已经完成：

| 生成器页签 | 产出 |
| --- | --- |
| 角色设定 | `{version:1, roles:[{name,prompt}]}` |
| 技能 | `{version:1, skills:[{name,description,platform,content}]}` |
| MCP | **标准 MCP JSON**：`{"mcpServers":{"<服务器名>":{"type":"http","url":"…","headers":{…}}}}`；扩展字段 `platform` |
| 知识库 | `{version:1, libraries:[{name,description,platform,content}]}` |

插件侧目前这四项都是 `registerTemplateConfig`（多框：frontmatter + 正文），需要同步改成「单框 String + JSON 解析」，否则生成器产出的 JSON 无法直接粘贴。

## 2. 目标与非目标

### 做

- 插件新增四个 String 配置项，分别接收上表四份 JSON。
- 解析成与当前完全一致的运行时结构，四个消费点（角色、技能、MCP、知识库）行为不变。
- 出厂默认 JSON 解析后与当前默认行为一致（角色默认、录卡技能、三个知识库）；MCP 默认空配置（生成器仍保留三台示例）。
- 生成器的启用开关只在生成器侧生效：停用条目不写入 JSON，插件侧不需要 `enabled` 字段。
- 校验一次报出全部问题，带 `$.mcpServers.<名>.url` 形式的路径；非法配置整份拒绝。
- 同步命令帮助、README、`docs/`、`changelog.ts` 与测试。

### 不做

- 不迁移旧的多框配置，不读取旧键名。
- 不做配置写入（海豹没有该 API）。
- 不做“全部分区合并成一个大 JSON”。
- 不做 MCP stdio / SSE。
- 不把「是否启用MCP / 启用知识库记忆 / 会话回收分钟」塞进 JSON，它们仍是独立配置项。
- 角色不加 `platform`。

## 3. 新配置项

旧键名与新键名**必须不同**（同键改类型会被海豹当成 type 变化并重置值，且容易踩到类型不匹配）：

| 新键名 | 类型 | 分组 | 对应旧键（不再注册、不再读取） |
| --- | --- | --- | --- |
| `角色设定` | string | 角色设定 | `角色扮演设定` |
| `技能列表` | string | 技能 | `技能配置` |
| `MCP服务器` | string | MCP | `MCP服务器配置` |
| `知识库配置` | string | 知识库 | `知识库` |

注册方式：

```ts
seal.ext.registerStringConfig(ext, '技能列表', DEFAULT_SKILLS_JSON, DESC, '技能');
```

旧键不注册即可：配置管理器加载时会把未重新注册的项标记为 `deprecated`，WebUI 不再显示，但旧值仍留在 `config.json` 里（用户可自行清理）。**不读旧值、不转换、不提示迁移**；升级后四项回到出厂默认，用户按生成器重新生成后粘贴。

> 注意：`registerStringConfig` 的默认值必须是**完整的一份 JSON 字符串**（不是空串），保证新装/升级后立即有可用默认。

## 4. JSON 格式（schema v1）

通用约定：

- 角色 / 技能 / 知识库：顶层对象，`version` 必须为 `1`；集合字段是数组，顺序即运行时顺序。
- MCP：**使用标准 MCP 配置格式**（顶层 `mcpServers` 对象，键 = 服务器名），没有 `version` 字段。
- `platform` 接受字符串或字符串数组；省略 / `""` / `[]` = 所有平台。
- 字符串内容可以是任意 Markdown / 多行文本（JSON 转义承载）。
- 未知字段忽略并记 warning；`version` 不支持、必填字段缺失、名称重复、类型错误 → 整份拒绝。
- 允许尾逗号（复用 `src/utils/json.ts` 的 `parseJSONWithTrailingCommas`）。

### 4.1 角色设定

```json
{
  "version": 1,
  "roles": [
    { "name": "测试机器人", "prompt": "你是一个QQ中的机器人，正在进行开发测试……" }
  ]
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | 是 | 角色名；超过 20 字符按旧行为截断 + warning |
| `prompt` | 是 | 角色设定正文（原“第一行之后的内容”） |

解析结果仍提供 `ROLE_NAMES` / `ROLE_SETTINGS` / `INSTRUCTIONS`（`INSTRUCTIONS` 可由 `name + '\n' + prompt` 还原，供 `.ai role` 的旧逻辑与测试使用）。

### 4.2 技能

```json
{
  "version": 1,
  "skills": [
    {
      "name": "录卡",
      "description": "把角色卡表格录入 SeaDice……",
      "platform": [],
      "content": "# 录卡流程\n……"
    }
  ]
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | 是 | 技能名，唯一；`use_skill` 按名称引用 |
| `description` | 否 | 摘要；省略/空串 = 无描述 |
| `platform` | 否 | 平台白名单 |
| `content` | 是 | SKILL.md 正文（不含 frontmatter） |

保留现有行为：**补入缺失的出厂默认技能**（用户配置里没有同名“录卡”时自动补，避免升级后新默认技能不可用）。`SKILL_INJECT_MAX_CHARS`、`SKILL_LIST_LIMIT` 等常量不变。

### 4.3 MCP（标准 mcpServers 格式）

```json
{
  "mcpServers": {
    "mcp-files-exec": {
      "type": "http",
      "url": "http://127.0.0.1:3910/mcp",
      "headers": { "Authorization": "Bearer token" }
    },
    "md-html-render": {
      "type": "http",
      "url": "http://127.0.0.1:37632/mcp",
      "platform": ["QQ"]
    }
  }
}
```

- **顶层必须是标准 `mcpServers` 对象**（与 Claude Desktop / Cursor 的 `.mcp.json` 一致）；键 = 服务器名，因此条目里不再有 `name` 字段。
- 标准字段：`type`（缺省 `http`，仅接受 `http` / `streamable-http`）、`url`（必填，`http(s)://`）、`headers`（对象，值必须是字符串）。
- aiplugin4 扩展字段（标准客户端会忽略未知字段）：
  - `platform`：平台白名单。
- 生成器不会输出非标准字段：卡片里的 `token` 是输入简写，导出时合并成 `Authorization: Bearer …`。
- 生成器卡片头的「启用」开关不写进 JSON：关闭 = 该服务器直接不出现在 `mcpServers` 里。
- 插件解析时也接受 `token` 简写（兼容手写），但有 `headers.Authorization` 时以它为准。
- stdio（`command`）与 SSE 继续不支持，解析时跳过并记 warning。

停用的服务器：生成器不会把它写进 JSON，插件自然不连接、不注册工具、不出现在 `.ai mcp list`。

### 4.4 知识库

```json
{
  "version": 1,
  "libraries": [
    {
      "name": "核心指令",
      "description": "SealDice 核心指令的调用规则与逐条帮助",
      "platform": [],
      "content": "# 核心指令调用帮助\n……"
    }
  ]
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | 是 | 库名，唯一 |
| `description` | 否 | 省略/空串 = 运行时用正文首段兜底（保持旧行为） |
| `platform` | 否 | 平台白名单 |
| `content` | 是 | Markdown 正文；`#` 条目 / `##`/`###` 小节 / 800 字符分块规则不变 |

## 5. 插件侧改动

### 5.1 新增纯逻辑模块

建议目录 `src/config/domain/`（不依赖 `seal`，可直接单测）：

```
src/config/domain/
  types.ts      四个配置的 TS 类型 + DOMAIN_VERSION（MCP 走标准 mcpServers，无 version）
  parse.ts      解析 + 校验（带 $.a.b[0].c 路径）
  defaults.ts   出厂默认对象 + 对应的 JSON 字符串
```

插件运行时**只读 JSON**，不再保留任何旧格式/frontmatter 解析；标准 `SKILL.md` 的 frontmatter 只属于生成器的“文件导入”能力，不进入插件运行时。

解析入口建议：

```ts
export interface ParseResult<T> { config: T | null; issues: Issue[]; warnings: Issue[] }

export function parseRolesConfig(text: string): ParseResult<RolesConfig>
export function parseSkillsConfig(text: string): ParseResult<SkillsConfig>
export function parseMcpConfig(text: string): ParseResult<McpConfig>
export function parseKbConfig(text: string): ParseResult<KbConfig>
```

复用：
- `src/utils/json.ts` 的 `parseJSONWithTrailingCommas`；
- 平台匹配 `src/utils/target_id.ts`；
- 旧的多框/frontmatter 解析逻辑不进入新链路；插件只解析 JSON。

### 5.2 四个配置注册/读取点

| 文件 | 改法 |
| --- | --- |
| `src/config/configs/role.ts` | 注册 `角色设定`；读 string → 解析 → `ROLE_NAMES` / `ROLE_SETTINGS` / `INSTRUCTIONS`；删除旧 template 注册 |
| `src/config/configs/skills.ts` | 注册 `技能列表`；`get()` 返回结构化 `SKILLS` |
| `src/config/configs/mcp.ts` | 注册 `MCP服务器`；`get()` 返回结构化 `MCP_SERVERS` |
| `src/config/configs/knowledge_base.ts` | 注册 `知识库配置`；`get()` 返回结构化 `LIBRARIES` |

解析缓存仍走 `Config` 的 60s cache；消费侧的模块级缓存（`skillsCache`、`mcpServersCache`、`knowledgeService`）与 refresh 机制不变。

### 5.3 消费点改造

| 文件 | 改动 |
| --- | --- |
| `src/utils/message.ts` | 直接用 `ROLE_SETTINGS[roleIndex]`，不再 `parseRoleEntry` |
| `src/cmd/sub_cmd/role.ts` | 不改逻辑；名称列表来源不变 |
| `src/tool/skills.ts` | `compileSkills()` 改为消费 `Config.skills.SKILLS` 结构化数组；保留“补默认技能” |
| `src/tool/mcp.ts` | `getMCPServers()` 改为消费 `Config.mcp.MCP_SERVERS`；旧 `parseMCPServerElement` 不再被运行时使用 |
| `src/memory/knowledge_base.ts` | `reload()` / `refresh()` 改为消费 `Config.knowledgeBase.LIBRARIES`；签名改用“库名+描述+内容+平台”的稳定拼接 |
| `src/cmd/sub_cmd/{skill,mcp,kb}.ts` | 帮助文案里的“frontmatter 的 platform”改成“JSON 的 platform 字段” |

### 5.4 校验与失败策略（已确认整份拒绝）

| 情况 | 行为 |
| --- | --- |
| JSON 语法错误 / version ≠ 1（MCP 无 version）/ 顶层集合结构不对 | ERROR 日志列出全部问题 + 生成器提示；该分区按空处理 |
| 条目缺 `name` / `content` / `url`，类型错误，名称重复 | 同上 |
| 未知字段 | 忽略 + warning |
| 角色名 > 20 字符 | 截断 + warning |
| 技能正文 > 12000 字符 | warning（仍完整保存，`use_skill` 返回时截断） |
| 角色配置非法 | 回退到出厂角色，避免 system prompt 空掉 |
| 技能 / MCP / 知识库配置非法 | 按空处理（不静默套出厂内容） |

日志示例：

```
[error] 「技能列表」校验失败（共 2 处），本次不生效：
        $.skills[0].name name 必填
        $.skills[1].content content 必填
[error] 提示：可用配置生成器生成后粘贴：https://error2913.github.io/aiplugin4-config/
```

### 5.5 出厂默认

`src/config/domain/default_data.ts`（由 `scripts/gen-domain-default-data.mjs` 生成）提供四份默认对象，`defaults.ts` 再 `JSON.stringify` 成注册默认值：

- 角色：测试机器人 + 当前默认 prompt；
- 技能：`SEALDICE_COMMAND_SKILLS`（录卡）转换后的对象；
- MCP：**空配置**（不预置服务器，避免没配置时启动/对话报错）；生成器侧保留三台示例（mcp-files-exec / md-html-render[QQ] / mcp-browser）；
- 知识库：`KNOWLEDGE_BASE_DEFAULTS`（核心指令 / 扩展指令 / ob11-api[QQ]）转换后的对象。

要求：**默认 JSON 解析后的运行时结构 = 当前版本的默认运行时结构**。用单测逐项对比：
- 角色名称/prompt 与旧默认字符串一致；
- 技能名称/描述/正文与 `SEALDICE_COMMAND_SKILLS` 解析结果一致；
- MCP 默认 `mcpServers` 为空；生成器示例三台的键名 / platform / url / headers 可被插件解析；
- 知识库三库的 name/description/platform/content 与旧 `KNOWLEDGE_BASE_DEFAULTS` 解析结果一致。

生成器侧的 `js/domains/default-data.js` 由 `tools/sync-default-data.mjs` 从同一批插件源码生成，两边默认值保持一致。

> 字符串转义注意：同步默认值时用 `JSON.stringify` / `JSON.parse`，不要手工拼 JSON。现有默认技能正文里的 `D:\COC\空白卡` 写在 TS 模板字符串中，运行时实际是 `D:COC空白卡`（反斜杠被模板字符串吃掉）；生成器与**当前运行时**保持一致。如果插件希望保留反斜杠，需要把源字符串改成 `D:\\COC\\空白卡`，这属于另一处默认值修正。

### 5.6 测试

- `scripts/unit-test-entry.ts` 增加：
  - 四个 parser 的合法/非法用例（版本、缺字段、重复名、platform、尾逗号）；
  - 默认 JSON → 运行时结构 = 当前默认；
  - 生成器停用的条目不出现在 JSON 里；
  - 角色名截断；
  - 知识库描述兜底。
- `scripts/test-unit.cjs` 的 seal 桩补 `getConfig`（新配置读取不再依赖 template）。
- 新增 `scripts/unit-test-domain.ts`（或并入现有 entry），从 `test-unit.cjs` 的 entries 注册。
- 跨仓库联测：扩展 `scripts/integration-config-generator.mjs`
  - 生成器 build 出的四份 JSON → 插件 parser 接受；
  - 非法样例两边都拒绝；
  - 生成器默认值 → 插件默认值一致（通过 fixture 对比）。
- 面板手工验证：
  - 升级后四个新配置项出现、旧项消失；
  - 粘贴生成器默认 JSON，四个 `.ai` 命令行为与旧版一致；
  - 生成器停用某服务器后，JSON 里没有它，`.ai mcp list` 也不出现。

## 6. 生成器侧对应关系（已完成）

生成器仓库 `aiplugin4-config` 的 `feat/domain-tabs` 分支：

- 四个页签 + 通用交互层：`js/domain-app.js`、`js/domains/*.js`；
- 文件导入：SKILL.md / Markdown / 文本 / 标准 MCP JSON（`mcpServers`）；
- 默认值同步：`tools/sync-default-data.mjs` → `js/domains/default-data.js`；
- 测试：`tests/domains-run.mjs`（101 项）、`tests/domain-e2e-check.html`（42 项）、`tests/web-e2e-check.html`（12 项，联网统一编辑/启用/导入）。

插件侧实现时，两边 schema 字段名、`platform` 缺省语义、默认值必须完全一致；跨仓库联测是唯一防线。

## 7. 实施顺序与 PR 拆分（实际已合并为 `feat/config-json` 一个分支）

1. **PR1** `feat/config-domain-schema`：`src/config/domain/` 纯模块 + 类型 + 默认值 + 单测（不改运行时）。
2. **PR2** `feat/role-json-config`：角色注册/读取/消费点 + 文案 + 测试。
3. **PR3** `feat/skills-json-config`：技能（含补默认技能）。
4. **PR4** `feat/mcp-json-config`：MCP（标准 `mcpServers` 解析）。
5. **PR5** `feat/kb-json-config`：知识库（含签名/refresh）。
6. **PR6** `feat/web-defaults-config`：联网搜索 5 个默认项改为「联网」页配置项，联网 JSON 去掉 `defaults`。
7. **PR7** `test/config-generator-domains`：扩展跨仓库联测 + fixture（含联网输出无 `defaults`）。
8. **PR8** `docs/config-json`：README / docs 03/04/05/09 / changelog / 版本号。

按 AGENT.md 约定：不在 main 上改，分支 → PR → squash merge；中文提交信息走 UTF-8 文件。

## 8. 风险与注意

1. **旧配置不可见但仍在文件里**：不注册旧键后 WebUI 隐藏，值仍保存；插件不读、不转换，生成器也不提供旧格式导入（只有技能文件保留跨 agent 标准的 `SKILL.md` frontmatter 导入）。
2. **降级风险**：新版本写入 JSON 值后，旧版本读同一键会类型不匹配。发版说明要写“不支持降级，升级前备份 `config.json`”。
3. **知识库 ID 变化**：库 ID 目前由内容 hash 生成，格式切换后按会话保存的 `kbState` 会重置一次，属一次性可接受影响。
4. **配置体积**：知识库默认 JSON 约 19KB（紧凑），单框 String 能正常保存；超大知识库需在面板实测粘贴/重载性能。
5. **生成器/插件漂移**：四个新 schema 与默认值仍是两处实现，必须靠 `integration-config-generator.mjs` + 共享 fixture 守住。

## 9. 联网搜索的“默认项”改为插件配置项

现状：生成器「联网搜索」页有「默认项」（返回条数 / detail / 超时 / 正文截断 / fallback），最终写进联网 JSON 的 `defaults` 字段。这些是**插件级设置**，不该混在 provider JSON 里。改动：

### 9.1 插件新增配置项（分组：联网）

| 配置键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `联网搜索返回条数` | int | `10` | 1~50；工具未指定时使用 |
| `联网搜索详细程度` | option | `summary` | 可选 `snippet` / `summary` / `content` |
| `联网搜索超时` | int | `20` | 秒；provider 级 `timeout` 仍可覆盖 |
| `联网搜索正文截断` | int | `5000` | detail=content 时单条正文最大字符数 |
| `联网搜索失败回退` | bool | `true` | 关闭后只试第一个 provider，排障用 |

### 9.2 代码改动

- `src/config/configs/web.ts`
  - 注册上表 5 个配置项（`registerIntConfig` / `registerOptionConfig` / `registerBoolConfig`）。
  - `buildConfig()` 里先解析「联网配置」JSON，再读取这 5 项填进 `WebConfig.defaults`（运行时字段）。
  - 非法值（越界/非数字）回退默认并记 warning；不阻断 provider 解析。
- `src/web/schema.ts`
  - 删除 `readDefaults` 与 `$.defaults` 的 JSON 解析；`parseWebConfig` 不再从 JSON 读 `defaults`。
  - `WebConfig.defaults` 保留为**运行时字段**，由 `WebConfigStore.get()` 用配置项覆盖（避免大面积改 service / tool 的调用签名）。
  - 空配置 / 出厂默认仍用 `defaultWebDefaults()` 占位，随后被配置项覆盖。
- 旧联网 JSON 里的 `defaults` 字段：忽略（可记一条 warning），不再生效；用户按新的「联网」页配置项设置。
- 生成器侧：删除「默认项」UI 与输出里的 `defaults`，只生成 `{version, providers, routes}`（已完成）。

### 9.3 文档与测试

- README「联网」章、`docs/04 工具系统`、`docs/05 命令与配置`、`changelog.ts` 同步说明 5 个新配置项。
- 单测：配置项默认值/越界回退；`defaults` 不再出现在联网 JSON；service/tool 读取 `config.defaults` 仍工作。
- 跨仓库联测：生成器联网输出不再含 `defaults`，插件解析结果一致。

## 10. 已确定

- 新键名（不使用 `（JSON）` 后缀，且不与旧键重名）：`角色设定` / `技能列表` / `MCP服务器` / `知识库配置`。
- 配置描述不内嵌完整 JSON 示例，只给格式摘要与生成器链接。
- 联网默认项配置键名：`联网搜索返回条数` / `联网搜索详细程度` / `联网搜索超时` / `联网搜索正文截断` / `联网搜索失败回退`。
