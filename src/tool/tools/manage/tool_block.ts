// 黑名单相关工具：suggest_block（AI 只建议拉黑，由骰主用指令确认）+ unblock_user / get_block_list
import { BlockManager } from "../../../block";
import Config from "../../../config/config";
import Tool from "../../tool";

const SUGGEST_COOLDOWN_MS = 5 * 60 * 1000; // 同一目标 5 分钟内不重复建议，防吵吵（内存态，不落库）
const suggestCooldown: { [id: string]: number } = {};

export function registerBlockTool() {
    // AI 建议拉黑：不直接写入黑名单，通知骰主用 .ai block add 确认
    const toolSuggestBlock = new Tool({
        type: 'function',
        function: {
            name: 'suggest_block',
            description: '建议骰主拉黑指定用户，使其无法触发AI（仅建议，不会直接拉黑，需骰主通过指令确认）',
            parameters: {
                type: 'object',
                properties: {
                    user_id: {
                        type: 'string',
                        description: '用户ID'
                    },
                    reason: {
                        type: 'string',
                        description: '建议拉黑原因'
                    }
                },
                required: ['user_id', 'reason']
            }
        }
    });
    toolSuggestBlock.solve = async (ctx, _msg, session, args) => {
        const { user_id, reason } = args;

        const ui = await session.context.getUserById(user_id);
        if (!ui) return `未找到用户ID<${user_id}>`;

        if (BlockManager.checkBlock(ui.userId)) {
            return `用户ID<${user_id}>已经在黑名单中`;
        }

        const last = suggestCooldown[ui.userId];
        if (last && Date.now() - last < SUGGEST_COOLDOWN_MS) {
            const remain = Math.ceil((SUGGEST_COOLDOWN_MS - (Date.now() - last)) / 1000);
            return `已建议过拉黑用户ID<${user_id}>，冷却中（剩余约 ${remain} 秒），等待骰主处理`;
        }

        suggestCooldown[ui.userId] = Date.now();
        if (Config.tool.BLOCK_REQUIRE_OWNER_CONFIRM) {
            ctx.notice(`AI 建议拉黑用户ID<${ui.userId}>，原因: ${reason}。骰主可执行 .ai block add ${ui.userId} <原因> 确认拉黑`);
            return `已向骰主建议拉黑用户ID<${ui.userId}>，原因: ${reason}，等待骰主确认`;
        }
        BlockManager.addBlock(ui.userId, `${reason}（AI 自动拉黑，已关闭骰主确认）`);
        return `已直接拉黑用户ID<${ui.userId}>（原因: ${reason}），其消息将不再触发 AI`;
    }

    // 移除黑名单（骰主指令之外的补充入口）
    const toolUnblock = new Tool({
        type: 'function',
        function: {
            name: 'unblock_user',
            description: '移除黑名单中的用户，使其恢复触发AI',
            parameters: {
                type: 'object',
                properties: {
                    user_id: {
                        type: 'string',
                        description: '用户ID'
                    }
                },
                required: ['user_id']
            }
        }
    });
    toolUnblock.solve = async (_ctx, _msg, session, args) => {
        const { user_id } = args;

        const ui = await session.context.getUserById(user_id);
        if (!ui) return `未找到用户ID<${user_id}>`;

        if (BlockManager.removeBlock(ui.userId)) {
            return `已将用户ID<${user_id}>移出黑名单`;
        }
        return `用户ID<${user_id}>不在黑名单中`;
    }

    // 查看黑名单列表
    const toolList = new Tool({
        type: 'function',
        function: {
            name: 'get_block_list',
            description: '获取AI黑名单列表',
            parameters: {
                type: 'object',
                properties: {},
                required: []
            }
        }
    });
    toolList.solve = async () => {
        return BlockManager.getListText();
    }
}
