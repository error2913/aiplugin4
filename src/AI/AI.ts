import { Image, ImageManager } from "./image";
import { ConfigManager } from "../config/configManager";
import { replyToSender, revive, transformMsgId } from "../utils/utils";
import { endStream, pollStream, sendChatRequest, startStream } from "../service";
import { Context } from "./context";
import { MemoryManager } from "./memory";
import { handleMessages, parseBody } from "../utils/utils_message";
import { ToolManager } from "../tool/tool";
import { logger } from "../logger";
import { checkRepeat, handleReply, MessageSegment, transformArrayToContent } from "../utils/utils_string";
import { TimerManager } from "../timer";

export interface GroupInfo {
    isPrivate: false;
    id: string;
    name: string;
}

export interface UserInfo {
    isPrivate: true;
    id: string;
    name: string;
}

export type SessionInfo = GroupInfo | UserInfo;

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
    static validKeys: (keyof AI)[] = ['context', 'tool', 'memory', 'imageManager', 'setting'];
    id: string;
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
        const { content, images } = await transformArrayToContent(ctx, ai, messageArray);
        await ai.context.addMessage(ctx, msg, ai, content, images, 'user', transformMsgId(msg.rawId));
    }

    async reply(ctx: seal.MsgContext, msg: seal.Message, contextArray: string[], replyArray: string[], images: Image[]) {
        for (let i = 0; i < contextArray.length; i++) {
            const content = contextArray[i];
            const reply = replyArray[i];
            const msgId = await replyToSender(ctx, msg, this, reply);
            await this.context.addMessage(ctx, msg, this, content, images, 'assistant', msgId);
        }

        //发送偷来的图片
        const { p } = ConfigManager.image;
        if (Math.random() * 100 <= p) {
            const img = await this.imageManager.drawImage();
            if (img) seal.replyToSender(ctx, msg, img.CQCode);
        }
    }

    async chat(ctx: seal.MsgContext, msg: seal.Message, reason: string = '', tool_choice?: string): Promise<void> {
        logger.info('触发回复:', reason || '未知原因');

        if (reason !== '函数回调触发') {
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
        }

        // 检查toolsNotAllow状态
        const { toolsNotAllow } = ConfigManager.tool;
        toolsNotAllow.forEach(key => {
            if (this.tool.toolStatus.hasOwnProperty(key)) {
                this.tool.toolStatus[key] = false;
            }
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


        const { isTool, usePromptEngineering } = ConfigManager.tool;
        const toolInfos = this.tool.getToolsInfo(msg.messageType);

        let result = { contextArray: [], replyArray: [], images: [] };
        const MaxRetry = 3;
        for (let retry = 1; retry <= MaxRetry; retry++) {
            // 处理messages
            const messages = await handleMessages(ctx, this);

            //获取处理后的回复
            const { content: raw_reply, tool_calls } = await sendChatRequest(messages, toolInfos, tool_choice || "auto");

            // 转化为上下文、回复、图片数组
            result = await handleReply(ctx, msg, this, raw_reply);

            if (isTool) {
                if (usePromptEngineering) {
                    const match = raw_reply.match(/<[\|│｜]?function(?:_call)?>([\s\S]*)<\/function(?:_call)?>/);
                    if (match) {
                        logger.info(`触发工具调用`);
                        // 先给他回复了再说
                        const { contextArray, replyArray, images } = result;
                        await this.reply(ctx, msg, contextArray, replyArray, images);

                        await this.context.addMessage(ctx, msg, this, match[0], [], "assistant", '');
                        try {
                            await ToolManager.handlePromptToolCall(ctx, msg, this, match[1]);
                            await this.chat(ctx, msg, '函数回调触发');
                        } catch (e) {
                            logger.error(`在handlePromptToolCall中出错:`, e.message);
                        }
                        return;
                    }
                } else {
                    if (tool_calls.length > 0) {
                        logger.info(`触发工具调用`);
                        // 先给他回复了再说
                        const { contextArray, replyArray, images } = result;
                        await this.reply(ctx, msg, contextArray, replyArray, images);

                        this.context.addToolCallsMessage(tool_calls);
                        try {
                            tool_choice = await ToolManager.handleToolCalls(ctx, msg, this, tool_calls);
                            await this.chat(ctx, msg, '函数回调触发', tool_choice);
                        } catch (e) {
                            logger.error(`在handleToolCalls中出错:`, e.message);
                        }
                        return;
                    }
                }
            }

            // 检查是否为复读
            if (checkRepeat(this.context, result.contextArray.join('')) && result.replyArray.join('').trim()) {
                if (retry > MaxRetry) {
                    logger.warning(`发现复读，已达到最大重试次数，清除AI上下文`);
                    this.context.clearMessages('assistant', 'tool');
                    break;
                }

                logger.warning(`发现复读，一秒后进行重试:[${retry}/3]`);
                await new Promise(resolve => setTimeout(resolve, 1000));
                continue;
            }

            break;
        }

        const { contextArray, replyArray, images } = result;
        await this.reply(ctx, msg, contextArray, replyArray, images);
        AIManager.saveAI(this.id);
    }

    async chatStream(ctx: seal.MsgContext, msg: seal.Message): Promise<void> {
        const { isTool, usePromptEngineering } = ConfigManager.tool;

        await this.stopCurrentChatStream();

        const messages = await handleMessages(ctx, this);
        const id = await startStream(messages);
        if (!id) return;

        this.stream.id = id;
        let status = 'processing';
        let after = 0;
        let interval = 1000;

        while (status == 'processing' && this.stream.id === id) {
            const result = await pollStream(this.stream.id, after);
            status = result.status;
            const raw_reply = result.reply;

            if (raw_reply.length <= 8) interval = 1500;
            else if (raw_reply.length <= 20) interval = 1000;
            else if (raw_reply.length <= 30) interval = 500;
            else interval = 200;

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
                        if (this.stream.id !== id) return;
                        await this.reply(ctx, msg, contextArray, replyArray, images);
                    }
                    this.stream.toolCallStatus = true;
                }

                if (this.stream.id !== id) return;

                if (this.stream.toolCallStatus) {
                    this.stream.reply += raw_reply;

                    if (/<\/function(?:_call)?>/.test(this.stream.reply)) {
                        logger.info("发现工具调用结束标签，开始处理对应工具调用");
                        const match = this.stream.reply.match(/<[\|│｜]?function(?:_call)?>([\s\S]*)<\/function(?:_call)?>/);
                        if (match) {
                            this.stream.reply = '';
                            this.stream.toolCallStatus = false;
                            await this.stopCurrentChatStream();

                            await this.context.addMessage(ctx, msg, this, match[0], [], "assistant", '');

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
            if (this.stream.id !== id) return;
            this.reply(ctx, msg, contextArray, replyArray, images);

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
    get curActiveTimeSegIndex(): number {
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

    checkActiveTimer(ctx: seal.MsgContext) {
        const { segs, start, end } = this.setting.activeTimeInfo;
        if (segs !== 0 && (start !== 0 || end !== 0)) {
            const timers = TimerManager.getTimers(this.id, '', ['activeTime']);
            if (timers.length === 0) {
                const curSegIndex = this.curActiveTimeSegIndex;
                const nextTimePoint = this.getNextTimePoint(curSegIndex);
                if (nextTimePoint !== -1) TimerManager.addActiveTimeTimer(ctx, this, nextTimePoint);
                else logger.error(`活跃时间定时器添加失败，无法生成时间点，当前时段序号:${curSegIndex}`);
            }
        }
    }
}

export interface UsageInfo {
    prompt_tokens: number,
    completion_tokens: number
}

export class AIManager {
    static cache: { [key: string]: AI } = {};
    static usageMapCache: { [model: string]: { [time: number]: UsageInfo } } = null;

    static get usageMap(): { [model: string]: { [time: number]: UsageInfo } } {
        if (!this.usageMapCache) {
            try {
                this.usageMapCache = JSON.parse(ConfigManager.ext.storageGet('usageMap') || '{}');
            } catch (error) {
                logger.error(`从数据库中获取usageMap失败:`, error);
            }
        }
        return this.usageMapCache;
    }

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
                        const context = revive(Context, value);
                        context.reviveMessages();
                        return context;
                    }
                    if (key === "tool") {
                        const tm = revive(ToolManager, value);
                        tm.reviveToolStauts();
                        return tm;
                    }
                    if (key === "memory") {
                        const mm = revive(MemoryManager, value);
                        mm.reviveMemoryMap();
                        return mm;
                    }
                    if (key === "imageManager") {
                        return revive(ImageManager, value);
                    }
                    if (key === "setting") {
                        return revive(Setting, value);
                    }

                    return value;
                });
            } catch (error) {
                logger.error(`从数据库中获取${`AI_${id}`}失败:`, error);
            }

            ai.id = id;
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
        this.usageMapCache = {};
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

    static saveUsageMap() {
        ConfigManager.ext.storageSet('usageMap', JSON.stringify(this.usageMapCache));
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