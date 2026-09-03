import Config from "../../../config/config";
import { callOb11ApiForContext, formatOb11Result } from "../../../transport/ob11/dispatcher";
import Tool from "../../tool";

export function registerCallOb11Api() {
    const tool = new Tool({
        type: "function",
        function: {
            name: "call_ob11_api",
            description: "调用 OneBot 11 API 或已支持的 NapCat/Milky API。运行时会自动选择 ob11-net 后端或 SealDice 原生后端；不要调用旧的按功能拆分工具。\n" +
                "回复当前会话请直接输出文本（会自动发送给用户），不要在 call_ob11_api 中发送；本工具仅用于向其他会话主动外发消息、或发送语音/视频/文件等文本标签表达不了的特殊消息段。禁止在回复中伪造已发送动作。\n" +
                "\n" +
                "发送消息格式：\n" +
                "- 主动向指定私聊/群聊外发消息使用 send_private_msg / send_group_msg，params.message 传文本或消息段数组。\n" +
                "- 图片/语音/视频/文件分别使用 image/record/video/file 消息段。\n" +
                "- 当前会话直接回复图片优先使用 [img:图片ID]，不要在 call_ob11_api 中发送。\n" +
                "- 需要 call_ob11_api 发送本地资源时，将 file 写成 resource:资源ID。\n" +
                "- 上传文件使用 upload_group_file / upload_private_file，不要把上传动作伪装成普通 file 消息段。\n" +
                "- 资源路径支持本地绝对路径、file:// URI、HTTP(S) URL、base64://、mcp://服务器名/沙箱相对路径。",
            parameters: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        description: "API action，例如 send_group_msg、get_group_member_list、set_group_ban"
                    },
                    params: {
                        type: "object",
                        description: "该 API 的原始参数对象",
                        additionalProperties: true
                    },
                    reason: {
                        type: "string",
                        description: "发送消息、群管理、撤回等敏感操作的原因"
                    }
                },
                required: ["action", "params"]
            }
        }
    });
    tool.sensitive = true;
    tool.solve = async (ctx, msg, session, args) => {
        const action = args && typeof args.action === "string" ? args.action.trim() : "";
        const params = args && args.params && typeof args.params === "object" && !Array.isArray(args.params) ? args.params : null;
        if (!action) return JSON.stringify({ ok: false, backend: "seal-native", action: "", error: { code: "INVALID_PARAMS", message: "action 不能为空" } });
        if (!params) return JSON.stringify({ ok: false, backend: "seal-native", action, error: { code: "INVALID_PARAMS", message: "params 必须是对象" } });

        const blockedActions = (Config.tool.OB11_BLOCKED_ACTIONS || []).filter(Boolean);
        if (blockedActions.includes(action)) {
            return JSON.stringify({ ok: false, backend: "seal-native", action, error: { code: "ACTION_BLOCKED", message: `OB11 action 已被配置禁止：${action}` } });
        }
        const defaultClosedActions = (Config.tool.OB11_DEFAULT_CLOSED_ACTIONS || []).filter(Boolean);
        if (defaultClosedActions.includes(action)) {
            return JSON.stringify({ ok: false, backend: "seal-native", action, error: { code: "ACTION_DISABLED", message: `OB11 action 默认关闭：${action}` } });
        }

        const result = await callOb11ApiForContext(ctx, msg, action, params, session);
        return formatOb11Result(result);
    };
}
