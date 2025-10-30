import { Image, ImageManager } from "./image";
import { ConfigManager } from "../config/config";
import { replyToSender, revive, transformMsgId } from "../utils/utils";
import { endStream, pollStream, sendChatRequest, startStream } from "../service";
import { Context } from "./context";
import { MemoryManager, Memory } from "./memory";
import { handleMessages, parseBody } from "../utils/utils_message";
import { ToolManager } from "../tool/tool";
import { logger } from "../logger";
import { checkRepeat, handleReply, MessageSegment, transformTextToArray } from "../utils/utils_string";
import { checkContextUpdate } from "../utils/utils_update";
import { TimerManager } from "../timer";

export class Setting {
    static validKeys: (keyof Setting)[] = ['priv', 'standby', 'counter', 'timer', 'prob', 'activeTimeInfo'];
    priv: number;
    standby: boolean;
    counter: number;
    timer: number;
    prob: number;
    activeTimeInfo: {
        start: number;
        end: number;
        segs: number;
    }

    constructor() {
        this.priv = 0;
        this.standby = false;
        this.counter = -1;
        this.timer = -1;
        this.prob = -1;
        this.activeTimeInfo = {
            start: 0,
            end: 0,
            segs: 0
        }
    }
}

export class AI {
    static validKeys: (keyof AI)[] = ['version', 'context', 'tool', 'memory', 'imageManager', 'setting'];
    id: string;
    version: string;
    context: Context;
    tool: ToolManager;
    memory: MemoryManager;
    imageManager: ImageManager;
    setting: Setting;

    // 下面是临时变量，用于处理消息
    stream: { // 用于流式输出相关
        id: string,
        reply: string,
        toolCallStatus: boolean
    }

    bucket: { // 触发次数令牌桶
        count: number,
        lastTime: number
    }

    constructor() {
        this.id = '';
        this.version = '0.0.0';
        this.context = new Context();
        this.tool = new ToolManager();
        this.memory = new MemoryManager();
        this.imageManager = new ImageManager();
        this.setting = new Setting();
        this.stream = {
            id: '',
            reply: '',
            toolCallStatus: false
        }
        this.bucket = {
            count: 0,
            lastTime: 0
        }
    }

    resetState() {
        clearTimeout(this.context.timer);
        this.context.timer = null;
        this.context.counter = 0;
        this.bucket.count--;
        this.tool.toolCallCount = 0;
    }

    async handleReceipt(ctx: seal.MsgContext, msg: seal.Message, ai: AI, messageArray: MessageSegment[]) {
        // 图片偷取，以及图片转文字
        let images: Image[] = [];
        if (messageArray.some(item => item.type === 'image')) {
            const result = await ImageManager.handleImageMessage(ctx, messageArray);
            messageArray = result.messageArray;
            images = result.images;
            if (ai.imageManager.stealStatus) {
                ai.imageManager.stealImages(images);
            }
        }

        await ai.context.addMessage(ctx, msg, ai, messageArray, images, 'user', transformMsgId(msg.rawId));
    }

