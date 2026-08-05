// 模组工具：COC 模组抽取/搜索
import Tool from "../../tool";

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
    toolRoll.solve = async (ctx, msg, session, _) => {
        const [s, success] = await Tool.extensionSolve(ctx, msg, session.tool.listen, toolRoll.ExtCmdInfo, [], [], []);
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
    toolSearch.ExtCmdInfo = {
        extName: 'story',
        cmd: 'modu',
        staticArgs: ['search']
    }
    toolSearch.solve = async (ctx, msg, session, args) => {
        const { name } = args;

        const [s, success] = await Tool.extensionSolve(ctx, msg, session.tool.listen, toolSearch.ExtCmdInfo, [name], [], []);
        if (!success) {
            return '今日人品查询失败';
        }

        return s;
    }
}
