import { Image, ImageManager } from "./image";
import { ConfigManager } from "../config/config";
import { log, parseBody } from "../utils/utils";
import { endStream, pollStream, sendChatRequest, startStream } from "./service";
import { Context } from "./context";
import { Memory } from "./memory";
import { handleMessages } from "../utils/utils_message";
import { handleReply } from "../utils/utils_reply";
import { ToolManager } from "../tool/tool";

export interface Privilege {
    limit: number,
    counter: number,
    timer: number,
    prob: number,
    standby: boolean
}

export class AI {
    id: string;
    context: Context;
    tool: ToolManager;
    memory: Memory;
    image: ImageManager;
    privilege: Privilege;
    listen: {
        status: boolean,
        content: string
    }
    stream: {
        id: string,
        reply: string,
        images: Image[],
        toolCallStatus: boolean
    }

    constructor(id: string) {
        this.id = id;
        this.context = new Context();
        this.tool = new ToolManager();
        this.memory = new Memory();
        this.image = new ImageManager();
        this.privilege = {
            limit: 100,
            counter: -1,
            timer: -1,
            prob: -1,
            standby: false
        };
        this.listen = { // 监听调用函数发送的内容
            status: false,
            content: ''
        };
        this.stream = {
            id: '',
            reply: '',
            images: [],
            toolCallStatus: false
        }
    }

    static reviver(value: any, id: string): AI {
        const ai = new AI(id);
        const validKeys = ['context', 'tool', 'memory', 'image', 'privilege'];

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
    }

    async getReply(ctx: seal.MsgContext, msg: seal.Message, retry = 0): Promise<{ s: string, reply: string, images: Image[] }> {
        // 处理messages
        const messages = handleMessages(ctx, this);

        //获取处理后的回复
        const raw_reply = await sendChatRequest(ctx, msg, this, messages, "auto");
        const { s, isRepeat, reply, images } = await handleReply(ctx, msg, raw_reply, this.context);

        //禁止AI复读
        if (isRepeat && reply !== '') {
            if (retry == 3) {
                log(`发现复读，已达到最大重试次数，清除AI上下文`);
                this.context.messages = this.context.messages.filter(item => item.role !== 'assistant' && item.role !== 'tool');
                return { s: '', reply: '', images: [] };
            }

            retry++;
            log(`发现复读，一秒后进行重试:[${retry}/3]`);

            //等待一秒后进行重试
            await new Promise(resolve => setTimeout(resolve, 1000));
            return await this.getReply(ctx, msg, retry);
        }

        return { s, reply, images };
    }

    async chat(ctx: seal.MsgContext, msg: seal.Message): Promise<void> {
        const bodyTemplate = ConfigManager.request.bodyTemplate;
        const bodyObject = parseBody(bodyTemplate, [], null, null);
        if (bodyObject?.stream === true) {
            await this.chatStream(ctx, msg);
            return;
        }

        const timeout = setTimeout(() => {
            log(this.id, `处理消息超时`);
        }, 60 * 1000);

        //清空数据
        this.clearData();

        let { s, reply, images } = await this.getReply(ctx, msg);
        this.context.lastReply = reply;
        await this.context.iteration(ctx, s, images, 'assistant');

        // 发送回复
        seal.replyToSender(ctx, msg, reply);

        //发送偷来的图片
        const { p } = ConfigManager.image;
        if (Math.random() * 100 <= p) {
            const file = await this.image.drawImageFile();
            if (file) {
                seal.replyToSender(ctx, msg, `[CQ:image,file=${file}]`);
            }
        }

        clearTimeout(timeout);
    }

