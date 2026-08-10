// 触发条件工具：AI 自行设定的触发条件
import Tool from "../../tool";

export const triggerConditionMap: { [key: string]: { keyword: string, uid: string, reason: string }[] } = {};

export function registerSetTrigger() {
    const tool = new Tool({
        type: "function",
        function: {
            name: "set_trigger_condition",
            description: `设置一个触发条件，当触发条件满足时，会自动进行一次对话`,
            parameters: {
                type: "object",
                properties: {
                    keyword: {
                        type: 'string',
                        description: '触发关键词，可使用正则表达式，为空时任意消息都可触发'
                    },
                    name: {
                        type: 'string',
                        description: '指定触发必须满足的用户名称或纯数字QQ号，为空时任意用户均可触发'
                    },
                    reason: {
                        type: 'string',
                        description: '触发原因'
                    }
                },
                required: ["reason"]
            }
        }
    });
    tool.solve = async (ctx, _, session, args) => {
        const { keyword = '', name = '', reason } = args;

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

        if (name) {
            const ui = await session.context.findUser(ctx, name, true);
            if (ui === null) return `未找到<${name}>`;
            if (ui.userId === ctx.endPoint.userId) return `禁止将自己设置为触发条件`;
            condition.uid = ui.userId;
        }

        if (!Object.prototype.hasOwnProperty.call(triggerConditionMap, session.sessionId)) triggerConditionMap[session.sessionId] = [];
        triggerConditionMap[session.sessionId].push(condition);

        return "触发条件设置成功";
    }
}
