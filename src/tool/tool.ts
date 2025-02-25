import { AI } from "../AI/AI"
import { ConfigManager } from "../config/config"
import { log } from "../utils/utils"
import { registerAttrGet, registerAttrSet, registerAttrShow } from "./tool_attr"
import { registerBan } from "./tool_ban"
import { registerDrawDeck } from "./tool_draw_deck"
import { registerFace } from "./tool_face"
import { registerGetTime } from "./tool_get_time"
import { registerCheckAvatar, registerImageToText } from "./tool_image_to_text"
import { registerJrrp } from "./tool_jrrp"
import { registerAddGroupMemory, registerAddPersonMemory, registerShowGroupMemory, registerShowPersonMemory } from "./tool_memory"
import { registerModuRoll, registerModuSearch } from "./tool_modu"
import { registerPoke } from "./tool_poke"
import { registerRename } from "./tool_rename"
import { registerRollCheck } from "./tool_roll_check"
import { registerSanCheck } from "./tool_san_check"
import { registerCancelTimer, registerSetTimer, registerShowTimerList } from "./tool_timer"
import { registerTextToSound } from "./tool_text_to_sound"
import { registerWebSearch } from "./tool_web_search"

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

    constructor() {
        const { toolsNotAllow, toolsDefaultClosed } = ConfigManager.tool;
        this.toolStatus = Object.keys(ToolManager.toolMap).reduce((acc, key) => {
            acc[key] = !toolsNotAllow.includes(key) && !toolsDefaultClosed.includes(key);
            return acc;
        }, {});
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
        registerAddPersonMemory();
        registerAddGroupMemory();
        registerShowPersonMemory();
        registerShowGroupMemory();
        registerDrawDeck();
        registerFace();
        registerJrrp();
        registerModuRoll();
        registerModuSearch();
        registerRollCheck();
        registerRename();
        registerAttrShow();
        registerAttrGet();
        registerAttrSet();
        registerBan();
        registerTextToSound();
        registerPoke();
        registerGetTime();
        registerSetTimer();
        registerShowTimerList();
        registerCancelTimer();
        registerWebSearch();
        registerImageToText();
        registerCheckAvatar();
        registerSanCheck();
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

        ai.listen.status = true;

        const ext = seal.ext.find(cmdInfo.ext);
        ext.cmdMap[cmdInfo.name].solve(ctx, msg, cmdArgs);

        await new Promise(resolve => setTimeout(resolve, 1000));

        if (ai.listen.status) {
            ai.listen.status = false;
            return ['', false];
        }

        return [ai.listen.content, true];
    }

    /**
     * 调用函数并返回tool_choice
     * @param ctx 
     * @param msg 
     * @param ai 
     * @param tool_calls 
     * @returns tool_choice
     */
    static async handleTools(ctx: seal.MsgContext, msg: seal.Message, ai: AI, tool_calls: {
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
            log(`调用函数:`, tool_calls.map((item, i) => {
                return `(${i}) ${item.function.name}:${item.function.arguments}`;
            }).join('\n'));
        }

        let tool_choice = 'none';
        for (let i = 0; i < tool_calls.length; i++) {
            const name = tool_calls[i].function.name;
            try {
                if (this.cmdArgs == null) {
                    log(`暂时无法调用函数，请先使用任意指令`);
                    ai.context.toolIteration(tool_calls[0].id, `暂时无法调用函数，请先提示用户使用任意指令`);
                    continue;
                }

                const tool = this.toolMap[name];

                if (tool.tool_choice === 'required') {
                    tool_choice = 'required';
                } else if (tool_choice !== 'required' && tool.tool_choice === 'auto') {
                    tool_choice = 'auto';
                }

                const args = JSON.parse(tool_calls[i].function.arguments);
                if (args !== null && typeof args !== 'object') {
                    log(`调用函数失败:arguement不是一个object`);
                    ai.context.toolIteration(tool_calls[i].id, `调用函数失败:arguement不是一个object`);
                    continue;
                }
                if (tool.info.function.parameters.required.some(key => !args.hasOwnProperty(key))) {
                    log(`调用函数失败:缺少必需参数`);
                    ai.context.toolIteration(tool_calls[i].id, `调用函数失败:缺少必需参数`);
                    continue;
                }

                const s = await tool.solve(ctx, msg, ai, args);

                ai.context.toolIteration(tool_calls[i].id, s);
            } catch (e) {
                const s = `调用函数 (${name}:${tool_calls[i].function.arguments}) 失败:${e.message}`;
                console.error(s);
                ai.context.toolIteration(tool_calls[i].id, s);
            }
        }

        return tool_choice;
    }

    static async handlePromptTool(ctx: seal.MsgContext, msg: seal.Message, ai: AI, tool_call: {
        name: string,
        arguments: {
            [key: string]: any
        }
    }): Promise<void> {
        if (!tool_call.hasOwnProperty('name') || !tool_call.hasOwnProperty('arguments')) {
            log(`调用函数失败:缺少name或arguments`);
            ai.context.systemUserIteration('_调用函数返回', `调用函数失败:缺少name或arguments`);
        }

        const name = tool_call.name;
        try {
            if (this.cmdArgs == null) {
                log(`暂时无法调用函数，请先使用任意指令`);
                ai.context.systemUserIteration('_调用函数返回', `暂时无法调用函数，请先提示用户使用任意指令`);
                return;
            }

            const tool = this.toolMap[name];

            const args = tool_call.arguments;
            if (args !== null && typeof args !== 'object') {
                log(`调用函数失败:arguement不是一个object`);
                ai.context.systemUserIteration('_调用函数返回', `调用函数失败:arguement不是一个object`);
                return;
            }
            if (tool.info.function.parameters.required.some(key => !args.hasOwnProperty(key))) {
                log(`调用函数失败:缺少必需参数`);
                ai.context.systemUserIteration('_调用函数返回', `调用函数失败:缺少必需参数`);
                return;
            }

            const s = await tool.solve(ctx, msg, ai, args);

            ai.context.systemUserIteration('_调用函数返回', s);
        } catch (e) {
            const s = `调用函数 (${name}:${JSON.stringify(tool_call.arguments, null, 2)}) 失败:${e.message}`;
            console.error(s);
            ai.context.systemUserIteration('_调用函数返回', s);
        }
    }
}