    async chatStream(ctx: seal.MsgContext, msg: seal.Message): Promise<void> {
        const { isTool, usePromptEngineering } = ConfigManager.tool;

        await this.stopCurrentChatStream(ctx, msg);

        //清空数据
        this.clearData();

        const messages = handleMessages(ctx, this);
        const id = await startStream(messages);

        this.stream.id = id;
        let status = 'processing';
        let after = 0;

        while (status == 'processing' && this.stream.id === id) {
            const result = await pollStream(this.stream.id, after);
            status = result.status;
            const raw_reply = result.reply;
            if (raw_reply.trim() === '') {
                after = result.nextAfter;
                await new Promise(resolve => setTimeout(resolve, 1000));
                continue;
            }
            log("接收到的回复:", raw_reply);

            if (isTool && usePromptEngineering) {
                if (!this.stream.toolCallStatus && /<function_call>/.test(this.stream.reply + raw_reply)) {
                    // 处理并发送function_call前面的内容
                    const match = raw_reply.match(/([\s\S]*)<function_call>/);
                    if (match) {
                        if (match[1].trim() !== '') {
                            const { s, reply, images } = await handleReply(ctx, msg, match[1], this.context);

                            if (this.stream.id !== id) {
                                return;
                            }
                            this.stream.reply += s;
                            this.stream.images.push(...images);
                            seal.replyToSender(ctx, msg, reply);

                            await this.context.iteration(ctx, this.stream.reply, this.stream.images, 'assistant');
                        }
                    }

                    if (this.stream.id !== id) {
                        return;
                    }
                    this.stream.reply = (this.stream.reply + raw_reply).replace(/[\s\S]*<function_call>/, '<function_call>');
                    this.stream.toolCallStatus = true;

                    after = result.nextAfter;
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    continue;
                }

                if (this.stream.toolCallStatus) {
                    this.stream.reply += raw_reply;

                    if (/<\/function_call>/.test(this.stream.reply)) {
                        // 去除function_call后面的内容
                        this.stream.reply = this.stream.reply.replace(/<\/function_call>[\s\S]*/, '</function_call>');

                        const reply = this.stream.reply;
                        const match = reply.match(/<function_call>([\s\S]*)<\/function_call>/);
                        if (match) {
                            this.stream.toolCallStatus = false;
                            await this.stopCurrentChatStream(ctx, msg);

                            try {
                                const tool_call = JSON.parse(match[1]);
                                await ToolManager.handlePromptToolCall(ctx, msg, this, tool_call);
                            } catch (e) {
                                console.error('处理prompt tool call时出现错误:', e);
                            }

                            await this.chatStream(ctx, msg);
                            return;
                        }
                    } else {
                        after = result.nextAfter;
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        continue;
                    }
                }
            }

            const { s, reply, images } = await handleReply(ctx, msg, raw_reply, this.context);

            if (this.stream.id !== id) {
                return;
            }
            this.stream.reply += s;
            this.stream.images.push(...images);
            seal.replyToSender(ctx, msg, reply);

            after = result.nextAfter;
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        if (this.stream.id !== id) {
            return;
        }

        await this.stopCurrentChatStream(ctx, msg);
    }

    async stopCurrentChatStream(ctx: seal.MsgContext, msg: seal.Message): Promise<void> {
        const { id, reply, images, toolCallStatus } = this.stream;
        this.stream = {
            id: '',
            reply: '',
            images: [],
            toolCallStatus: false
        }
        if (id) {
            log(`结束会话${id}`);
            if (reply) {
                const { s } = await handleReply(ctx, msg, reply, this.context);
                await this.context.iteration(ctx, s, images, 'assistant');
                if (toolCallStatus) { // 没有处理完的工具调用，直接发送
                    seal.replyToSender(ctx, msg, s);
                }
            }
            await endStream(id);
        }
    }
}

export class AIManager {
    static cache: { [key: string]: AI } = {};
    static usageMap: {
        [key: string]: { // 模型名
            [key: number]: { // 年月日
                prompt_tokens: number,
                completion_tokens: number
            }
        }
    } = {};

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
                    if (key === "tool") {
                        return ToolManager.reviver(value);
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

    static clearUsageMap() {
        this.usageMap = {};
    }

    static clearExpiredUsage(model: string) {
        const now = new Date();
        const currentYear = now.getFullYear();
        const currentMonth = now.getMonth() + 1;
        const currentDay = now.getDate();
        const currentYM = currentYear * 12 + currentMonth;
        const currentYMD = currentYear * 12 * 31 + currentMonth * 31 + currentDay;

        if (!this.usageMap.hasOwnProperty(model)) {
            return;
        }

        for (const key in this.usageMap[model]) {
            const [year, month, day] = key.split('-').map(Number);
            const ym = year * 12 + month;
            const ymd = year * 12 * 31 + month * 31 + day;

            let newKey = '';

            if (ymd < currentYMD - 30) {
                newKey = `${year}-${month}-0`;
            }

            if (ym < currentYM - 11) {
                newKey = `0-0-0`;
            }

            if (newKey) {
                if (!this.usageMap[model].hasOwnProperty(newKey)) {
                    this.usageMap[model][newKey] = {
                        prompt_tokens: 0,
                        completion_tokens: 0
                    };
                }

                this.usageMap[model][newKey].prompt_tokens += this.usageMap[model][key].prompt_tokens;
                this.usageMap[model][newKey].completion_tokens += this.usageMap[model][key].completion_tokens;

                delete this.usageMap[model][key];
            }
        }
    }

    static getUsageMap() {
        try {
            const usage = JSON.parse(ConfigManager.ext.storageGet('usageMap') || '{}');
            this.usageMap = usage;
        } catch (error) {
            console.error(`从数据库中获取usageMap失败:`, error);
        }
    }

    static saveUsageMap() {
        ConfigManager.ext.storageSet('usageMap', JSON.stringify(this.usageMap));
    }

    static updateUsage(model: string, usage: {
        prompt_tokens: number,
        completion_tokens: number,
        total_tokens: number
    }) {
        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth() + 1;
        const day = now.getDate();
        const key = `${year}-${month}-${day}`;
        if (!this.usageMap.hasOwnProperty(model)) {
            this.usageMap[model] = {};
        }

        if (!this.usageMap[model].hasOwnProperty(key)) {
            this.usageMap[model][key] = {
                prompt_tokens: 0,
                completion_tokens: 0
            };

            this.clearExpiredUsage(model);
        }

        this.usageMap[model][key].prompt_tokens += usage.prompt_tokens || 0;
        this.usageMap[model][key].completion_tokens += usage.completion_tokens || 0;

        this.saveUsageMap();
    }

    static getModelUsage(model: string): {
        prompt_tokens: number,
        completion_tokens: number
    } {
        if (!this.usageMap.hasOwnProperty(model)) {
            return {
                prompt_tokens: 0,
                completion_tokens: 0
            };
        }

        const usage = {
            prompt_tokens: 0,
            completion_tokens: 0
        }

        for (const key in this.usageMap[model]) {
            usage.prompt_tokens += this.usageMap[model][key].prompt_tokens;
            usage.completion_tokens += this.usageMap[model][key].completion_tokens;
        }

        return usage;
    }
}