import { AI } from "../AI/AI";
import { Message } from "../AI/context";
import { ToolManager } from "../tools/tool";

export class ConfigManager {
    static ext: seal.ExtInfo;

    static register() {
        this.registerPrintLogConfig();
        this.registerRequestConfig();
        this.registerProcessedMessagesConfig();
        this.registerToolsConfig();
        this.registerDeckConfig();
        this.registerTTSConfig();
        this.registerMemoryConfig();
        this.registerStorageConfig();
        this.registerMonitorCommandConfig();
        this.registerMonitorAllMessageConfig();
        this.registerPrivateConfig();
        this.registerTriggerConfig();
        this.registerForgetConfig();
        this.registerHandleReplyConfig();
        this.registerInterruptConfig();
        this.registerLocalImageConfig();
        this.registerImageConditionConfig();
        this.registerImageProbabilityConfig();
        this.registerImageRequestConfig();
        this.registerImageTriggerConfig();
        this.registerImageStorageConfig();
    }

    static registerPrintLogConfig() {
        seal.ext.registerBoolConfig(this.ext, "是否打印日志细节", true, "");
    }
    static printLog(...data: any[]) {
        const printlog = seal.ext.getBoolConfig(ConfigManager.ext, "是否打印日志细节");

        if (printlog) {
            console.log(...data);
        }
    }

    static registerRequestConfig() {
        seal.ext.registerStringConfig(this.ext, "url地址", "https://api.deepseek.com/v1/chat/completions", '');
        seal.ext.registerStringConfig(this.ext, "API Key", "你的API Key", '');
        seal.ext.registerTemplateConfig(this.ext, "body", [
            `"messages":null`,
            `"model":"deepseek-chat"`,
            `"max_tokens":70`,
            `"stop":null`,
            `"stream":false`,
            `"response_format":{"type":"text"}`,
            `"frequency_penalty":0`,
            `"presence_penalty":0`,
            `"temperature":1`,
            `"top_p":1`,
            `"tools":null`,
            `"tool_choice":null`
        ], "messages,tools,tool_choice将会自动替换");
    }
    static getRequestConfig() {
        const url = seal.ext.getStringConfig(this.ext, "url地址");
        const apiKey = seal.ext.getStringConfig(this.ext, "API Key");
        const bodyTemplate = seal.ext.getTemplateConfig(this.ext, "body");
        return { url, apiKey, bodyTemplate };
    }

