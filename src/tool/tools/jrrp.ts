import { Tool } from "../tool";

const tool = new Tool({
    type: "function",
    function: {
        name: "jrrp",
        description: `查看指定用户的今日人品`,
        parameters: {
            type: "object",
            properties: {
                name: {
                    type: 'string',
                    description: '用户名称或纯数字QQ号'
                }
            },
            required: ["name"]
        }
    }
});
tool.ExtCmdInfo = {
    extName: 'fun',
    cmd: 'jrrp',
    staticArgs: []
}
tool.solve = async (ctx, msg, agent, args) => {
    const { name } = args;

    const ui = await ai.context.findUserInfo(ctx, name);
    if (ui === null) return { content: `未找到<${name}>`, images: [] };

    ({ ctx, msg } = getCtxAndMsg(ctx.endPoint.userId, ui.id, ctx.group.groupId));
    const [s, success] = await ToolManager.extensionSolve(ctx, msg, ai, tool.ExtCmdInfo, [], [], []);
    if (!success) return { content: '今日人品查询失败', images: [] };

    return { content: s, images: [] };
}

export { tool as toolJrrp }