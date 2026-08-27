// MCP 配置：MCP 总开关 / 服务器配置 / 会话回收策略
import { ext } from "../config";

export default class McpConfig {
    static register() {

        seal.ext.registerBoolConfig(ext, "是否启用MCP", false, "MCP 功能总开关；默认关闭，避免未安装 MCP 后端时启动或对话报错。开启后才会解析下方「MCP服务器配置」并连接/注册 MCP 工具", "MCP");
        seal.ext.registerTemplateConfig(ext, "MCP服务器配置", [
            `{
    "mcpServers": {
      "mcp-files-exec": {
        "type": "http",
        "url": "http://127.0.0.1:3910/mcp",
        "headers": {
          "Authorization": "Bearer token"
        }
      },
      "md-html-render": {
        "type": "http",
        "url": "http://127.0.0.1:37632/mcp"
      },
      "mcp-browser": {
        "type": "http",
        "url": "http://127.0.0.1:8921/mcp"
      }
    }
  }`
        ], "仅支持标准 mcpServers JSON 格式：{\"mcpServers\":{\"服务器名\":{\"type\":\"http\",\"url\":\"...\",\"headers\":{...}}}}（Claude Desktop/Cursor/.mcp.json 可直接粘贴），一个块可包含多个服务器。工具名称、描述和参数 schema 会在连接后通过 MCP tools/list 自动发现，不需要也不支持额外的 tools 配置块。字段：type（仅支持 http，即 Streamable HTTP）、url（服务器地址）、headers（任意自定义请求头，如 Authorization）、token（自动生成 Bearer 头，与 headers 二选一）。默认包含三个：mcp-files-exec（提供 read_file、list_dir、write_file、delete_file、download_file、run_shell、export_file；默认可直接传后端绝对路径）、md-html-render（提供 render_markdown、render_html）、mcp-browser（提供 browser_navigate、browser_click、browser_type、browser_snapshot、browser_take_screenshot、browser_wait_for、browser_close 等浏览器操作，按 AI 会话隔离，截图时机由 AI 自主选择）。格式定义见 https://modelcontextprotocol.io/specification/latest （MCP 官方规范，国内可访问）。说明：stdio（command）服务器需拉起子进程，海豹环境不支持会自动跳过，请改用 Streamable HTTP（type=http + url）。修改后自动生效（缓存最多 1 分钟）", "MCP");
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
