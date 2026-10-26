import Config from "../../../config/config";
import { callOb11ApiForContext, formatOb11Result } from "../../../transport/ob11/dispatcher";
import Tool from "../../tool";

export function registerCallOb11Api() {
    const tool = new Tool({
        type: "function",
        function: {
            name: "call_ob11_api",
            description: "Call OneBot 11 APIs or supported NapCat/Milky APIs. The runtime automatically selects the ob11-net backend or the SealDice native backend; do not call the old feature-split tools.\n" +
                "To reply to the current conversation, output text directly (it is sent to the user automatically); do not send it through call_ob11_api. This tool is only for actively sending messages to other conversations, or for special message segments that text tags cannot express, such as voice/video/file. Never fake a sent action in your reply.\n" +
                "\n" +
                "Message sending format:\n" +
                "- To actively send to a specific private chat/group, use send_private_msg / send_group_msg and pass text or a message segment array in params.message.\n" +
                "- Use image/record/video/file message segments for images/voice/video/files.\n" +
                "- To reply with an image in the current conversation, prefer [img:image ID]; do not send it through call_ob11_api.\n" +
                "- To send a local resource through call_ob11_api, write file as resource:resource ID.\n" +
                "- To upload files, use upload_group_file / upload_private_file; do not disguise an upload as a regular file message segment.\n" +
                "- Resource paths support local absolute paths, file:// URIs, HTTP(S) URLs, base64://, and mcp://server-name/sandbox-relative-path.",
            parameters: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        description: "API action, e.g. send_group_msg, get_group_member_list, set_group_ban"
                    },
                    params: {
                        type: "object",
                        description: "Raw parameter object for this API",
                        additionalProperties: true
                    },
                    reason: {
                        type: "string",
                        description: "Reason for sensitive operations such as sending messages, group management, recall"
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