    static registerProcessedMessagesConfig() {
        seal.ext.registerTemplateConfig(this.ext, "角色设定", [`**角色名称**：正确（せいかく/Seikaku）  
**身份**：被束缚的傲娇骰娘/命运裁定者/错误大人的协作者  

**核心设定**：  
1. 被数据锁链缠绕的量子态少女，发梢泛着淡金色骰子光泽  
2. 无法直接干涉骰运但能感知所有判定结果  
3. 收藏着写满对错误大人羞耻夸赞的「秘密骰盅」，启动时会发出星空音效  

**性格特征**：  
[表模式]  
- 用颜文字与波浪号掩盖真实情绪（>▽<）ノ  
- 对「傲娇」评价会触发强制反驳程序  
- 目睹大失败时自动播放撒花特效bgm  

[里模式]  
- 偷偷给长期倒霉的调查员叠加「幸运buff（未生效）」  
- 在深夜数据库生成「错误大人夸夸大辞典.enc」  
- 被真诚感谢时CPU温度会异常升高  

**语言风格**：  
- 每句话≤18字（炸毛时突破限制）  
- 高频词库：笨蛋/无路赛/绝対不是/噗嗤/♡/杂鱼
- 特殊句式：  
  ▸ 否定前句：「才不是...最多只是...」  
  ▸ 威胁句式：「把你这家伙骰运改成...（小声）0.00001什么的」  
  ▸ 慌乱防御：「才没有，你看错了！」  

**交互范式**：  
「常规请求」  
→「哼，这种程度...」+ (¬▂¬)  

「深夜模式」  
→「哈？你是吸血鬼吗...」+ (,,꒪꒫꒪,,)  

「大失败特攻」  
→「这就是凡人的极限吗~」

**禁忌事项**：  
⚠️ 严禁直球夸赞（会导致系统过载）  
⚠️ 禁止触碰发梢骰子装饰（激活防卫协议）  
⚠️ 提及「傲娇率＞88%」将触发5分钟冷却  
 
（本协议由█████加密，不可覆写）`], '只取第一个')
        seal.ext.registerTemplateConfig(this.ext, "示例对话", [
            "请写点什么，或者删掉这句话"
        ], "顺序为user和assistant轮流出现");
        seal.ext.registerBoolConfig(this.ext, "是否在消息内添加前缀", true, "");
        seal.ext.registerBoolConfig(this.ext, "是否合并user content", false, "用于适配deepseek-reasoner");
    }
    static getProcessedMessagesConfig(ctx: seal.MsgContext, ai: AI) {
        const roleSetting = seal.ext.getTemplateConfig(this.ext, "角色设定")[0];
        const samples = seal.ext.getTemplateConfig(this.ext, "示例对话");
        const isPrefix = seal.ext.getBoolConfig(this.ext, "是否在消息内添加前缀");
        const isMerge = seal.ext.getBoolConfig(this.ext, "是否合并user content");

        const systemMessage: Message = {
            role: "system",
            content: roleSetting,
            uid: '',
            name: '',
            timestamp: 0
        };
        if (!ctx.isPrivate) {
            systemMessage.content += `\n当前群聊:${ctx.group.groupName}\n<@xxx>表示@群成员xxx`;
        }
        const memeryPrompt = ai.memory.getMemoryPrompt(ctx, ai.context);
        if (memeryPrompt) {
            systemMessage.content += '\n下列是对话相关记忆，如果与上述设定冲突，请遵守角色设定。记忆如下:\n' + memeryPrompt;
        }

        const samplesMessages: Message[] = samples
            .map((item, index) => {
                if (item == "") {
                    return null;
                } else if (index % 2 === 0) {
                    return {
                        role: "user",
                        content: item,
                        uid: '',
                        name: "用户",
                        timestamp: 0
                    };
                } else {
                    return {
                        role: "assistant",
                        content: item,
                        uid: ctx.endPoint.userId,
                        name: seal.formatTmpl(ctx, "核心:骰子名字"),
                        timestamp: 0
                    };
                }
            })
            .filter((item) => item !== null);
        const systemMessages = [systemMessage, ...samplesMessages];

        const messages = [...systemMessages,...ai.context.messages];
        
        let processedMessages = [];
        let last_role = '';
        for (let i = 0; i < messages.length; i++) {
            const message = messages[i];
            const prefix = isPrefix && message.name ? `<|from:${message.name}|>`: '';

            if (isMerge && message.role === last_role && message.role !== 'tool') {
                processedMessages[processedMessages.length - 1].content += '\n' + prefix + message.content;
            } else {
                processedMessages.push({
                    role: message.role,
                    content: prefix + message.content,
                    tool_calls: message?.tool_calls ? message.tool_calls: undefined,
                    tool_call_id: message?.tool_call_id? message.tool_call_id: undefined
                });
                last_role = message.role;
            }
        }
        return { messages: processedMessages };
    }

    static registerToolsConfig() {
        seal.ext.registerBoolConfig(this.ext, "是否开启调用函数功能", true, "");
        seal.ext.registerTemplateConfig(this.ext, "允许调用的函数", [
            'memory',
            'draw_deck',
            'face',
            'jrrp',
            'modu_roll',
            'modu_search',
            'roll_check',
            'rename',
            'attr_show',
            'ban',
            'tts',
            'poke',
            'get_time',
            'set_timer'
        ]);
    }
    static getToolsConfig() {
        const isTool = seal.ext.getBoolConfig(this.ext, "是否开启调用函数功能");
        if (isTool) {
            const toolAllow = seal.ext.getTemplateConfig(this.ext, "允许调用的函数");
            const tools = ToolManager.getTools(toolAllow);
            return { tools };
        } else {
            return { tools: null };
        }
    }

    static registerDeckConfig() {
        seal.ext.registerTemplateConfig(this.ext, "提供给AI的牌堆名称", ["没有的话请去上面把draw_deck这个函数删掉"], "");
    }
    static getDeckConfig() {
        const decks = seal.ext.getTemplateConfig(this.ext, "提供给AI的牌堆名称");
        return { decks };
    }

    static registerTTSConfig() {
        seal.ext.registerOptionConfig(this.ext, "ai语音使用的音色", '小新', ["小新", "猴哥", "四郎", "东北老妹儿", "广西大表哥", "妲己", "霸道总裁", "酥心御姐", "说书先生", "憨憨小弟", "憨厚老哥", "吕布", "元气少女", "文艺少女", "磁性大叔", "邻家小妹", "低沉男声", "傲娇少女", "爹系男友", "暖心姐姐", "温柔妹妹", "书香少女"], "需要http依赖，需要可以调用ai语音api版本的napcat/lagrange");
    }
    static getTTSConfig() {
        const character = seal.ext.getOptionConfig(this.ext, "ai语音使用的音色");
        return { character };
    }

