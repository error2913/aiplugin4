import { ImageManager } from "../image/imageManager";
import { CommandManager } from "../utils/commandUtils";
import { Config } from "../utils/configUtils";
import { handleReply, repeatDetection } from "../utils/handleReplyUtils";
import { getRespose, sendRequest } from "../utils/requestUtils";
import { getCQTypes, getNameById, getUrlsInCQCode, parseBody } from "../utils/utils";

export interface Message {
    role: string;
    content: string;
}

export interface Context {
    messages: Message[];
    timestamp: number;
    lastReply: string;
}

export interface AIData {
    counter: number,
    timer: number;
    interrupt: {
        act: number;
        timestamp: number;
    }
}

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
    data: AIData;
    privilege: Privilege;
    isChatting: boolean;
    isGettingAct: boolean;
    image: ImageManager;

    constructor(id: string) {
        this.id = id;
        this.context = {
            messages: [],
            timestamp: 0,
            lastReply: ''
        };
        this.data = {
            counter: 0,
            timer: null,
            interrupt: {
                act: 0,
                timestamp: 0
            }
        };
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
        this.image = new ImageManager(id);
    }

    static parse(data: any, id: string): AI {
        if (data === null || typeof data !== 'object' || Array.isArray(data)) {
            data = {};
        }

        const ai = new AI(id);

        if (data.hasOwnProperty('context') && typeof data.context === 'object' && !Array.isArray(data.context)) {
            if (data.context.hasOwnProperty('messages') && Array.isArray(data.context.messages)) {
                ai.context.messages = data.context.messages;
            }

            if (data.context.hasOwnProperty('timestamp') && typeof data.context.timestamp === 'number') {
                ai.context.timestamp = data.context.timestamp;
            }

            if (data.context.hasOwnProperty('lastReply') && typeof data.context.lastReply === 'string') {
                ai.context.lastReply = data.context.lastReply;
            }
        }

        if (data.hasOwnProperty('data') && typeof data.data === 'object' && !Array.isArray(data.data)) {
            if (data.data.hasOwnProperty('counter') && typeof data.data.counter === 'number') {
                ai.data.counter = data.data.counter;
            }

            if (data.data.hasOwnProperty('timer') && typeof data.data.timer === 'number') {
                ai.data.timer = data.data.timer;
            }
            if (data.data.hasOwnProperty('interrupt') && typeof data.data.interrupt === 'object' && !Array.isArray(data.data.interrupt)) {
                if (data.data.interrupt.hasOwnProperty('act') && typeof data.data.interrupt.act === 'number') {
                    ai.data.interrupt.act = data.data.interrupt.act;
                }
                if (data.data.interrupt.hasOwnProperty('timestamp') && typeof data.data.interrupt.timestamp === 'number') {
                    ai.data.interrupt.timestamp = data.data.interrupt.timestamp;
                }
            }
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
        clearTimeout(this.data.timer);
        this.data.timer = null;
        this.data.counter = 0;
        this.data.interrupt.act = 0;
    }

    async iteration(ctx: seal.MsgContext, s: string, role: 'user' | 'assistant') {
        const messages = this.context.messages;
        const contextTs = this.context.timestamp;

        const { maxRounds, isPrefix, ctxCacheTime } = Config.getStorageConfig();

        // 检查是否超过缓存时间，超过则清空上下文
        const timestamp = parseInt(seal.format(ctx, "{$tTimestamp}"))
        if (timestamp - contextTs > ctxCacheTime * 60) {
            this.context.messages = [];
        }

        this.context.timestamp = timestamp;

        const CQTypes = getCQTypes(s);

        //检查有无图片
        if (CQTypes.includes('image')) {
            const urls = getUrlsInCQCode(s);
            const url = urls[0];

            try {
                const reply = await this.image.imageToText(ctx, url);
                s = s.replace(/\[CQ:image,file=http.*?\]/, `<|${reply}|>`);
            } catch (error) {
                console.error('Error in imageToText:', error);
            }

            //剩下的图片
            s = s.replace(/\[CQ:image,file=.*?\]/, '<|图片|>');
        }

        //处理文本
        if (role === 'assistant') {
            s = s
                .replace(/\[图:.*?\]/g, '')
                .replace(/\[语音:.*?\]/g, '')
                .replace(/\[视频:.*?\]/g, '')
        }
        s = s
            .replace(/\[CQ:reply,id=-?\d+\]\[CQ:at,qq=\d+\]/g, '')
            .replace(/\[CQ:at,qq=(\d+)\]/g, (_, p1) => {
                const epId = ctx.endPoint.userId;
                const gid = ctx.group.groupId;
                const uid = `QQ:${p1}`;
                const dice_name = seal.formatTmpl(ctx, "核心:骰子名字");

                return `@${getNameById(epId, gid, uid, dice_name)}`;
            })
            .replace(/\[CQ:.*?\]/g, '')

        //更新上下文
        const senderName = role == 'user' ? ctx.player.name : seal.formatTmpl(ctx, "核心:骰子名字");
        const rounds = messages.length;
        if (rounds !== 0 && messages[rounds - 1].content.includes(`<|from ${senderName}|>`)) {
            this.context.messages[rounds - 1].content += ' ' + s;
        } else {
            const prefix = isPrefix ? `<|from ${senderName}|> ` : ``;
            s = prefix + s;

            const message = { role: role, content: s };
            messages.push(message);
        }

        //删除多余的上下文
        if (rounds > maxRounds) {
            this.context.messages = messages.slice(-maxRounds);
        }
    }

    async getReply(ctx: seal.MsgContext, msg: seal.Message, systemMessages: Message[], retry = 0): Promise<{ s: string, reply: string, commands: string[] }> {
        const messages = [...systemMessages, ...this.context.messages];

        //获取处理后的回复
        const raw_reply = await sendRequest(messages);
        const { s, reply, commands } = handleReply(ctx, msg, raw_reply);

        //禁止AI复读
        if (repeatDetection(reply, this.context.messages) && reply !== '') {
            if (retry == 3) {
                Config.printLog(`发现复读，已达到最大重试次数，清除AI上下文`);
                this.context.messages = messages.filter(item => item.role != 'assistant');
                return { s: '', reply: '', commands: [] };
            }

            retry++;
            Config.printLog(`发现复读，一秒后进行重试:[${retry}/3]`);

            //等待一秒后进行重试
            await new Promise(resolve => setTimeout(resolve, 1000));
            return await this.getReply(ctx, msg, systemMessages, retry);
        }

        return { s, reply, commands };
    }

    async chat(ctx: seal.MsgContext, msg: seal.Message): Promise<string[]> {
        if (this.isChatting) {
            Config.printLog(this.id, `正在处理消息，跳过`);
            return [];
        }
        this.isChatting = true;
        const result: string[] = [];

        //清空数据
        this.clearData();

        const { systemMessages, isCmd } = Config.getSystemMessageConfig(ctx.group.groupName);
        const { s, reply, commands } = await this.getReply(ctx, msg, systemMessages);

        result.push(reply);
        this.context.lastReply = reply;
        await this.iteration(ctx, s, 'assistant');

        // commands相关处理
        if (isCmd && commands.length !== 0) {
            CommandManager.handleCommands(ctx, msg, commands);
        }

        //发送图片
        const { p } = Config.getImageProbabilityConfig();
        if (Math.random() <= p) {
            const file = await this.image.drawImage();
            if (file) {
                result.push(`[CQ:image,file=${file}]`);
            }
        }
        
        this.isChatting = false;
        return result;
    }

    async getAct(): Promise<number> {
        const { url, apiKey, bodyTemplate, ctxLength, topics, maxChar, cacheTime } = Config.getInterruptConfig();

        const timestamp = Math.floor(Date.now() / 1000);
        if (timestamp < this.data.interrupt.timestamp) {
            return 0;
        }
        this.data.interrupt.timestamp = timestamp + cacheTime;

        if (this.isGettingAct) {
            return 0;
        }
        this.isGettingAct = true;

        //清除定时器
        clearTimeout(this.data.timer)
        this.data.timer = null;

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

                Config.printLog(`返回活跃度:`, reply);

                // 解析 AI 返回的数字
                const act = parseInt(reply.replace('<｜end▁of▁sentence｜>', '').trim());
                if (isNaN(act) || act < 1 || act > 10) {
                    throw new Error("AI 返回的积极性数值无效");
                }

                if (this.data.interrupt.act === 0) {
                    this.data.interrupt.act = act;
                } else {
                    this.data.interrupt.act = (this.data.interrupt.act * 0.2) + (act * 0.8);
                }
            } else {
                throw new Error("服务器响应中没有choices或choices为空");
            }
        } catch (error) {
            console.error("在getAct中出错：", error);
        }

        this.isGettingAct = false;
        return this.data.interrupt.act;
    }
}