// 触发条件工具：AI 自行设定的触发条件
import Tool from "../../tool";

export const triggerConditionMap: { [key: string]: { keyword: string, uid: string, reason: string }[] } = {};

export function registerSetTrigger() {
    const tool = new Tool({
        type: "function",
        function: {
            name: "set_trigger_condition",
            description: `Set a trigger condition; when it matches, a conversation turn starts automatically`,
            parameters: {
                type: "object",
                properties: {
                    keyword: {
                        type: 'string',
                        description: 'Trigger keyword; regex is supported; empty means any message triggers'
                    },
                    user_id: {
                        type: 'string',
                        description: 'User ID that must match for the trigger; empty means any user'
                    },
                    reason: {
                        type: 'string',
                        description: 'Trigger reason'
                    }
                },
                required: ["reason"]
            }
        }
    });
    tool.solve = async (ctx, _, session, args) => {
        const { keyword = '', user_id = '', reason } = args;

        const condition = {
            keyword: '',
            uid: '',
            reason: reason
        }

        if (keyword) {
            try {
                new RegExp(keyword);
                condition.keyword = keyword;
            } catch (_e) {
                return `触发关键词格式错误`;
            }
        }

        if (user_id) {
            const ui = await session.context.getUserById(user_id);
            if (ui === null) return `未找到用户ID<${user_id}>`;
            if (ui.userId === ctx.endPoint.userId) return `禁止将自己设置为触发条件`;
            condition.uid = ui.userId;
        }

        if (!Object.prototype.hasOwnProperty.call(triggerConditionMap, session.sessionId)) triggerConditionMap[session.sessionId] = [];
        triggerConditionMap[session.sessionId].push(condition);

        return "触发条件设置成功";
    }
}
