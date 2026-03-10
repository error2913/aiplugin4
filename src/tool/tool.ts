import { Config } from "../config/config"
import { logger } from "../logger"
import { fixJsonString } from "../utils/string";
import { ExtCmdInfo, ToolCall, ToolCallResult, ToolInfo, ToolListen } from "./types";
import { Session } from "../session/session";
import { SessionType } from "../session/types";
import { builtinCmdToolMap } from "./tools/builtin_cmd.ts/init";

export const toolMap = {
    ...builtinCmdToolMap,
}

export type ToolName = keyof typeof toolMap;
export type ToolState = { [key in ToolName]?: boolean };

export class Tool {
    toolInfo: ToolInfo;
    ExtCmdInfo: ExtCmdInfo; // 海豹指令信息
    sessionType: 'any' | SessionType; // 可使用函数的会话类型
    callBack: boolean; // 是否回调智能体
    solve: (ctx: seal.MsgContext, msg: seal.Message, session: Session, args: { [key: string]: any }) => Promise<string>;

    constructor(info: ToolInfo) {
        this.toolInfo = info;
        this.ExtCmdInfo = {
            extName: '',
            cmd: '',
            staticArgs: []
        }
        this.sessionType = "any";
        this.callBack = true;
        this.solve = async (_, __, ___, ____) => "函数未实现";

        toolMap[info.function.name] = this;
    }

    static cmdArgs: seal.CmdArgs = null;

    /**
     * 利用预存的指令信息和额外输入的参数构建一个cmdArgs并调用solve函数，监听消息并返回结果
     */
    static async extensionSolve(ctx: seal.MsgContext, msg: seal.Message, listen: ToolListen, eci: ExtCmdInfo, args: string[], kwargs: seal.Kwarg[], at: seal.AtInfo[]): Promise<[string, boolean]> {
        const cmdArgs = this.cmdArgs;
        cmdArgs.command = eci.cmd;
        cmdArgs.args = eci.staticArgs.concat(args);
        cmdArgs.kwargs = kwargs;
        cmdArgs.at = at;
        cmdArgs.rawArgs = `${cmdArgs.args.join(' ')} ${kwargs.map(item => `--${item.name}${item.valueExists ? `=${item.value}` : ``}`).join(' ')}`;
        cmdArgs.amIBeMentioned = at.findIndex(item => item.userId === ctx.endPoint.userId) !== -1;
        cmdArgs.amIBeMentionedFirst = at?.[0]?.userId === ctx.endPoint.userId;
        cmdArgs.cleanArgs = cmdArgs.args.join(' ');
        cmdArgs.specialExecuteTimes = 0;
        cmdArgs.rawText = `.${cmdArgs.command} ${cmdArgs.rawArgs} ${at.map(item => `[CQ:at,qq=${item.userId.replace(/^.+:/, '')}]`).join(' ')}`;

        const ext = seal.ext.find(eci.extName);
        if (!ext.cmdMap.hasOwnProperty(eci.cmd)) {
            logger.warning(`扩展${eci.extName}中未找到指令:${eci.cmd}`);
            return ['', false];
        }

        listen.reject?.(new Error('中断当前监听'));

        return new Promise((
            resolve: (result: [string, boolean]) => void,
            reject: (err: Error) => void
        ) => {
            listen.timeoutId = setTimeout(() => {
                reject(new Error('监听消息超时'));
                listen.cleanup();
            }, 10 * 1000);
            listen.resolve = (content: string) => {
                resolve([content, true]);
                listen.cleanup();
            };
            listen.reject = (err: Error) => {
                reject(err);
                listen.cleanup();
            };
            try {
                ext.cmdMap[eci.cmd].solve(ctx, msg, cmdArgs);
            } catch (err) {
                reject(new Error(`solve中发生错误:${err.message}`));
                listen.cleanup();
            }
        }).catch((err) => {
            logger.error(`在extensionSolve中: 调用函数失败:${err.message}`);
            return ['', false];
        });
    }

