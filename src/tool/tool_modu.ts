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
    toolRoll.cmdInfo = {
        ext: 'story',
        name: 'modu',
        fixedArgs: ['roll']
    }
    toolRoll.solve = async (ctx, msg, ai, _) => {
        const [s, success] = await ToolManager.extensionSolve(ctx, msg, ai, toolRoll.cmdInfo, [], [], []);
        if (!success) {
            return '今日人品查询失败';
        }

        return s;
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
    toolSearch.cmdInfo = {
        ext: 'story',
        name: 'modu',
        fixedArgs: ['search']
    }
    toolSearch.solve = async (ctx, msg, ai, args) => {
        const { name } = args;

        const [s, success] = await ToolManager.extensionSolve(ctx, msg, ai, toolSearch.cmdInfo, [name], [], []);
        if (!success) {
            return '今日人品查询失败';
        }

        return s;
    }
}