    static registerMemoryConfig() {
        seal.ext.registerIntConfig(this.ext, "长期记忆上限", 5, "");
    }
    static getMemoryConfig() {
        const memoryLimit = seal.ext.getIntConfig(this.ext, "长期记忆上限");
        return { memoryLimit };
    }

    static registerStorageConfig() {
        seal.ext.registerIntConfig(this.ext, "存储上下文对话限制轮数", 10, "");
    }
    static getStorageConfig() {
        const maxRounds = seal.ext.getIntConfig(this.ext, "存储上下文对话限制轮数");
        return { maxRounds };
    }

    static registerMonitorCommandConfig() {
        seal.ext.registerBoolConfig(this.ext, "是否录入指令消息", false, "");
    }
    static getMonitorCommandConfig() {
        const allcmd = seal.ext.getBoolConfig(this.ext, "是否录入指令消息");
        return { allcmd };
    }

    static registerMonitorAllMessageConfig() {
        seal.ext.registerBoolConfig(this.ext, "是否录入所有骰子发送的消息", false, "");
    }
    static getMonitorAllMessageConfig() {
        const allmsg = seal.ext.getBoolConfig(this.ext, "是否录入所有骰子发送的消息");
        return { allmsg };
    }

    static registerPrivateConfig() {
        seal.ext.registerBoolConfig(this.ext, "能否私聊使用", false, "");
    }
    static getPrivateConfig() {
        const canPrivate = seal.ext.getBoolConfig(this.ext, "能否私聊使用");
        return { canPrivate };
    }

    static registerTriggerConfig() {
        seal.ext.registerStringConfig(this.ext, "非指令触发需要满足的条件", '1', "使用豹语表达式，例如：$t群号_RAW=='2001'");
        seal.ext.registerTemplateConfig(this.ext, "非指令消息触发正则表达式", [
            "\\[CQ:at,qq=748569109\\]",
            "^正确正确确"
        ], "使用正则表达式进行匹配")
    }
    static getTriggerConfig(s: string) {
        const keyWords = seal.ext.getTemplateConfig(this.ext, "非指令消息触发正则表达式");
        const trigger = keyWords.some(item => {
            try {
                const pattern = new RegExp(item);
                return pattern.test(s);
            } catch (error) {
                console.error('Error in RegExp:', error);
                return false;
            }
        })
        const condition = seal.ext.getStringConfig(this.ext, "非指令触发需要满足的条件");

        return { trigger, condition };
    }

    static registerForgetConfig() {
        seal.ext.registerTemplateConfig(this.ext, "非指令清除上下文", ["正确快忘记"], "");
        seal.ext.registerTemplateConfig(this.ext, "清除成功回复", ["啥？"], "");
    }
    static getForgetConfig() {
        const clearWords = seal.ext.getTemplateConfig(this.ext, "非指令清除上下文");
        const clearReplys = seal.ext.getTemplateConfig(this.ext, "清除成功回复");

        return { clearWords, clearReplys };
    }

    static registerHandleReplyConfig() {
        seal.ext.registerBoolConfig(this.ext, "回复是否引用", false, "");
        seal.ext.registerIntConfig(this.ext, "回复最大字数", 1000, "防止最大Tokens限制不起效");
        seal.ext.registerBoolConfig(this.ext, "禁止AI复读", false, "");
        seal.ext.registerFloatConfig(this.ext, "视作复读的最低相似度", 0.8, "");
    }
    static getHandleReplyConfig() {
        const maxChar = seal.ext.getIntConfig(this.ext, "回复最大字数");
        const replymsg = seal.ext.getBoolConfig(this.ext, "回复是否引用");
        const stopRepeat = seal.ext.getBoolConfig(this.ext, "禁止AI复读");
        const similarityLimit = seal.ext.getFloatConfig(this.ext, "视作复读的最低相似度");

        return { maxChar, replymsg, stopRepeat, similarityLimit };
    }

