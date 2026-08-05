// 工具系统：Tool 注册表、工具调用（含扩展指令/提示词工程）与注册
import Config from "../config/config"
import Logger from "../logger"
import { Session } from "../session/session";
import { SessionType } from "../session/types";
import { fixJsonString } from "../utils/string";
import { withTimeout } from "../utils/utils";

import { registerMCPTools } from "./mcp";
import { getSkillNames, registerSkills } from "./skills";
import registerBuiltinCmds from "./tools/builtin_cmd.ts/init";
import { registerAttr } from "./tools/builtin_cmd.ts/tool_attr";
import { registerModu } from "./tools/builtin_cmd.ts/tool_modu";
import { registerRollCheck } from "./tools/builtin_cmd.ts/tool_roll_check";
import { registerImage } from "./tools/image.ts/tool_image";
import { registerMeme } from "./tools/image.ts/tool_meme";
import { registerRender } from "./tools/image.ts/tool_render";
import { registerBan } from "./tools/ob11.ts/tool_ban";
import { registerEssenceMsg } from "./tools/ob11.ts/tool_essence_msg";
import { registerGroupSign } from "./tools/ob11.ts/tool_group_sign";
import { registerGetPersonInfo } from "./tools/ob11.ts/tool_person_info";
import { registerQQList } from "./tools/ob11.ts/tool_qq_list";
import { registerRename } from "./tools/ob11.ts/tool_rename";
import { registerDeck } from "./tools/seal.ts/tool_deck";
import { registerContext } from "./tools/tool_context";
import { registerMemory } from "./tools/tool_memory";
import { registerMessage } from "./tools/tool_message";
import { registerMusicPlay } from "./tools/tool_music";
import { registerTime } from "./tools/tool_time";
import { registerSetTrigger } from "./tools/tool_trigger";
import { registerRecord } from "./tools/tool_voice";
import { registerWeb } from "./tools/tool_web";
import { ExtCmdInfo, ToolCall, ToolCallResult, ToolInfo, ToolListen } from "./types";

export const toolMap: { [key: string]: Tool } = {};

export type ToolName = string;
export type ToolState = { [key: string]: boolean };

export default class Tool {
    toolInfo: ToolInfo;
    ExtCmdInfo: ExtCmdInfo; // 海豹指令信息
    sessionType: 'any' | SessionType; // 可使用函数的会话类型
    callBack: boolean; // 是否回调智能体
    sensitive: boolean; // 敏感工具（发送消息/封禁/改名等），调用会显著记录
    solve: (ctx: seal.MsgContext, msg: seal.Message, session: Session, args: { [key: string]: any }) => Promise<string>;

    constructor(info: ToolInfo, sensitive = false) {
        this.toolInfo = info;
        this.sensitive = sensitive;
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

    /** 清空工具注册表（用于测试/热重载） */
    static reset() {
        for (const key of Object.keys(toolMap)) delete toolMap[key];
        Tool.cmdArgs = null;
    }

    static registerTool() {
        registerBuiltinCmds();
        registerAttr();
        registerModu();
        registerRollCheck();
        registerImage();
        registerMeme();
        registerRender();
        registerBan();
        registerEssenceMsg();
        registerGroupSign();
        registerQQList();
        registerGetPersonInfo();
        registerRename();
        registerDeck();
        registerContext();
        registerMemory();
        registerMessage();
        registerMusicPlay();
        registerTime();
        registerSetTrigger();
        registerRecord();
        registerWeb();
        registerSkills();
        registerMCPTools().catch(e => Logger.error(`注册MCP工具失败:${e.message}`));
    }



    /**
     * 利用预存的指令信息和额外输入的参数构建一个cmdArgs并调用solve函数，监听消息并返回结果
     */
    static async extensionSolve(ctx: seal.MsgContext, msg: seal.Message, listen: ToolListen, eci: ExtCmdInfo, args: string[], kwargs: seal.Kwarg[], at: seal.AtInfo[]): Promise<[string, boolean]> {
        if (!this.cmdArgs) {
            Logger.warning('扩展指令调用失败：尚未收到过指令（cmdArgs 为空）');
            return ['', false];
        }
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
        if (!Object.prototype.hasOwnProperty.call(ext.cmdMap, eci.cmd)) {
            Logger.warning(`扩展${eci.extName}中未找到指令:${eci.cmd}`);
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
            Logger.error(`在extensionSolve中: 调用函数失败:${err.message}`);
            return ['', false];
        });
    }

