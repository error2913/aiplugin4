// MCP 配置：总开关 / 标准 mcpServers JSON / 会话回收策略。
//
// 新键名 `MCP服务器`；旧的模板键 `MCP服务器配置` 不再注册/读取（不做迁移）。
// JSON 使用标准结构：{ "mcpServers": { "<服务器名>": { "type": "http", "url": "...", "headers": {...} } } }
import Logger from "../../logger";
import { DEFAULT_MCP_JSON } from "../domain/defaults";
import { parseMcpConfig } from "../domain/parse";
import { McpServerEntry } from "../domain/types";
import { ext } from "../ext";

import { GENERATOR_CONFIG_HINT } from "./generator_hint";

export const MCP_SERVER_CONFIG_KEY = 'MCP服务器';

function readServers(): McpServerEntry[] {
    let text = '';
    try {
        text = seal.ext.getStringConfig(ext, MCP_SERVER_CONFIG_KEY) ?? '';
    } catch (e) {
        Logger.error(`读取配置项「${MCP_SERVER_CONFIG_KEY}」失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!text.trim()) {
        Logger.info(`「${MCP_SERVER_CONFIG_KEY}」为空：未配置 MCP 服务器（需要时用配置生成器生成后粘贴）。`);
        return [];
    }
    const result = parseMcpConfig(text);
    for (const issue of result.issues) Logger.error(`  ${issue.path} ${issue.msg}`);
    for (const warning of result.warnings) Logger.warning(`  ${warning.path} ${warning.msg}`);
    if (!result.config) {
        Logger.error(`「${MCP_SERVER_CONFIG_KEY}」校验失败（共 ${result.issues.length} 处），本次按无服务器处理。`);
        Logger.error('提示：可用配置生成器生成后粘贴：https://error2913.github.io/aiplugin4-config/（「MCP」页）。');
        return [];
    }
    return result.config.servers;
}

export default class McpConfig {
    static register() {
        seal.ext.registerBoolConfig(ext, "是否启用MCP", false, "MCP 功能总开关；默认关闭，避免未安装 MCP 后端时启动或对话报错。开启后才会连接/注册 MCP 工具；修改后需重载 JS 生效", "MCP");
        seal.ext.registerStringConfig(
            ext,
            MCP_SERVER_CONFIG_KEY,
            DEFAULT_MCP_JSON,
            GENERATOR_CONFIG_HINT,
            'MCP',
        );
        seal.ext.registerIntConfig(ext, "MCP会话空闲回收分钟", 10, "MCP 会话（含浏览器操作）空闲超过该分钟数后自动回收，释放服务端浏览器状态；设为 0 表示不回收", "MCP");
        seal.ext.registerIntConfig(ext, "MCP每服务器最大会话数", 3, "每个 MCP 服务器最多同时保留的 AI 会话数，超出后按最近使用时间回收最旧会话（浏览器操作按 AI 会话隔离）", "MCP");
    }

    static get() {
        return {
            MCP_ENABLED: seal.ext.getBoolConfig(ext, "是否启用MCP"),
            MCP_SERVERS: readServers(),
            MCP_SESSION_IDLE_MINUTES: seal.ext.getIntConfig(ext, "MCP会话空闲回收分钟"),
            MCP_MAX_SESSIONS_PER_SERVER: seal.ext.getIntConfig(ext, "MCP每服务器最大会话数"),
        };
    }
}