    static async handleToolCall(ctx: seal.MsgContext, msg: seal.Message, session: Session, tool_call: ToolCall): Promise<{ result: ToolCallResult, callBack: boolean }> {
        const name = tool_call.function.name;
        if (!toolMap.hasOwnProperty(name)) {
            logger.warning(`调用函数失败:未注册的函数:${name}`);
            return { result: { tool_call_id: tool_call.id, content: `调用函数失败:未注册的函数:${name}` }, callBack: true };
        }
        if (session.toolState?.[name]) {
            logger.warning(`调用函数失败:未经许可的函数:${name}`);
            return { result: { tool_call_id: tool_call.id, content: `调用函数失败:未经许可的函数:${name}` }, callBack: true };
        }

        const tool = toolMap[name];
        if (tool.ExtCmdInfo.extName !== '' && this.cmdArgs === null) {
            logger.warning(`暂时无法调用函数，请先使用 .r 指令`);
            return { result: { tool_call_id: tool_call.id, content: `暂时无法调用函数，请先提示用户使用 .r 指令` }, callBack: true };
        }

        const msgType = msg.messageType === 'private' ? 'user' : 'group';
        if (tool.sessionType !== "any" && tool.sessionType !== msgType) {
            logger.warning(`调用函数失败:函数${name}可使用的场景类型为${tool.sessionType}，当前场景类型为${msgType}`);
            return { result: { tool_call_id: tool_call.id, content: `调用函数失败:函数${name}可使用的场景类型为${tool.sessionType}，当前场景类型为${msgType}` }, callBack: true };
        }

        let args = null;
        try {
            args = JSON.parse(tool_call.function.arguments);
        } catch (e) {
            const fixedStr = fixJsonString(tool_call.function.arguments);
            if (fixedStr === '') {
                logger.error(`调用函数 (${name}:${tool_call.function.arguments}) 失败:${e.message}`);
                return { result: { tool_call_id: tool_call.id, content: `调用函数 (${name}:${tool_call.function.arguments}) 失败:${e.message}` }, callBack: true };
            }
            try {
                args = JSON.parse(fixedStr);
            } catch (e) {
                logger.error(`调用函数 (${name}:${tool_call.function.arguments}) 失败:${e.message}`);
                return { result: { tool_call_id: tool_call.id, content: `调用函数 (${name}:${tool_call.function.arguments}) 失败:${e.message}` }, callBack: true };
            }

        }

        try {
            if (args !== null && typeof args !== 'object') {
                logger.warning(`调用函数失败:arguement不是一个object`);
                return { result: { tool_call_id: tool_call.id, content: `调用函数失败:arguement不是一个object` }, callBack: true };
            }
            for (const key of tool.toolInfo.function.parameters.required) {
                if (!args.hasOwnProperty(key)) {
                    logger.warning(`调用函数失败:缺少必需参数 ${key}`);
                    return { result: { tool_call_id: tool_call.id, content: `调用函数失败:缺少必需参数 ${key}` }, callBack: true };
                }
            }

            const content = await tool.solve(ctx, msg, session, args);
            return { result: { tool_call_id: tool_call.id, content }, callBack: true };
        } catch (e) {
            logger.error(`调用函数 (${name}:${tool_call.function.arguments}) 失败:${e.message}`);
            return { result: { tool_call_id: tool_call.id, content: `调用函数 (${name}:${tool_call.function.arguments}) 失败:${e.message}` }, callBack: true };
        }
    }
    static async handleToolCalls(ctx: seal.MsgContext, msg: seal.Message, session: Session, tool_calls: ToolCall[]): Promise<{ result: ToolCallResult[], callBack: boolean }> {
        const { MAX_CALL_COUNT } = Config.tool;

        const ret = { result: [], callBack: true };

        for (let i = 0; i < tool_calls.length; i++) {
            const tool_call = tool_calls[i];
            if (session.tool.callCount > MAX_CALL_COUNT) {
                logger.warning('工具调用超过上限');
                ret.result.push({
                    tool_call_id: tool_call.id,
                    content: '工具调用超过上限'
                });
                ret.callBack = false;
                continue;
            }
            const { result, callBack } = await this.handleToolCall(ctx, msg, session, tool_call);
            ret.result.push(result);
            ret.callBack = ret.callBack && callBack;
            session.tool.callCount++;
        }

        return ret;
    }
    static async handlePromptToolCalls(ctx: seal.MsgContext, msg: seal.Message, session: Session, toolCallStr: string): Promise<{ result: ToolCallResult[], callBack: boolean }> {
        try {
            const data = JSON.parse(toolCallStr);
            if (!Array.isArray(data)) {
                logger.warning(`解析函数调用失败:tool_calls不是一个数组`);
                return { result: [{ tool_call_id: '', content: `解析函数调用失败:tool_calls不是一个数组` }], callBack: true };
            }
            const tool_calls = data.map((item, index) => {
                if (!item.hasOwnProperty('name') || !item.hasOwnProperty('arguments')) throw new Error(`缺少name或arguments属性`);
                if (typeof item.name !== 'string' || typeof item.arguments !== 'string') throw new Error(`name或arguments不是字符串`);
                return {
                    index: index,
                    id: index.toString(),
                    type: "function" as const,
                    function: {
                        name: item.name,
                        arguments: item.arguments
                    }
                };
            });
            return await this.handleToolCalls(ctx, msg, session, tool_calls);
        } catch (e) {
            logger.error(`解析函数调用失败:${e.message}`);
            return { result: [{ tool_call_id: '', content: `解析函数调用失败:${e.message}` }], callBack: true };
        }
    }

    static getToolsInfo(session: Session): ToolInfo[] | null {
        const toolState = session.toolState;
        const sessionType = session.sessionType;
        const tools = Object.keys(toolState)
            .map(key => {
                if (toolState[key]) {
                    if (!toolMap.hasOwnProperty(key)) {
                        logger.warning(`在getToolsInfo中找不到工具:${key}`);
                        return null;
                    }
                    const tool: Tool = toolMap[key];
                    if (tool.sessionType !== "any" && tool.sessionType !== sessionType) return null;
                    return tool.toolInfo;
                } else {
                    return null;
                }
            })
            .filter(item => item !== null);

        return tools.length > 0 ? tools : null;
    }
    static getToolsInfoPrompt(session: Session): string {
        const { TOOLS_PROMPT_TEMPLATE } = Config.tool;

        const tools = this.getToolsInfo(session);
        if (tools && tools.length > 0) {
            return tools.map((item, index) => {
                return TOOLS_PROMPT_TEMPLATE({
                    "序号": index + 1,
                    "函数名称": item.function.name,
                    "函数描述": item.function.description,
                    "参数信息": JSON.stringify(item.function.parameters.properties, null, 2),
                    "必需参数": item.function.parameters.required.join('\n')
                });
            }).join('\n');
        }

        return '';
    }
}