    static async handleToolCall(ctx: seal.MsgContext, msg: seal.Message, session: Session, tool_call: ToolCall): Promise<{ result: ToolCallResult, callBack: boolean }> {
        const name = tool_call.function.name;
        if (!Object.prototype.hasOwnProperty.call(toolMap, name)) {
            Logger.warning(`调用函数失败:未注册的函数:${name}`);
            return { result: { tool_call_id: tool_call.id, content: `调用函数失败:未注册的函数:${name}` }, callBack: true };
        }
        if (!session.toolState?.[name]) {
            Logger.warning(`调用函数失败:未经许可的函数:${name}`);
            return { result: { tool_call_id: tool_call.id, content: `调用函数失败:未经许可的函数:${name}` }, callBack: true };
        }

        const tool = toolMap[name];
        if (tool.ExtCmdInfo.extName !== '' && this.cmdArgs === null) {
            Logger.warning(`暂时无法调用函数，请先使用 .r 指令`);
            return { result: { tool_call_id: tool_call.id, content: `暂时无法调用函数，请先提示用户使用 .r 指令` }, callBack: true };
        }

        const msgType = msg.messageType === 'private' ? 'user' : 'group';
        if (tool.sessionType !== "any" && tool.sessionType !== msgType) {
            Logger.warning(`调用函数失败:函数${name}可使用的场景类型为${tool.sessionType}，当前场景类型为${msgType}`);
            return { result: { tool_call_id: tool_call.id, content: `调用函数失败:函数${name}可使用的场景类型为${tool.sessionType}，当前场景类型为${msgType}` }, callBack: true };
        }

        let args = null;
        try {
            args = JSON.parse(tool_call.function.arguments);
        } catch (e) {
            const fixedStr = fixJsonString(tool_call.function.arguments);
            if (fixedStr === '') {
                Logger.error(`调用函数 (${name}:${tool_call.function.arguments}) 失败:${e.message}`);
                return { result: { tool_call_id: tool_call.id, content: `调用函数 (${name}:${tool_call.function.arguments}) 失败:${e.message}` }, callBack: true };
            }
            try {
                args = JSON.parse(fixedStr);
            } catch (e) {
                Logger.error(`调用函数 (${name}:${tool_call.function.arguments}) 失败:${e.message}`);
                return { result: { tool_call_id: tool_call.id, content: `调用函数 (${name}:${tool_call.function.arguments}) 失败:${e.message}` }, callBack: true };
            }

        }

        try {
            if (args !== null && typeof args !== 'object') {
                Logger.warning(`调用函数失败:arguement不是一个object`);
                return { result: { tool_call_id: tool_call.id, content: `调用函数失败:arguement不是一个object` }, callBack: true };
            }
            for (const key of tool.toolInfo.function.parameters.required) {
                if (!Object.prototype.hasOwnProperty.call(args, key)) {
                    Logger.warning(`调用函数失败:缺少必需参数 ${key}`);
                    return { result: { tool_call_id: tool_call.id, content: `调用函数失败:缺少必需参数 ${key}` }, callBack: true };
                }
            }

            const validateError = Tool.validateArgs(tool, args);
            if (validateError) {
                Logger.warning(`调用函数失败:${validateError}`);
                return { result: { tool_call_id: tool_call.id, content: `调用函数失败:${validateError}` }, callBack: true };
            }

            const { TIMEOUT } = Config.base;
            const time = Date.now();
            const content = await withTimeout(() => tool.solve(ctx, msg, session, args), TIMEOUT);
            Logger.info(`[tool] ${name} 执行耗时 ${Date.now() - time}ms${tool.sensitive ? ' [敏感]' : ''}`);
            return { result: { tool_call_id: tool_call.id, content }, callBack: true };
        } catch (e) {
            Logger.error(`调用函数 (${name}:${tool_call.function.arguments}) 失败:${e.message}`);
            return { result: { tool_call_id: tool_call.id, content: `调用函数 (${name}:${tool_call.function.arguments}) 失败:${e.message}` }, callBack: true };
        }
    }

