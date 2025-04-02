import { AI } from "../AI/AI"
import { ConfigManager } from "../config/config"
import { registerAttrGet, registerAttrSet, registerAttrShow } from "./tool_attr"
import { registerBan, registerGetBanList, registerWholeBan } from "./tool_ban"
import { registerDrawDeck } from "./tool_deck"
import { registerCheckAvatar, registerFace, registerImageToText, registerTextToImage } from "./tool_image"
import { registerJrrp } from "./tool_jrrp"
import { registerAddMemory, registerShowMemory } from "./tool_memory"
import { registerModuRoll, registerModuSearch } from "./tool_modu"
import { registerPoke } from "./tool_poke"
import { registerRename } from "./tool_rename"
import { registerRollCheck, registerSanCheck } from "./tool_roll_check"
import { registerCancelTimer, registerGetTime, registerSetTimer, registerShowTimerList } from "./tool_time"
import { registerRecord, registerTextToSound } from "./tool_voice"
import { registerWebSearch } from "./tool_web_search"
import { registerGroupSign } from "./tool_group_sign"
import { registerGetPersonInfo } from "./tool_person_info"
import { registerDeleteMsg, registerQuoteMsg, registerSendMsg } from "./tool_message"
import { registerGetContext } from "./tool_context"
import { registerGetGroupMemberList, registerGetList, registerSearchChat, registerSearchCommonGroup } from "./tool_qq_list"
import { registerSetTriggerCondition } from "./tool_trigger"
import { registerMusicPlay } from "./tool_music"
import { logger } from "../AI/logger"

export interface ToolInfo {
    type: "function",
    function: {
        name: string,
        description: string,
        parameters: {
            type: "object",
            properties: {
                [key: string]: {
                    type: string,
                    description: string,
                    properties?: object,
                    required?: string[],
                    items?: {
                        type: string
                    },
                    enum?: string[]
                }
            },
            required: string[]
        }
    }
}

export interface ToolCall {
    index: number,
    id: string,
    type: "function",
    function: {
        name: string,
        arguments: string
    }
}

export interface CmdInfo {
    ext: string,
    name: string,
    fixedArgs: string[]
}

export class Tool {
    info: ToolInfo;
    cmdInfo: CmdInfo;
    tool_choice: string; // 是否可以继续调用函数："none" | "auto" | "required"
    solve: (ctx: seal.MsgContext, msg: seal.Message, ai: AI, args: { [key: string]: any }) => Promise<string>;

    constructor(info: ToolInfo) {
        this.info = info;
        this.cmdInfo = {
            ext: '',
            name: '',
            fixedArgs: []
        }
        this.tool_choice = 'none';
        this.solve = async (_, __, ___, ____) => "函数未实现";
    }

}

export class ToolManager {
    static cmdArgs: seal.CmdArgs = null;
    static toolMap: { [key: string]: Tool } = {};
    toolStatus: { [key: string]: boolean };

    // 监听调用函数发送的内容
    listen: {
        status: boolean,
        content: string
    }

    constructor() {
        const { toolsNotAllow, toolsDefaultClosed } = ConfigManager.tool;
        this.toolStatus = Object.keys(ToolManager.toolMap).reduce((acc, key) => {
            acc[key] = !toolsNotAllow.includes(key) && !toolsDefaultClosed.includes(key);
            return acc;
        }, {});

        this.listen = {
            status: false,
            content: ''
        };
    }

    static reviver(value: any): ToolManager {
        const tm = new ToolManager();
        const validKeys = ['toolStatus'];

        for (const k of validKeys) {
            if (value.hasOwnProperty(k)) {
                tm[k] = value[k];

                if (k === 'toolStatus') {
                    const { toolsNotAllow, toolsDefaultClosed } = ConfigManager.tool;
                    tm[k] = Object.keys(ToolManager.toolMap).reduce((acc, key) => {
                        acc[key] = !toolsNotAllow.includes(key) && (value[k].hasOwnProperty(key) ? value[k][key] : !toolsDefaultClosed.includes(key));
                        return acc;
                    }, {});
                }
            }
        }

        return tm;
    }

