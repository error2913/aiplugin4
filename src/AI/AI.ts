import { ImageManager } from "../image/imageManager";
import { CommandManager } from "../command/commandManager";
import { ConfigManager } from "../utils/configUtils";
import { handleReply } from "../utils/handleReplyUtils";
import { getRespose, sendRequest } from "../utils/requestUtils";
import { parseBody } from "../utils/utils";
import { Context, Message } from "./context";

export interface Privilege {
    limit: number,
    counter: number,
    timer: number,
    prob: number,
    interrupt: number,
    standby: boolean
}

export class AI {
    id: string;
    context: Context;
    image: ImageManager;
    privilege: Privilege;
    isChatting: boolean;
    isGettingAct: boolean;

    constructor(id: string) {
        this.id = id;
        this.context = new Context();
        this.image = new ImageManager(id);
        this.privilege = {
            limit: 100,
            counter: -1,
            timer: -1,
            prob: -1,
            interrupt: -1,
            standby: false
        };
        this.isChatting = false;
        this.isGettingAct = false;
    }

    static parse(data: any, id: string): AI {
        if (data === null || typeof data !== 'object' || Array.isArray(data)) {
            data = {};
        }

        const ai = new AI(id);

        if (data.hasOwnProperty('context') && typeof data.context === 'object' && !Array.isArray(data.context)) {
            ai.context = Context.parse(data.context);
        }

        if (data.hasOwnProperty('privilege') && typeof data.privilege === 'object' && !Array.isArray(data.privilege)) {
            if (data.privilege.hasOwnProperty('limit') && typeof data.privilege.limit === 'number') {
                ai.privilege.limit = data.privilege.limit;
            }
            if (data.privilege.hasOwnProperty('counter') && typeof data.privilege.counter === 'number') {
                ai.privilege.counter = data.privilege.counter;
            }
            if (data.privilege.hasOwnProperty('timer') && typeof data.privilege.timer === 'number') {
                ai.privilege.timer = data.privilege.timer;
            }
            if (data.privilege.hasOwnProperty('prob') && typeof data.privilege.prob === 'number') {
                ai.privilege.prob = data.privilege.prob;
            }
            if (data.privilege.hasOwnProperty('interrupt') && typeof data.privilege.interrupt === 'number') {
                ai.privilege.interrupt = data.privilege.interrupt;
            }
            if (data.privilege.hasOwnProperty('standby') && typeof data.privilege.standby === 'boolean') {
                ai.privilege.standby = data.privilege.standby;
            }
        }

        return ai;
    }

    clearData() {
        clearTimeout(this.context.timer);
        this.context.timer = null;
        this.context.counter = 0;
        this.context.interrupt.act = 0;
    }

    async getReply(ctx: seal.MsgContext, msg: seal.Message, systemMessages: Message[], retry = 0): Promise<{ s: string, reply: string, commands: string[] }> {
        const messages = [...systemMessages, ...this.context.messages];

        // 处理messages
        let processedMessages: { role: string, content: string }[] = [];
        const isPrefix = ConfigManager.getPrefixConfig();
        if (isPrefix) {
            processedMessages = messages.map(message => {
                const prefix = `<|from:${message.name}|>`;
                return {
                    role: message.role,
                    content: prefix + message.content
                }
            })
        } else {
            processedMessages = messages.map(message => {
                return {
                    role: message.role,
                    content: message.content
                }
            })
        }

        //获取处理后的回复
        const raw_reply = await sendRequest(processedMessages);
        const { s, reply, commands, isRepeat } = handleReply(ctx, msg, raw_reply, this.context);

        //禁止AI复读
        if (isRepeat && reply !== '') {
            if (retry == 3) {
                ConfigManager.printLog(`发现复读，已达到最大重试次数，清除AI上下文`);
                this.context.messages = messages.filter(item => item.role != 'assistant');
                return { s: '', reply: '', commands: [] };
            }

            retry++;
            ConfigManager.printLog(`发现复读，一秒后进行重试:[${retry}/3]`);

            //等待一秒后进行重试
            await new Promise(resolve => setTimeout(resolve, 1000));
            return await this.getReply(ctx, msg, systemMessages, retry);
        }

        return { s, reply, commands };
    }

    async chat(ctx: seal.MsgContext, msg: seal.Message): Promise<void> {
        if (this.isChatting) {
            ConfigManager.printLog(this.id, `正在处理消息，跳过`);
            return;
        }
        this.isChatting = true;

        //清空数据
        this.clearData();

        const { systemMessages, isCmd } = ConfigManager.getSystemMessageConfig(ctx, this.context);
        const { s, reply, commands } = await this.getReply(ctx, msg, systemMessages);

        this.context.lastReply = reply;
        await this.context.iteration(ctx, s, 'assistant');

        // 发送回复
        seal.replyToSender(ctx, msg, reply);

        // commands相关处理
        if (isCmd && commands.length !== 0) {
            CommandManager.handleCommands(ctx, msg, commands, this.context);
        }

        //发送图片
        const { p } = ConfigManager.getImageProbabilityConfig();
        if (Math.random() <= p) {
            const file = await this.image.drawImage();
            if (file) {
                seal.replyToSender(ctx, msg, `[CQ:image,file=${file}]`);
            }
        }

        this.isChatting = false;
    }

    async getAct(): Promise<number> {
        const { url, apiKey, bodyTemplate, ctxLength, topics, maxChar, cacheTime } = ConfigManager.getInterruptConfig();

        const timestamp = Math.floor(Date.now() / 1000);
        if (timestamp < this.context.interrupt.timestamp) {
            return 0;
        }
        this.context.interrupt.timestamp = timestamp + cacheTime;

        if (this.isGettingAct) {
            return 0;
        }
        this.isGettingAct = true;

        //清除定时器
        clearTimeout(this.context.timer)
        this.context.timer = null;

        const systemMessage = {
            role: "system",
            content: `你是QQ群里的群员，你感兴趣的话题有:${topics}...你现在要决定参与话题的积极性，不要说多余的话，请只回复1~10之间的数字，请只回复1~10之间的数字，需要分析的对话如下:`
        }

        // 构建上下文
        const contextString = this.context.messages
            .filter(item => item.role == 'user')
            .map(item => item.content.replace(/^<\|from(.*?)\|>/, '  $1:'))
            .slice(-ctxLength)
            .join(' ')
            .slice(-maxChar)
        const message = {
            role: 'user',
            content: contextString
        }
        const messages = [systemMessage, message];

        try {
            const bodyObject = parseBody(bodyTemplate, messages);

            const response = await getRespose(url, apiKey, bodyObject);

            const data_response = await response.json();

            if (data_response.error) {
                throw new Error(`请求失败：${JSON.stringify(data_response.error)}`);
            }

            if (data_response.choices && data_response.choices.length > 0) {
                const reply = data_response.choices[0].message.content;

                ConfigManager.printLog(`返回活跃度:`, reply);

                // 解析 AI 返回的数字
                const act = parseInt(reply.replace('<｜end▁of▁sentence｜>', '').trim());
                if (isNaN(act) || act < 1 || act > 10) {
                    throw new Error("AI 返回的积极性数值无效");
                }

                if (this.context.interrupt.act === 0) {
                    this.context.interrupt.act = act;
                } else {
                    this.context.interrupt.act = (this.context.interrupt.act * 0.2) + (act * 0.8);
                }
            } else {
                throw new Error("服务器响应中没有choices或choices为空");
            }
        } catch (error) {
            console.error("在getAct中出错：", error);
        }

        this.isGettingAct = false;
        return this.context.interrupt.act;
    }
}