    /** 轻量参数校验：按 parameters.properties 的 type 检查 */
    static validateArgs(tool: Tool, args: any): string | null {
        const props = (tool.toolInfo.function.parameters && tool.toolInfo.function.parameters.properties) || {};
        for (const key of Object.keys(props)) {
            if (args[key] === undefined) continue;
            const expected = props[key].type;
            if (expected === 'string' && typeof args[key] !== 'string') return `参数 ${key} 应为字符串`;
            if (expected === 'number' && typeof args[key] !== 'number') return `参数 ${key} 应为数字`;
            if (expected === 'boolean' && typeof args[key] !== 'boolean') return `参数 ${key} 应为布尔值`;
            if (expected === 'array' && !Array.isArray(args[key])) return `参数 ${key} 应为数组`;
            if (expected === 'object' && (typeof args[key] !== 'object' || args[key] === null)) return `参数 ${key} 应为对象`;
        }
        return null;
    }
    static async handleToolCalls(ctx: seal.MsgContext, msg: seal.Message, session: Session, tool_calls: ToolCall[]): Promise<{ result: ToolCallResult[], callBack: boolean }> {
        const { MAX_CALL_COUNT } = Config.tool;

        const ret = { result: [], callBack: true };

        for (let i = 0; i < tool_calls.length; i++) {
            const tool_call = tool_calls[i];
            if (session.tool.callCount >= MAX_CALL_COUNT) {
                Logger.warning('工具调用超过上限');
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
                Logger.warning(`解析函数调用失败:tool_calls不是一个数组`);
                return { result: [{ tool_call_id: '', content: `解析函数调用失败:tool_calls不是一个数组` }], callBack: true };
            }
            const tool_calls = data.map((item, index) => {
                if (!Object.prototype.hasOwnProperty.call(item, 'name') || !Object.prototype.hasOwnProperty.call(item, 'arguments')) throw new Error(`缺少name或arguments属性`);
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
            Logger.error(`解析函数调用失败:${e.message}`);
            return { result: [{ tool_call_id: '', content: `解析函数调用失败:${e.message}` }], callBack: true };
        }
    }

    static getToolsInfo(session: Session): ToolInfo[] | null {
        const toolState = session.toolState;
        const sessionType = session.sessionType;
        const tools = Object.keys(toolState)
            .map(key => {
                if (toolState[key]) {
                    if (!Object.prototype.hasOwnProperty.call(toolMap, key)) {
                        Logger.warning(`在getToolsInfo中找不到工具:${key}`);
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
        const { PROMPT_ENGINEERING } = Config.tool;
        const { TOOLS_PROMPT_TEMPLATE } = Config.prompt;

        const tools = this.getToolsInfo(session);
        let s = '';
        if (tools && tools.length > 0) {
            s = TOOLS_PROMPT_TEMPLATE({
                "PROMPT_ENGINEERING": PROMPT_ENGINEERING,
                "tools": tools
            });
        }

        // 可用技能（Skills）：随工具提示词一起注入，AI 可调用 use_skill 获取内容
        const skillNames = getSkillNames();
        if (skillNames.length > 0) {
            s += `\n\n## 可用技能\n- ${skillNames.join('\n- ')}\n需要时请使用 use_skill 工具获取对应技能内容。`;
        }
        return s;
    }
}
