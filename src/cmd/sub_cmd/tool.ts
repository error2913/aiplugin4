import { AIManager } from "../../AI/AI";
import { ConfigManager } from "../../config/configManager";
import { logger } from "../../logger";
import { ToolManager } from "../../tool/tool";
import { aliasToCmd } from "../../utils/utils";
import { I, M, U } from "../privilege";
import { SubCmd, SubCmdContext } from "../root";

export function registerCmdTool() {
    const cmd = new SubCmd('tool');
    cmd.desc = '工具相关操作';
    cmd.help = '';
    cmd.priv = {
        priv: U, args: {
            on: { priv: I },
            off: { priv: I },
            help: { priv: U },
            call: { priv: M },
            "*": { priv: U }
        }
    };
    cmd.solve = async (scc: SubCmdContext) => {
        const { ctx, msg, cmdArgs, sid, ai, ret } = scc;

        const val2 = cmdArgs.getArgN(2);
        switch (aliasToCmd(val2)) {
            case 'on': {
                const val3 = cmdArgs.getArgN(3);
                if (val3) {
                    const toolsNotAllow = ConfigManager.tool.toolsNotAllow;
                    if (toolsNotAllow.includes(val3)) {
                        seal.replyToSender(ctx, msg, `工具函数 ${val3} 不被允许开启`);
                        return ret;
                    }

                    ai.tool.toolStatus[val3] = true;
                    seal.replyToSender(ctx, msg, `已开启工具函数 ${val3}`);
                    AIManager.saveAI(sid);
                    return ret;
                }
                const toolsNotAllow = ConfigManager.tool.toolsNotAllow;
                for (const key in ai.tool.toolStatus) {
                    ai.tool.toolStatus[key] = toolsNotAllow.includes(key) ? false : true;
                }
                seal.replyToSender(ctx, msg, '已开启全部工具函数');
                AIManager.saveAI(sid);
                return ret;
            }
            case 'off': {
                const val3 = cmdArgs.getArgN(3);
                if (val3) {
                    ai.tool.toolStatus[val3] = false;
                    seal.replyToSender(ctx, msg, `已关闭工具函数 ${val3}`);
                    AIManager.saveAI(sid);
                    return ret;
                }
                for (const key in ai.tool.toolStatus) {
                    ai.tool.toolStatus[key] = false;
                }
                seal.replyToSender(ctx, msg, '已关闭全部工具函数');
                AIManager.saveAI(sid);
                return ret;
            }
            case 'help': {
                const val3 = cmdArgs.getArgN(3);
                if (!val3) {
                    seal.replyToSender(ctx, msg, `帮助:
      【.ai tool】列出所有工具
      【.ai tool [on/off] <函数名>】开启或关闭工具函数
      【.ai tool help <函数名>】查看工具详情
      【.ai tool call <函数名> --参数名=具体参数】试用工具函数`);
                    return ret;
                }

                if (!ToolManager.toolMap.hasOwnProperty(val3)) {
                    seal.replyToSender(ctx, msg, '没有这个工具函数');
                    return ret;
                }

                const tool = ToolManager.toolMap[val3];
                const s = `${tool.info.function.name}
      描述:${tool.info.function.description}
      
      参数信息:
      ${JSON.stringify(tool.info.function.parameters.properties, null, 2)}
      
      必需参数:${tool.info.function.parameters.required.join(',')}`;

                seal.replyToSender(ctx, msg, s);
                return ret;
            }
            case 'call': {
                const val3 = cmdArgs.getArgN(3);
                if (!val3) {
                    seal.replyToSender(ctx, msg, `调用函数缺少工具函数名`);
                    return ret;
                }
                if (!ToolManager.toolMap.hasOwnProperty(val3)) {
                    seal.replyToSender(ctx, msg, `调用函数失败:未注册的函数:${val3}`);
                    return ret;
                }
                const tool = ToolManager.toolMap[val3];
                if (tool.cmdInfo.ext !== '' && ToolManager.cmdArgs == null) {
                    seal.replyToSender(ctx, msg, `暂时无法调用函数，请先使用 .r 指令`);
                    return ret;
                }

                try {
                    const args = cmdArgs.kwargs.reduce((acc, kwarg) => {
                        const valueString = kwarg.value;
                        try {
                            acc[kwarg.name] = JSON.parse(`[${valueString}]`)[0];
                        } catch (e) {
                            acc[kwarg.name] = valueString;
                        }
                        return acc;
                    }, {});

                    for (const key of tool.info.function.parameters.required) {
                        if (!args.hasOwnProperty(key)) {
                            logger.warning(`调用函数失败:缺少必需参数 ${key}`);
                            seal.replyToSender(ctx, msg, `调用函数失败:缺少必需参数 ${key}`);
                            return ret;
                        }
                    }

                    const { content, images } = await tool.solve(ctx, msg, ai, args);
                    seal.replyToSender(ctx, msg, `返回内容:
      ${content}
      返回图片:
      ${images.map(img => img.CQCode).join('\n')}`);
                    return ret;
                } catch (e) {
                    const s = `调用函数 (${val3}) 失败:${e.message}`;
                    seal.replyToSender(ctx, msg, s);
                    return ret;
                }
            }
            default: {
                const toolStatus = ai.tool.toolStatus;

                let i = 1;
                let s = '工具函数如下:';
                Object.keys(toolStatus).forEach(key => {
                    const status = toolStatus[key] ? '开' : '关';
                    s += `\n${i++}. ${key}[${status}]`;
                });

                seal.replyToSender(ctx, msg, s);
                return ret;
            }
        }
    }
}