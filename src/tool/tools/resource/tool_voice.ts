// 音频资源工具：生成音频资源，不直接发送消息。
import Config from "../../../config/config";
import { logger } from "../../../logger";
import { resolveResourceReference } from "../../../utils/resource";
import Tool from "../../tool";

export function registerAudioTools() {
    const tool = new Tool({
        type: "function",
        function: {
            name: "generate_audio",
            description: "生成或解析语音资源，返回可交给 call_ob11_api 的 record 消息段；不会自动发送。自定义音色需要 tts 生成音频依赖。",
            parameters: {
                type: "object",
                properties: {
                    text: { type: "string", description: "要合成的文本" },
                    path: { type: "string", description: "已有本地语音路径、file:// URI 或 mcp:// 资源" },
                    source: { type: "string", enum: ["local", "mcp"], description: "资源来源" },
                    server: { type: "string", description: "MCP 文件服务器名称" }
                },
                required: []
            }
        }
    });
    tool.solve = async (_ctx, _msg, _session, args) => {
        const text = args && typeof args.text === "string" ? args.text : "";
        const path = args && typeof args.path === "string" ? args.path : "";
        if (!text && !path) return "必须提供 text 或 path";
        if (text && path) return "text 与 path 不能同时提供";

        try {
            if (path) {
                const sessionKey = _session && _session.sessionId ? _session.sessionId : '';
                const resource = await resolveResourceReference(path, args.source, args.server, sessionKey);
                return JSON.stringify({ kind: "resource", type: "record", name: resource.name, segment: { type: "record", data: { file: resource.path } } });
            }
            if (!globalThis.tts) {
                return JSON.stringify({ ok: false, code: "TTS_DEPENDENCY_REQUIRED", message: "文字转语音需要安装 tts 生成音频依赖" });
            }
            const result = await globalThis.tts.generate({ text, model: String(Config.tool.TTS_CHARACTER || "") });
            if (!result.success) return JSON.stringify({ ok: false, code: "TTS_ERROR", message: result.error || "生成音频失败" });
            const file = /^https?:\/\//i.test(result.data) ? result.data : seal.base64ToImage(result.data);
            return JSON.stringify({ kind: "resource", type: "record", segment: { type: "record", data: { file } } });
        } catch (error) {
            logger.error(`生成音频失败：${error instanceof Error ? error.message : String(error)}`);
            return JSON.stringify({ ok: false, code: "AUDIO_GENERATION_ERROR", message: error instanceof Error ? error.message : String(error) });
        }
    };
}