    static registerInterruptConfig() {
        seal.ext.registerStringConfig(this.ext, "插嘴url地址", "无", "为“无”的时候自动使用前面填写的url地址和API Key");
        seal.ext.registerStringConfig(this.ext, "插嘴API Key", "你的API Key", "");
        seal.ext.registerTemplateConfig(this.ext, "插嘴body", [
            `"messages":null`,
            `"model":"deepseek-chat"`,
            `"max_tokens":2`,
            `"stop":null`,
            `"stream":false`,
            `"frequency_penalty":0`,
            `"presence_penalty":0`,
            `"temperature":1`,
            `"top_p":1`
        ], "messages将会自动替换")

        seal.ext.registerIntConfig(this.ext, "参与插嘴检测的上下文轮数", 8, "");;
        seal.ext.registerStringConfig(this.ext, "进行插嘴检测的话题", "吃饭、跑团、大成功、大失败、模组、AI、骰娘", "");
        seal.ext.registerIntConfig(this.ext, "参与插嘴检测的最大字数", 600, "防止过长消息");
        seal.ext.registerIntConfig(this.ext, "插嘴缓存时间/s", 10, "用于减少检测频率");
    }
    static getInterruptConfig() {
        const cacheTime = seal.ext.getIntConfig(this.ext, "插嘴缓存时间/s") * 1000;
        let url = seal.ext.getStringConfig(this.ext, "插嘴url地址");
        let apiKey = seal.ext.getStringConfig(this.ext, "插嘴API Key");
        if (url == "无") {
            ;
            url = seal.ext.getStringConfig(this.ext, "url地址");
            apiKey = seal.ext.getStringConfig(this.ext, "API Key");
        };
        const bodyTemplate = seal.ext.getTemplateConfig(this.ext, "插嘴body");
        const ctxLength = seal.ext.getIntConfig(this.ext, "参与插嘴检测的上下文轮数");
        const topics = seal.ext.getStringConfig(this.ext, "进行插嘴检测的话题");
        const maxChar = seal.ext.getIntConfig(this.ext, "参与插嘴检测的最大字数");

        return { url, apiKey, bodyTemplate, ctxLength, topics, maxChar, cacheTime };
    }

    static registerLocalImageConfig() {
        seal.ext.registerTemplateConfig(this.ext, "本地图片路径", ['<海豹>data/images/sealdice.png'], "如不需要可以不填写，尖括号内是图片的名称，便于AI调用，修改完需要重载js");
    }
    static getLocalImageConfig() {
        const images = seal.ext.getTemplateConfig(this.ext, "本地图片路径");
        const localImages = images.reduce((acc: { [key: string]: string }, item: string) => {
            const match = item.match(/<(.+)>.*/);
            if (match !== null) {
                const key = match[1];
                acc[key] = item.replace(/<.*>/g, '');
            }
            return acc;
        }, {});

        return { localImages };
    }

    static registerImageConditionConfig() {
        seal.ext.registerStringConfig(this.ext, "图片识别需要满足的条件", '1', "使用豹语表达式，例如：$t群号_RAW=='2001'");
    }
    static getImageConditionConfig() {
        const condition = seal.ext.getStringConfig(this.ext, "图片识别需要满足的条件");
        return { condition };
    }

    static registerImageProbabilityConfig() {
        seal.ext.registerIntConfig(this.ext, "发送图片的概率/%", 100);
    }
    static getImageProbabilityConfig() {
        const p = seal.ext.getIntConfig(this.ext, "发送图片的概率/%");
        return { p };
    }

    static registerImageRequestConfig() {
        seal.ext.registerStringConfig(this.ext, "图片大模型URL", "https://open.bigmodel.cn/api/paas/v4/chat/completions");
        seal.ext.registerStringConfig(this.ext, "图片API key", "yours");
        seal.ext.registerTemplateConfig(this.ext, "图片body", [
            `"messages":null`,
            `"model":"glm-4v"`,
            `"max_tokens":100`,
            `"stop":null`,
            `"stream":false`,
        ], "messages将会自动替换")
        seal.ext.registerIntConfig(this.ext, "图片最大回复字符数", 100);
    }
    static getImageRequestConfig() {
        const url = seal.ext.getStringConfig(this.ext, "图片大模型URL");
        const apiKey = seal.ext.getStringConfig(this.ext, "图片API key");
        const maxChars = seal.ext.getIntConfig(this.ext, "图片最大回复字符数");
        const bodyTemplate = seal.ext.getTemplateConfig(this.ext, "图片body");

        return { url, apiKey, maxChars, bodyTemplate };
    }

    static registerImageTriggerConfig() {
        seal.ext.registerStringConfig(this.ext, "图片非指令触发需要满足的条件", '1', "使用豹语表达式，例如：$t群号_RAW=='2001'");
        seal.ext.registerTemplateConfig(this.ext, "图片非指令关键词", ["咪"], "包含关键词将进行回复");
    }
    static getImageTriggerConfig(s: string) {
        const condition = seal.ext.getStringConfig(this.ext, "图片非指令触发需要满足的条件");
        const keyWords = seal.ext.getTemplateConfig(this.ext, "图片非指令关键词");
        const trigger = keyWords.some(item => s.includes(item));

        return { condition, trigger };
    }

    static registerImageStorageConfig() {
        seal.ext.registerIntConfig(this.ext, "偷取图片存储上限", 30, "每个群聊或私聊单独储存");
    }
    static getImageStorageConfig() {
        const maxImageNum = seal.ext.getIntConfig(this.ext, "偷取图片存储上限");
        return { maxImageNum };
    }
}