    getToolsInfo(): ToolInfo[] {
        const tools = Object.keys(this.toolStatus)
            .map(key => {
                if (this.toolStatus[key]) {
                    return ToolManager.toolMap[key].info;
                } else {
                    return null;
                }
            })
            .filter(item => item !== null);

        if (tools.length === 0) {
            return null;
        } else {
            return tools;
        }
    }

    static registerTool() {
        registerAddMemory();
        registerShowMemory();
        registerDrawDeck();
        registerJrrp();
        registerModuRoll();
        registerModuSearch();
        registerRollCheck();
        registerSanCheck();
        registerRename();
        registerAttrShow();
        registerAttrGet();
        registerAttrSet();
        registerBan();
        registerWholeBan();
        registerGetBanList();
        registerRecord();
        registerTextToSound();
        registerPoke();
        registerGetTime();
        registerSetTimer();
        registerShowTimerList();
        registerCancelTimer();
        registerWebSearch();
        registerFace();
        registerImageToText();
        registerCheckAvatar();
        registerTextToImage();
        registerGroupSign();
        registerGetPersonInfo();
        registerSendMsg();
        registerDeleteMsg();
        registerQuoteMsg();
        registerGetContext();
        registerGetList();
        registerGetGroupMemberList();
        registerSearchChat();
        registerSearchCommonGroup();
        registerSetTriggerCondition();
        registerMusicPlay();
    }

    /**
     * 利用预存的指令信息和额外输入的参数构建一个cmdArgs, 并调用solve函数
     * @param cmdArgs
     * @param args
     */
    static async extensionSolve(ctx: seal.MsgContext, msg: seal.Message, ai: AI, cmdInfo: CmdInfo, ...args: string[]): Promise<[string, boolean]> {
        const cmdArgs = this.cmdArgs;
        cmdArgs.command = cmdInfo.name;
        cmdArgs.args = cmdInfo.fixedArgs.concat(args);
        cmdArgs.kwargs = [];
        cmdArgs.at = [];
        cmdArgs.rawArgs = cmdArgs.args.join(' ');
        cmdArgs.amIBeMentioned = false;
        cmdArgs.amIBeMentionedFirst = false;
        cmdArgs.cleanArgs = cmdArgs.args.join(' ');

        ai.tool.listen.status = true;

        const ext = seal.ext.find(cmdInfo.ext);
        ext.cmdMap[cmdInfo.name].solve(ctx, msg, cmdArgs);

        await new Promise(resolve => setTimeout(resolve, 1000));

        if (ai.tool.listen.status) {
            ai.tool.listen.status = false;
            return ['', false];
        }

        return [ai.tool.listen.content, true];
    }

    /**
     * 调用函数并返回tool_choice
     * @param ctx 
     * @param msg 
     * @param ai 
     * @param tool_calls 
     * @returns tool_choice
     */
    static async handleToolCalls(ctx: seal.MsgContext, msg: seal.Message, ai: AI, tool_calls: {
        index: number,
        id: string,
        type: "function",
        function: {
            name: string,
            arguments: string
        }
    }[]): Promise<string> {
        tool_calls.splice(5); // 最多调用5个函数
        if (tool_calls.length !== 0) {
            logger.info(`调用函数:`, tool_calls.map((item, i) => {
                return `(${i}) ${item.function.name}:${item.function.arguments}`;
            }).join('\n'));
        }

        let tool_choice = 'none';
        for (let i = 0; i < tool_calls.length; i++) {
            const tool_call = tool_calls[i];
            const tool_choice2 = await this.handleToolCall(ctx, msg, ai, tool_call);

            if (tool_choice2 === 'required') {
                tool_choice = 'required';
            } else if (tool_choice === 'none' && tool_choice2 === 'auto') {
                tool_choice = 'auto';
            }
        }

        return tool_choice;
    }

