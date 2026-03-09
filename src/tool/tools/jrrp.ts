import { getCtxAndMsg } from "../../utils/seal";
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
tool.solve = async (ctx, msg, session, args) => {
    const { name } = args;

    const uid = await session.findUserId(ctx, name);
    if (uid === '') return `未找到<${name}>`;

    ({ ctx, msg } = getCtxAndMsg(ctx.endPoint.userId, uid, ctx.group.groupId));
    const [s, success] = await Tool.extensionSolve(ctx, msg, session.tool.listen, tool.ExtCmdInfo, [], [], []);
    if (!success) return '今日人品查询失败';

    return s;
}

export { tool as toolJrrp }