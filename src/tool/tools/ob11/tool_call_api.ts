import Config from "../../../config/config";
import { callOb11ApiForContext, formatOb11Result } from "../../../transport/ob11/dispatcher";
import Tool from "../../tool";

export function registerCallOb11Api() {
    const tool = new Tool({
        type: "function",
        function: {
            name: "call_ob11_api",
            description: "调用 OneBot 11 API 或已支持的 NapCat/Milky API。运行时会自动选择 ob11-net 后端或 SealDice 原生后端；不要调用旧的按功能拆分工具。",
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
    tool.solve = async (ctx, msg, _session, args) => {
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

        const result = await callOb11ApiForContext(ctx, msg, action, params);
        return formatOb11Result(result);
    };
}