    async chat(ctx: seal.MsgContext, msg: seal.Message, reason: string = ''): Promise<void> {
        logger.info('触发回复:', reason || '未知原因');

        const { bucketLimit, fillInterval } = ConfigManager.received;
        // 补充并检查触发次数
        if (Date.now() - this.bucket.lastTime > fillInterval * 1000) {
            const fillCount = (Date.now() - this.bucket.lastTime) / (fillInterval * 1000);
            this.bucket.count = Math.min(this.bucket.count + fillCount, bucketLimit);
            this.bucket.lastTime = Date.now();
        }
        if (this.bucket.count <= 0) {
            logger.warning(`触发次数不足，无法回复`);
            return;
        }

        // 检查toolsNotAllow状态
        const { toolsNotAllow } = ConfigManager.tool;
        Object.keys(ToolManager.toolMap).forEach(key => {
            this.tool.toolStatus[key] = !toolsNotAllow.includes(key);
        });

        //清空数据
        this.resetState();

        // 解析body，检查是否为流式
        let stream = false;
        try {
            const bodyTemplate = ConfigManager.request.bodyTemplate;
            const bodyObject = parseBody(bodyTemplate, [], null, null);
            stream = bodyObject?.stream === true;
        } catch (err) {
            logger.error('解析body时出现错误:', err);
            return;
        }
        if (stream) {
            await this.chatStream(ctx, msg);
            AIManager.saveAI(this.id);
            return;
        }

        let result = {
            contextArray: [],
            replyArray: [],
            images: []
        }
        const MaxRetry = 3;
        for (let retry = 1; retry <= MaxRetry; retry++) {
            // 处理messages
            const messages = handleMessages(ctx, this);

            //获取处理后的回复
            const raw_reply = await sendChatRequest(ctx, msg, this, messages, "auto");
            result = await handleReply(ctx, msg, this, raw_reply);

            if (!checkRepeat(this.context, result.contextArray.join('')) || result.replyArray.join('').trim() === '') {
                break;
            }

            if (retry > MaxRetry) {
                logger.warning(`发现复读，已达到最大重试次数，清除AI上下文`);
                this.context.clearMessages('assistant', 'tool');
                break;
            }

            logger.warning(`发现复读，一秒后进行重试:[${retry}/3]`);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        const { contextArray, replyArray, images } = result;

        for (let i = 0; i < contextArray.length; i++) {
            const s = contextArray[i];
            const messageArray = transformTextToArray(s);
            const reply = replyArray[i];
            const msgId = await replyToSender(ctx, msg, this, reply);
            await this.context.addMessage(ctx, msg, this, messageArray, images, 'assistant', msgId);
        }

        //发送偷来的图片
        const { p } = ConfigManager.image;
        if (Math.random() * 100 <= p) {
            const file = await this.imageManager.drawImageFile();

            if (file) {
                seal.replyToSender(ctx, msg, `[CQ:image,file=${file}]`);
            }
        }

        AIManager.saveAI(this.id);
    }

    async chatStream(ctx: seal.MsgContext, msg: seal.Message): Promise<void> {
        const { isTool, usePromptEngineering } = ConfigManager.tool;

        await this.stopCurrentChatStream();

        const messages = handleMessages(ctx, this);
        const id = await startStream(messages);
        if (id === '') {
            return;
        }

        this.stream.id = id;
        let status = 'processing';
        let after = 0;
        let interval = 1000;

        while (status == 'processing' && this.stream.id === id) {
            const result = await pollStream(this.stream.id, after);
            status = result.status;
            const raw_reply = result.reply;

            if (raw_reply.length <= 8) {
                interval = 1500;
            } else if (raw_reply.length <= 20) {
                interval = 1000;
            } else if (raw_reply.length <= 30) {
                interval = 500;
            } else {
                interval = 200;
            }

            if (raw_reply.trim() === '') {
                after = result.nextAfter;
                await new Promise(resolve => setTimeout(resolve, interval));
                continue;
            }
            logger.info("接收到的回复:", raw_reply);

            if (isTool && usePromptEngineering) {
                if (!this.stream.toolCallStatus && /<[\|│｜]?function(?:_call)?>/.test(this.stream.reply + raw_reply)) {
                    logger.info("发现工具调用开始标签，拦截后续内容");

                    // 对于function_call前面的内容，发送并添加到上下文中
                    const match = raw_reply.match(/([\s\S]*)<[\|│｜]?function(?:_call)?>/);
                    if (match && match[1].trim()) {
                        const { contextArray, replyArray, images } = await handleReply(ctx, msg, this, match[1]);

                        if (this.stream.id !== id) {
                            return;
                        }

                        for (let i = 0; i < contextArray.length; i++) {
                            const s = contextArray[i];
                            const messageArray = transformTextToArray(s);
                            const reply = replyArray[i];
                            const msgId = await replyToSender(ctx, msg, this, reply);
                            await this.context.addMessage(ctx, msg, this, messageArray, images, 'assistant', msgId);
                        }
                    }

                    this.stream.toolCallStatus = true;
                }

                if (this.stream.id !== id) {
                    return;
                }

                if (this.stream.toolCallStatus) {
                    this.stream.reply += raw_reply;

                    if (/<\/function(?:_call)?>/.test(this.stream.reply)) {
                        logger.info("发现工具调用结束标签，开始处理对应工具调用");
                        const match = this.stream.reply.match(/<[\|│｜]?function(?:_call)?>([\s\S]*)<\/function(?:_call)?>/);
                        if (match) {
                            this.stream.reply = '';
                            this.stream.toolCallStatus = false;
                            await this.stopCurrentChatStream();

                            const messageArray = transformTextToArray(match[0]);
                            await this.context.addMessage(ctx, msg, this, messageArray, [], "assistant", '');

                            try {
                                await ToolManager.handlePromptToolCall(ctx, msg, this, match[1]);
                            } catch (e) {
                                logger.error(`在handlePromptToolCall中出错：`, e.message);
                                return;
                            }

                            await this.chatStream(ctx, msg);
                            return;
                        } else {
                            logger.error('无法匹配到function_call');
                            await this.stopCurrentChatStream();
                        }
                        return;
                    } else {
                        after = result.nextAfter;
                        await new Promise(resolve => setTimeout(resolve, interval));
                        continue;
                    }
                }
            }

            const { contextArray, replyArray, images } = await handleReply(ctx, msg, this, raw_reply);

            if (this.stream.id !== id) {
                return;
            }

            for (let i = 0; i < contextArray.length; i++) {
                const s = contextArray[i];
                const messageArray = transformTextToArray(s);
                const reply = replyArray[i];
                const msgId = await replyToSender(ctx, msg, this, reply);
                await this.context.addMessage(ctx, msg, this, messageArray, images, 'assistant', msgId);
            }

            after = result.nextAfter;
            await new Promise(resolve => setTimeout(resolve, interval));
        }

        if (this.stream.id !== id) {
            return;
        }

        await this.stopCurrentChatStream();
    }

    async stopCurrentChatStream(): Promise<void> {
        const { id, reply, toolCallStatus } = this.stream;
        this.stream = {
            id: '',
            reply: '',
            toolCallStatus: false
        }
        if (id) {
            logger.info(`结束会话:`, id);
            if (reply) {
                if (toolCallStatus) { // 没有处理完的工具调用，在日志中显示
                    logger.warning(`工具调用未处理完成:`, reply);
                }
            }
            await endStream(id);
        }
    }

    // 若不在活动时间范围内，返回-1
    getCurSegIndex(): number {
        const now = new Date();
        const cur = now.getHours() * 60 + now.getMinutes();
        const { start, end, segs } = this.setting.activeTimeInfo;
        const endReal = end >= start ? end : end + 24 * 60;
        const curReal = cur >= start ? cur : cur + 24 * 60;

        if (curReal >= endReal) return -1;

        const segLen = (endReal - start) / segs;
        const index = Math.floor((curReal - start) / segLen);
        return Math.min(index, segs - 1);
    }

    // 若没有下一个活跃时间点，返回-1
    getNextTimePoint(curSegIndex: number): number {
        const { start, end, segs } = this.setting.activeTimeInfo;

        if (start === 0 && end === 0) return -1;

        const endReal = end >= start ? end : end + 24 * 60;
        const segLen = (endReal - start) / segs;
        const nextSegIndex = (curSegIndex + 1) % segs;
        const todayMin = Math.floor(start + nextSegIndex * segLen + Math.random() * segLen) % (24 * 60);

        const nextTime = new Date();
        nextTime.setHours(Math.floor(todayMin / 60), todayMin % 60, Math.floor(Math.random() * 60), 0);

        // 如果时间已过，设置为明天
        if (nextTime.getTime() <= Date.now()) {
            nextTime.setDate(nextTime.getDate() + 1);
        }

        return Math.floor(nextTime.getTime() / 1000);
    }

    checkActiveTimer(ctx: seal.MsgContext, msg: seal.Message) {
        const { segs, start, end } = this.setting.activeTimeInfo;
        if (segs !== 0 && (start !== 0 || end !== 0)) {
            const timers = TimerManager.getTimers(this.id, '', ['activeTime']);
            if (timers.length === 0) {
                const curSegIndex = this.getCurSegIndex();
                const nextTimePoint = this.getNextTimePoint(curSegIndex);
                if (nextTimePoint !== -1) {
                    TimerManager.addActiveTimeTimer(ctx, msg, this, nextTimePoint);
                } else {
                    logger.error(`活跃时间定时器添加失败，无法生成时间点，当前时段序号:${curSegIndex}`);
                }
            }
        }
    }
}

export class AIManager {
    static version = "1.0.1";
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
            let ai = new AI();

            try {
                ai = JSON.parse(ConfigManager.ext.storageGet(`AI_${id}`) || '{}', (key, value) => {
                    if (key === "") {
                        return revive(AI, value);
                    }

                    if (key === "context") {
                        return revive(Context, value);
                    }
                    if (key === "tool") {
                        return revive(ToolManager, value);
                    }
                    if (key === "memory") {
                        return revive(MemoryManager, value);
                    }
                    if (key === "imageManager") {
                        return revive(ImageManager, value);
                    }
                    if (key === "setting") {
                        return revive(Setting, value);
                    }

                    if (key === "memoryMap") {
                        for (const key in value) {
                            value[key] = revive(Memory, value[key]);
                        }
                    }

                    return value;
                });
            } catch (error) {
                logger.error(`从数据库中获取${`AI_${id}`}失败:`, error);
            }

            ai.id = id;
            checkContextUpdate(ai);

            this.cache[id] = ai;
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
            logger.error(`从数据库中获取usageMap失败:`, error);
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
        if (!model) {
            return;
        }
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