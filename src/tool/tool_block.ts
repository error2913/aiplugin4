import { Tool } from "./tool";
import { BlockManager } from "../block";
import { ConfigManager } from "../config/configManager";

export function registerBlockTool() {
    const toolBlock = new Tool({
        type: 'function',
        function: {
            name: 'block_user',
            description: '拉黑指定用户，使其无法触发AI',
            parameters: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        description: '用户名称' + (ConfigManager.message.showNumber ? '或纯数字QQ号' : '')
                    },
                    reason: {
                        type: 'string',
                        description: '拉黑原因'
                    }
                },
                required: ['name', 'reason']
            }
        }
    });
    toolBlock.solve = async (ctx, _, ai, args) => {
        const { name, reason } = args;

        const ui = await ai.context.findUserInfo(ctx, name);
        if (ui === null) return { content: `未找到<${name}>`, images: [] };

        if (BlockManager.checkBlock(ui.id)) {
            return { content: `用户<${name}>已经在黑名单中`, images: [] };
        }

        BlockManager.addBlock(ui.id, reason);
        ctx.notice(`AI已将用户<${name}>(${ui.id})加入黑名单，原因: ${reason}`);
        return { content: `已将<${name}>加入黑名单，原因: ${reason}`, images: [] };
    }

//     不确定是否给ai
//     const toolUnblock = new Tool({
//         type: 'function',
//         function: {
//             name: 'unblock_user',
//             description: '移除黑名单中的用户',
//             parameters: {
//                 type: 'object',
//                 properties: {
//                     name: {
//                         type: 'string',
//                         description: '用户名称' + (ConfigManager.message.showNumber ? '或纯数字QQ号' : '')
//                     }
//                 },
//                 required: ['name']
//             }
//         }
//     });
//     toolUnblock.solve = async (ctx, _, ai, args) => {
//         const { name } = args;

//         const ui = await ai.context.findUserInfo(ctx, name);
//         if (ui === null) return { content: `未找到<${name}>`, images: [] };

//         if (BlockManager.removeBlock(ui.id)) {
//             return { content: `已将<${name}>移出黑名单`, images: [] };
//         } else {
//             return { content: `用户<${name}>不在黑名单中`, images: [] };
//         }
//     }

//     const toolList = new Tool({
//         type: 'function',
//         function: {
//             name: 'get_block_list',
//             description: '获取AI黑名单列表',
//             parameters: {
//                 type: 'object',
//                 properties: {},
//                 required: []
//             }
//         }
//     });
//     toolList.solve = async (_, __, ___, ____) => {
//         const list = BlockManager.getListText();
//         return { content: list, images: [] };
//     }
}
