import { Tool, ToolInfo, ToolManager } from "./tool";

export function registerModuRoll() {
    const info: ToolInfo = {
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
    }

    const tool = new Tool(info);
    tool.cmdInfo = {
        ext: 'story',
        name: 'modu',
        fixedArgs: ['roll']
    }
    tool.solve = async (ctx, msg, ai, _) => {
        const [s, success] = await ToolManager.extensionSolve(ctx, msg, ai, tool.cmdInfo, [], [], []);
        if (!success) {
            return '今日人品查询失败';
        }

        return s;
    }

    ToolManager.toolMap[info.function.name] = tool;
}

export function registerModuSearch() {
    const info: ToolInfo = {
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
    }

    const tool = new Tool(info);
    tool.cmdInfo = {
        ext: 'story',
        name: 'modu',
        fixedArgs: ['search']
    }
    tool.solve = async (ctx, msg, ai, args) => {
        const { name } = args;

        const [s, success] = await ToolManager.extensionSolve(ctx, msg, ai, tool.cmdInfo, [name], [], []);
        if (!success) {
            return '今日人品查询失败';
        }

        return s;
    }

    ToolManager.toolMap[info.function.name] = tool;
}