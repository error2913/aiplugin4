// .ai tool：查看/开关/调用工具函数
import Config from "../../config/config";
import { logger } from "../../logger";
import { toolMap } from "../../tool/tool";
import Tool from "../../tool/tool";
import { aliasToCmd } from "../../utils/utils";
import { I, M, U } from "../privilege";
import { SubCmd, SubCmdContext } from "../root_cmd";

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
        const { ctx, msg, cmdArgs, session, ret  } = scc;

        const val2 = cmdArgs.getArgN(2);
        switch (aliasToCmd(val2)) {
            case 'on': {
                const val3 = cmdArgs.getArgN(3);
                if (val3) {
                    const blockedTools = Config.tool.BLOCKED;
                    if (blockedTools.includes(val3)) {
                        seal.replyToSender(ctx, msg, `工具函数 ${val3} 不被允许开启`);
                        return ret;
                    }

                    session.tool.state[val3] = true;
                    seal.replyToSender(ctx, msg, `已开启工具函数 ${val3}`);
                    session.save();
                    return ret;
                }
                const blockedTools = Config.tool.BLOCKED;
                for (const key in session.toolState) {
                    session.tool.state[key] = blockedTools.includes(key) ? false : true;
                }
                seal.replyToSender(ctx, msg, '已开启全部工具函数');
                session.save();
                return ret;
            }
            case 'off': {
                const val3 = cmdArgs.getArgN(3);
                if (val3) {
                    session.tool.state[val3] = false;
                    seal.replyToSender(ctx, msg, `已关闭工具函数 ${val3}`);
                    session.save();
                    return ret;
                }
                for (const key in session.toolState) {
                    session.tool.state[key] = false;
                }
                seal.replyToSender(ctx, msg, '已关闭全部工具函数');
                session.save();
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

                if (!Object.prototype.hasOwnProperty.call(toolMap, val3)) {
                    seal.replyToSender(ctx, msg, '没有这个工具函数');
                    return ret;
                }

                const tool = toolMap[val3];
                const s = `${tool.toolInfo.function.name}
      描述:${tool.toolInfo.function.description}
      
      参数信息:
      ${JSON.stringify(tool.toolInfo.function.parameters.properties, null, 2)}
      
      必需参数:${(tool.toolInfo.function.parameters.required || []).join(',')}`;

                seal.replyToSender(ctx, msg, s);
                return ret;
            }
            case 'call': {
                const val3 = cmdArgs.getArgN(3);
                if (!val3) {
                    seal.replyToSender(ctx, msg, `调用函数缺少工具函数名`);
                    return ret;
                }
                if (!Object.prototype.hasOwnProperty.call(toolMap, val3)) {
                    seal.replyToSender(ctx, msg, `调用函数失败:未注册的函数:${val3}`);
                    return ret;
                }
                const tool = toolMap[val3];
                if (tool.ExtCmdInfo.extName !== '' && !Tool.getCmdArgs(ctx)) {
                    seal.replyToSender(ctx, msg, `暂时无法调用函数，请先使用 .r 指令`);
                    return ret;
                }

                try {
                    const args = cmdArgs.kwargs.reduce((acc: { [key: string]: any }, kwarg) => {
                        const valueString = kwarg.value;
                        try {
                            acc[kwarg.name] = JSON.parse(`[${valueString}]`)[0];
                        } catch (_e) {
                            acc[kwarg.name] = valueString;
                        }
                        return acc;
                    }, {} as { [key: string]: any });

                    for (const key of (tool.toolInfo.function.parameters.required || [])) {
                        if (!Object.prototype.hasOwnProperty.call(args, key)) {
                            logger.warning(`调用函数失败:缺少必需参数 ${key}`);
                            seal.replyToSender(ctx, msg, `调用函数失败:缺少必需参数 ${key}`);
                            return ret;
                        }
                    }

                    const content = await tool.solve(ctx, msg, session, args);
                    logger.info(`[tool] 指令调用 session=${session.sessionId} tool=${val3}`);
                    const MAX_TOOL_CALL_OUTPUT_LENGTH = 500;
                    if (content.length > MAX_TOOL_CALL_OUTPUT_LENGTH) {
                        logger.logLong(`[tool] 返回内容过长(${content.length}字符)，已仅记录日志，未发送`, content);
                        seal.replyToSender(ctx, msg, `返回内容过长（${content.length} 字符），未发送，已记录到海豹日志（[tool] 指令调用 tool=${val3}）`);
                    } else {
                        seal.replyToSender(ctx, msg, `返回内容:
      ${content}`);
                    }
                    return ret;
                } catch (e) {
                    const s = `调用函数 (${val3}) 失败:${e instanceof Error ? e.message : String(e)}`;
                    seal.replyToSender(ctx, msg, s);
                    return ret;
                }
            }
            default: {
                const toolStatus = session.toolState;

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
