import { AI } from "../AI/AI"
import { ConfigManager } from "../utils/configUtils"
import { registerAttrShow } from "./tool_attr"
import { registerBan } from "./tool_ban"
import { registerDrawDeck } from "./tool_draw_deck"
import { registerFace } from "./tool_face"
import { registerGetTime } from "./tool_get_time"
import { registerImageToText } from "./tool_image_to_text"
import { registerJrrp } from "./tool_jrrp"
import { registerMemory } from "./tool_memory"
import { registerModuRoll, registerModuSearch } from "./tool_modu"
import { registerPoke } from "./tool_poke"
import { registerRename } from "./tool_rename"
import { registerRollCheck } from "./tool_roll_check"
import { registerSetTimer } from "./tool_set_timer"
import { registerTTS } from "./tool_tts"
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

    /**
     * 
     * @param ctx 
     * @param msg
     * @param ai
     * @param args
     */
    solve: (ctx: seal.MsgContext, msg: seal.Message, ai: AI, ...args: string[]) => Promise<string>;

    /**
     * @param name 命令的名字，<$这一部分#参数1#参数2>
     * @param command 指令，如 .st show 的st，没有可以不写
     * @param args 指令的参数
     */
    constructor(info: ToolInfo) {
        this.info = info;
        this.cmdInfo = {
            ext: '',
            name: '',
            fixedArgs: []
        }
        this.tool_choice = 'none';
        this.solve = async (_, __, ___) => "函数未实现";
    }

}

export class ToolManager {
    static cmdArgs: seal.CmdArgs = null;
    static toolMap: { [key: string]: Tool } = {};

    static init() {
        registerMemory();
        registerDrawDeck();
        registerFace();
        registerJrrp();
        registerModuRoll();
        registerModuSearch();
        registerRollCheck();
        registerRename();
        registerAttrShow();
        registerBan();
        registerTTS();
        registerPoke();
        registerGetTime();
        registerSetTimer();
        registerWebSearch();
        registerImageToText();
    }

    /** TODO
     * 撤回消息
     * 获取精华消息
     * 设置精华消息
     * 删除精华消息
     * 发送群公告
     * 获取群公告
     */

    static getTools(toolAllow: string[]): ToolInfo[] {
        const tools = Object.values(this.toolMap)
            .map(item => {
                if (toolAllow.includes(item.info.function.name)) {
                    return item.info;
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

        await new Promise(resolve => setTimeout(resolve, 200));

        if (ai.listen.status) {
            ai.listen.status = false;
            return ['', false];
        }

        return [ai.listen.content, true];
    }

    /**
     * 
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
            ConfigManager.printLog(`调用函数:`, tool_calls.map((item, i) => {
                return `(${i}) ${item.function.name}:${item.function.arguments}`;
            }).join('\n'));
        }

        let tool_choice = 'none';
        for (let i = 0; i < tool_calls.length; i++) {
            const name = tool_calls[i].function.name;
            try {
                if (this.cmdArgs == null) {
                    ConfigManager.printLog(`暂时无法调用函数，请先使用任意指令`);
                    ai.context.toolIteration(tool_calls[0].id, `暂时无法调用函数，请先提示用户使用任意指令`);
                    continue;
                }

                const tool = this.toolMap[name];

                if (tool.tool_choice === 'required') {
                    tool_choice = 'required';
                } else if (tool_choice !== 'required' && tool.tool_choice === 'auto') {
                    tool_choice = 'auto';
                }

                const args_obj = JSON.parse(tool_calls[i].function.arguments);
                const order = Object.keys(tool.info.function.parameters.properties);
                const args = order.map(item => args_obj?.[item]);
                const s = await tool.solve(ctx, msg, ai, ...args);

                ai.context.toolIteration(tool_calls[i].id, s);
            } catch (e) {
                const s = `调用函数 (${name}:${tool_calls[i].function.arguments}) 失败:${e.message}`;
                console.error(s);
                ai.context.toolIteration(tool_calls[i].id, s);
            }
        }

        return tool_choice;
    }
}
