import { ImageManager } from "./image";
import { ConfigManager } from "../utils/configUtils";
import { handleReply } from "../utils/utils";
import { FetchData, sendRequest } from "../utils/requestUtils";
import { parseBody } from "../utils/utils";
import { Context } from "./context";
import { Memory } from "./memory";

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
    memory: Memory;
    image: ImageManager;
    privilege: Privilege;
    listen: {
        status: boolean,
        content: string
    }
    isChatting: boolean;
    isGettingAct: boolean;

    constructor(id: string) {
        this.id = id;
        this.context = new Context();
        this.memory = new Memory();
        this.image = new ImageManager();
        this.privilege = {
            limit: 100,
            counter: -1,
            timer: -1,
            prob: -1,
            interrupt: -1,
            standby: false
        };
        this.listen = { // 监听调用函数发送的内容
            status: false,
            content: ''
        };
        this.isChatting = false;
        this.isGettingAct = false;
    }

    static reviver(value: any, id: string): AI{
        const ai = new AI(id);
        const validKeys = ['context', 'memory', 'image', 'privilege'];

        for (const k of validKeys) {
            if (value.hasOwnProperty(k)) {
                ai[k] = value[k];
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

    async getReply(ctx: seal.MsgContext, msg: seal.Message, retry = 0): Promise<{ s: string, reply: string}> {
        // 处理messages
        const { messages } = ConfigManager.getProcessedMessagesConfig(ctx, this);

        //获取处理后的回复
        const raw_reply = await sendRequest(ctx, msg, this, messages, "auto");
        const { s, reply, isRepeat } = await handleReply(ctx, msg, raw_reply, this.context);

        //禁止AI复读
        if (isRepeat && reply !== '') {
            if (retry == 3) {
                ConfigManager.printLog(`发现复读，已达到最大重试次数，清除AI上下文`);
                this.context.messages = this.context.messages.filter(item => item.role !== 'assistant' && item.role !== 'tool');
                return { s: '', reply: '' };
            }

            retry++;
            ConfigManager.printLog(`发现复读，一秒后进行重试:[${retry}/3]`);

            //等待一秒后进行重试
            await new Promise(resolve => setTimeout(resolve, 1000));
            return await this.getReply(ctx, msg, retry);
        }

        return { s, reply };
    }

    async chat(ctx: seal.MsgContext, msg: seal.Message): Promise<void> {
        if (this.isChatting) {
            ConfigManager.printLog(this.id, `正在处理消息，跳过`);
            return;
        }
        this.isChatting = true;
        const timeout = setTimeout(() => {
            this.isChatting = false;
            ConfigManager.printLog(this.id, `处理消息超时`);
        }, 60 * 1000);

        //清空数据
        this.clearData();

        let { s, reply } = await this.getReply(ctx, msg);
        const {message, images} = await ImageManager.handleImageMessage(ctx, s);
        s = message;

        this.context.lastReply = reply;
        await this.context.iteration(ctx, s, images, 'assistant');

        // 发送回复
        seal.replyToSender(ctx, msg, reply);

        //发送偷来的图片
        const { p } = ConfigManager.getImageProbabilityConfig();
        if (Math.random() * 100 <= p) {
            const file = await this.image.drawImageFile();
            if (file) {
                seal.replyToSender(ctx, msg, `[CQ:image,file=${file}]`);
            }
        }

        clearTimeout(timeout);
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
        const timeout = setTimeout(() => {
            this.isGettingAct = false;
            ConfigManager.printLog(this.id, `获取活跃度超时`);
        }, 60 * 1000);

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
            const bodyObject = parseBody(bodyTemplate, messages, null, null);

            const data = await FetchData(url, apiKey, bodyObject);

            if (data.choices && data.choices.length > 0) {
                const reply = data.choices[0].message.content;

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

        clearTimeout(timeout);
        this.isGettingAct = false;
        return this.context.interrupt.act;
    }
}

export class AIManager {
    static cache: { [key: string]: AI } = {};

    static clearCache() {
        this.cache = {};
    }

    static getAI(id: string) {
        if (!this.cache.hasOwnProperty(id)) {
            let data = new AI(id);

            try {
                data = JSON.parse(ConfigManager.ext.storageGet(`AI_${id}`) || '{}', (key, value) => {
                    if (key === "") {
                        return AI.reviver(value, id);
                    }

                    if (key === "context") {
                        return Context.reviver(value);
                    }
                    if (key === "memory") {
                        return Memory.reviver(value);
                    }
                    if (key === "image") {
                        return ImageManager.reviver(value);
                    }

                    return value;
                });
            } catch (error) {
                console.error(`从数据库中获取${`AI_${id}`}失败:`, error);
            }

            this.cache[id] = data;
        }

        return this.cache[id];
    }

    static saveAI(id: string) {
        if (this.cache.hasOwnProperty(id)) {
            ConfigManager.ext.storageSet(`AI_${id}`, JSON.stringify(this.cache[id]));
        }
    }
}