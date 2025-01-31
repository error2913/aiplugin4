import { AI } from "../AI/AI"
import { ConfigManager } from "../utils/configUtils"
import { registerDrawDeck } from "./tool_draw_deck"
import { registerFace } from "./tool_face"
import { registerJrrp } from "./tool_jrrp"

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
                    description: string
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
    name: string,
    fixedArgs: string[]
}

export class Tool {
    info: ToolInfo;
    cmdInfo: CmdInfo;

    /**
     * 
     * @param ctx 
     * @param msg 
     * @param cmdArgs 
     * @param ai
     * @param args
     */
    solve: (ctx: seal.MsgContext, msg: seal.Message, cmdArgs: seal.CmdArgs, ai: AI, ...args: string[]) => Promise<string>;

    /**
     * @param name 命令的名字，<$这一部分#参数1#参数2>
     * @param command 指令，如 .st show 的st，没有可以不写
     * @param args 指令的参数
     */
    constructor(info: ToolInfo) {
        this.info = info;
        this.cmdInfo = {
            name: '',
            fixedArgs: []
        }
        this.solve = async (_, __, ___) => "函数未实现";
    }

}

export class ToolManager {
    static cmdArgs: seal.CmdArgs = null;
    static toolMap: { [key: string]: Tool } = {};

    static init() {
        registerDrawDeck();
        registerFace();
        registerJrrp();
    }

    static getTools(toolAllow: string[]): ToolInfo[] {
        const tools =  Object.values(this.toolMap)
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
     * 利用预存的指令信息和额外输入的参数构建一个cmdArgs
     * @param cmdArgs
     * @param args
     */
    static handleCmdArgs(cmdArgs: seal.CmdArgs, cmdInfo: CmdInfo, ...args: string[]) {
        cmdArgs.command = cmdInfo.name;
        cmdArgs.args = cmdInfo.fixedArgs.concat(args);
        cmdArgs.kwargs = [];
        cmdArgs.at = [];
        cmdArgs.rawArgs = cmdArgs.args.join(' ');
        cmdArgs.amIBeMentioned = false;
        cmdArgs.amIBeMentionedFirst = false;
        cmdArgs.cleanArgs = cmdArgs.args.join(' ');
    }

    static async handleTools(ctx: seal.MsgContext, msg: seal.Message, ai: AI, tool_calls: {
        index: number,
        id: string,
        type: "function",
        function: {
            name: string,
            arguments: string
        }
    }[]) {
        const names = tool_calls.map(item => item.function.name).splice(0, 5);
        if (names.length !== 0) {
            ConfigManager.printLog(`调用函数:`, names);
        }

        try {
            for (let i = 0; i < names.length; i++) {
                if (this.cmdArgs == null) {
                    ConfigManager.printLog(`暂时无法调用函数，请先使用任意指令`);
                    ai.context.toolIteration(tool_calls[0].id, `暂时无法调用函数，请先提示用户使用任意指令`);
                    continue;
                }

                const name = names[i];
                if (this.toolMap.hasOwnProperty(name)) {
                    const tool = this.toolMap[name];
                    const args_obj = JSON.parse(tool_calls[i].function.arguments);
                    const order = Object.keys(tool.info.function.parameters.properties);
                    const args = order.map(item => args_obj?.[item]);
                    const s = await tool.solve(ctx, msg, this.cmdArgs, ai,...args);

                    ai.context.toolIteration(tool_calls[i].id, s);
                } else {
                    console.error(`函数${name}不存在`);
                }
            }
        } catch (e) {
            const s = `调用函数失败:` + e.message;
            console.error(s);
        }
    }
}
