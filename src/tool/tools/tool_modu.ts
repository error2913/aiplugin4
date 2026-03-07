import { Tool, ToolManager } from "./tool";

export function registerModu() {
    const toolRoll = new Tool({
        type: "function",
        function: {
            name: "modu_roll",
            description: `抽取随机COC模组`,
            parameters: {
                type: "object",
                properties: {},
                required: []
            }
        }
    });
    toolRoll.ExtCmdInfo = {
        extName: 'story',
        cmd: 'modu',
        staticArgs: ['roll']
    }
    toolRoll.solve = async (ctx, msg, ai, _) => {
        const [s, success] = await ToolManager.extensionSolve(ctx, msg, ai, toolRoll.ExtCmdInfo, [], [], []);
        if (!success) {
            return { content: '今日人品查询失败', images: [] };
        }

        return { content: s, images: [] };
    }

    const toolSearch = new Tool({
        type: "function",
        function: {
            name: "modu_search",
            description: `搜索COC模组`,
            parameters: {
                type: "object",
                properties: {
                    name: {
                        type: 'string',
                        description: "要搜索的关键词"
                    }
                },
                required: ['name']
            }
        }
    });
    toolSearch.ExtCmdInfo = {
        extName: 'story',
        cmd: 'modu',
        staticArgs: ['search']
    }
    toolSearch.solve = async (ctx, msg, ai, args) => {
        const { name } = args;

        const [s, success] = await ToolManager.extensionSolve(ctx, msg, ai, toolSearch.ExtCmdInfo, [name], [], []);
        if (!success) {
            return { content: '今日人品查询失败', images: [] };
        }

        return { content: s, images: [] };
    }
}