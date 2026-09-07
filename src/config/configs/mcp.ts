// MCP 配置：MCP 总开关 / 服务器配置 / 会话回收策略
import { ext } from "../config";

export default class McpConfig {
    static register() {

        seal.ext.registerBoolConfig(ext, "是否启用MCP", false, "MCP 功能总开关；默认关闭，避免未安装 MCP 后端时启动或对话报错。开启后才会解析下方「MCP服务器配置」并连接/注册 MCP 工具；修改后需重载 JS 生效", "MCP");
        seal.ext.registerTemplateConfig(ext, "MCP服务器配置", [
            `---
name: mcp-files-exec
---
{
  "type": "http",
  "url": "http://127.0.0.1:3910/mcp",
  "headers": {
    "Authorization": "Bearer token"
  }
}`,
            `---
name: md-html-render
---
{
  "type": "http",
  "url": "http://127.0.0.1:37632/mcp"
}`,
            `---
name: mcp-browser
---
{
  "type": "http",
  "url": "http://127.0.0.1:8921/mcp"
}`
        ], "每个数组元素一台 MCP 服务器：以 --- 开头的 frontmatter 里写 name（必填，服务器名）/ platform（可选平台白名单数组，如 [QQ, DISCORD]，缺省=所有平台），正文为单个服务器的 JSON（type/http 即 Streamable HTTP、url、headers、token，与旧 mcpServers.<name> 的值一致；不再支持整块 mcpServers 格式）。工具名称、描述和参数 schema 会在连接后通过 MCP tools/list 自动发现，不需要也不支持额外的 tools 配置块。默认包含三个服务器：mcp-files-exec（提供 read_file、list_dir、write_file、delete_file、download_file、run_shell、export_file；相对路径与命令默认工作目录按 AI 会话隔离，绝对路径仍可直接传后端任意路径）、md-html-render（提供 render_markdown、render_html）、mcp-browser（提供 browser_navigate、browser_click、browser_type、browser_snapshot、browser_take_screenshot、browser_wait_for、browser_close 等浏览器操作，按 AI 会话隔离）。格式定义见 https://modelcontextprotocol.io/specification/latest （MCP 官方规范）。stdio（command）服务器需拉起子进程，海豹环境不支持会自动跳过。修改配置后用 .ai mcp refresh 立即生效（或重载 JS）", "MCP");
        seal.ext.registerIntConfig(ext, "MCP会话空闲回收分钟", 10, "MCP 会话（含浏览器操作）空闲超过该分钟数后自动回收，释放服务端浏览器状态；设为 0 表示不回收", "MCP");
        seal.ext.registerIntConfig(ext, "MCP每服务器最大会话数", 3, "每个 MCP 服务器最多同时保留的 AI 会话数，超出后按最近使用时间回收最旧会话（浏览器操作按 AI 会话隔离）", "MCP");
    }

    static get() {
        return {
            MCP_ENABLED: seal.ext.getBoolConfig(ext, "是否启用MCP"),
            MCP_SERVER_CONFIG: seal.ext.getTemplateConfig(ext, "MCP服务器配置"),
            MCP_SESSION_IDLE_MINUTES: seal.ext.getIntConfig(ext, "MCP会话空闲回收分钟"),
            MCP_MAX_SESSIONS_PER_SERVER: seal.ext.getIntConfig(ext, "MCP每服务器最大会话数"),
        };
    }
}