    static async handleToolCall(ctx: seal.MsgContext, msg: seal.Message, ai: AI, tool_call: {
        index: number,
        id: string,
        type: "function",
        function: {
            name: string,
            arguments: string
        }
    }): Promise<string> {
        const name = tool_call.function.name;

        if (!this.toolMap.hasOwnProperty(name)) {
            logger.warning(`调用函数失败:未注册的函数:${name}`);
            await ai.context.addToolMessage(tool_call.id, `调用函数失败:未注册的函数:${name}`);
            return "none";
        }
        if (ConfigManager.tool.toolsNotAllow.includes(name)) {
            logger.warning(`调用函数失败:禁止调用的函数:${name}`);
            await ai.context.addToolMessage(tool_call.id, `调用函数失败:禁止调用的函数:${name}`);
            return "none";
        }
        if (this.cmdArgs == null) {
            logger.warning(`暂时无法调用函数，请先使用任意指令`);
            await ai.context.addToolMessage(tool_call.id, `暂时无法调用函数，请先提示用户使用任意指令`);
            return "none";
        }

        try {
            const tool = this.toolMap[name];

            const args = JSON.parse(tool_call.function.arguments);
            if (args !== null && typeof args !== 'object') {
                logger.warning(`调用函数失败:arguement不是一个object`);
                await ai.context.addToolMessage(tool_call.id, `调用函数失败:arguement不是一个object`);
                return "none";
            }
            for (const key of tool.info.function.parameters.required) {
                if (!args.hasOwnProperty(key)) {
                    logger.warning(`调用函数失败:缺少必需参数 ${key}`);
                    await ai.context.addToolMessage(tool_call.id, `调用函数失败:缺少必需参数 ${key}`);
                    return "none";
                }
            }

            const s = await tool.solve(ctx, msg, ai, args);

            await ai.context.addToolMessage(tool_call.id, s);

            return tool.tool_choice;
        } catch (e) {
            const s = `调用函数 (${name}:${tool_call.function.arguments}) 失败:${e.message}`;
            console.error(s);
            await ai.context.addToolMessage(tool_call.id, s);
            return "none";
        }
    }

    static async handlePromptToolCall(ctx: seal.MsgContext, msg: seal.Message, ai: AI, tool_call: {
        name: string,
        arguments: {
            [key: string]: any
        }
    }): Promise<void> {
        if (!tool_call.hasOwnProperty('name') || !tool_call.hasOwnProperty('arguments')) {
            logger.warning(`调用函数失败:缺少name或arguments`);
            await ai.context.addSystemUserMessage('调用函数返回', `调用函数失败:缺少name或arguments`, []);
        }

        const name = tool_call.name;

        if (!this.toolMap.hasOwnProperty(name)) {
            logger.warning(`调用函数失败:未注册的函数:${name}`);
            await ai.context.addSystemUserMessage('调用函数返回', `调用函数失败:未注册的函数:${name}`, []);
            return;
        }
        if (ConfigManager.tool.toolsNotAllow.includes(name)) {
            logger.warning(`调用函数失败:禁止调用的函数:${name}`);
            await ai.context.addSystemUserMessage('调用函数返回', `调用函数失败:禁止调用的函数:${name}`, []);
            return;
        }
        if (this.cmdArgs == null) {
            logger.warning(`暂时无法调用函数，请先使用任意指令`);
            await ai.context.addSystemUserMessage('调用函数返回', `暂时无法调用函数，请先提示用户使用任意指令`, []);
            return;
        }

        try {
            const tool = this.toolMap[name];

            const args = tool_call.arguments;
            if (args !== null && typeof args !== 'object') {
                logger.warning(`调用函数失败:arguement不是一个object`);
                await ai.context.addSystemUserMessage('调用函数返回', `调用函数失败:arguement不是一个object`, []);
                return;
            }
            for (const key of tool.info.function.parameters.required) {
                if (!args.hasOwnProperty(key)) {
                    logger.warning(`调用函数失败:缺少必需参数 ${key}`);
                    await ai.context.addSystemUserMessage('调用函数返回', `调用函数失败:缺少必需参数 ${key}`, []);
                    return;
                }
            }

            const s = await tool.solve(ctx, msg, ai, args);

            await ai.context.addSystemUserMessage('调用函数返回', s, []);
        } catch (e) {
            const s = `调用函数 (${name}:${JSON.stringify(tool_call.arguments, null, 2)}) 失败:${e.message}`;
            console.error(s);
            await ai.context.addSystemUserMessage('调用函数返回', s, []);
        }
    }
}
