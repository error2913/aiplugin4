import { ConfigManager } from "../config/config";
import { Tool } from "./tool";

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
                        description: '指定触发必须满足的用户名称' + (ConfigManager.message.showNumber ? '或纯数字QQ号' : '') + '，为空时任意用户均可触发'
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
    tool.solve = async (ctx, _, ai, args) => {
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
            } catch (e) {
                return `触发关键词格式错误`;
            }
        }

        if (name) {
            const uid = await ai.context.findUserId(ctx, name, true);
            if (uid === null) {
                return `未找到<${name}>`;
            }
            if (uid === ctx.endPoint.userId) {
                return `禁止将自己设置为触发条件`;
            }

            condition.uid = uid;
        }

        if (!triggerConditionMap.hasOwnProperty(ai.id)) {
            triggerConditionMap[ai.id] = [];
        }
        triggerConditionMap[ai.id].push(condition);

        return "触发条件设置成功";
    }
}