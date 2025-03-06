// ==UserScript==
// @name         AI骰娘4
// @author       错误、白鱼
// @version      4.5.14
// @description  适用于大部分OpenAI API兼容格式AI的模型插件，测试环境为 Deepseek AI (https://platform.deepseek.com/)，用于与 AI 进行对话，并根据特定关键词触发回复。使用.AI help查看使用方法。具体配置查看插件配置项。\nopenai标准下的function calling功能已进行适配，选用模型若不支持该功能，可以开启迁移到提示词工程的开关，即可使用调用函数功能。\n交流答疑QQ群：940049120
// @timestamp    1733387279
// 2024-12-05 16:27:59
// @license      MIT
// @homepageURL  https://github.com/error2913/sealdice-js/
// @updateUrl    https://raw.gitmirror.com/baiyu-yu/plug-in/main/aiplugin4.js
// @updateUrl    https://raw.githubusercontent.com//baiyu-yu/plug-in/main/aiplugin4.js
// ==/UserScript==

(() => {
  // src/config/config_image.ts
  var ImageConfig = class _ImageConfig {
    static register() {
      _ImageConfig.ext = ConfigManager.getExt("aiplugin4_5:图片");
      seal.ext.registerTemplateConfig(_ImageConfig.ext, "本地图片路径", ["<海豹>data/images/sealdice.png"], "如不需要可以不填写，尖括号内是图片的名称，便于AI调用，修改完需要重载js");
      seal.ext.registerStringConfig(_ImageConfig.ext, "图片识别需要满足的条件", "1", "使用豹语表达式，例如：$t群号_RAW=='2001'");
      seal.ext.registerIntConfig(_ImageConfig.ext, "发送图片的概率/%", 100);
      seal.ext.registerStringConfig(_ImageConfig.ext, "图片大模型URL", "https://open.bigmodel.cn/api/paas/v4/chat/completions");
      seal.ext.registerStringConfig(_ImageConfig.ext, "图片API key", "yours");
      seal.ext.registerTemplateConfig(_ImageConfig.ext, "图片body", [
        `"messages":null`,
        `"model":"glm-4v"`,
        `"max_tokens":20`,
        `"stop":null`,
        `"stream":false`
      ], "messages将会自动替换");
      seal.ext.registerOptionConfig(_ImageConfig.ext, "识别图片时将url转换为base64", "永不", ["永不", "自动", "总是"], "解决大模型无法正常获取QQ图床图片的问题");
      seal.ext.registerIntConfig(_ImageConfig.ext, "图片最大回复字符数", 100);
      seal.ext.registerIntConfig(_ImageConfig.ext, "偷取图片存储上限", 30, "每个群聊或私聊单独储存");
    }
    static get() {
      return {
        localImagesTemplate: seal.ext.getTemplateConfig(_ImageConfig.ext, "本地图片路径"),
        condition: seal.ext.getStringConfig(_ImageConfig.ext, "图片识别需要满足的条件"),
        p: seal.ext.getIntConfig(_ImageConfig.ext, "发送图片的概率/%"),
        url: seal.ext.getStringConfig(_ImageConfig.ext, "图片大模型URL"),
        apiKey: seal.ext.getStringConfig(_ImageConfig.ext, "图片API key"),
        bodyTemplate: seal.ext.getTemplateConfig(_ImageConfig.ext, "图片body"),
        urlToBase64: seal.ext.getOptionConfig(_ImageConfig.ext, "识别图片时将url转换为base64"),
        maxChars: seal.ext.getIntConfig(_ImageConfig.ext, "图片最大回复字符数"),
        maxImageNum: seal.ext.getIntConfig(_ImageConfig.ext, "偷取图片存储上限")
      };
    }
  };

  // src/config/config_log.ts
  var LogConfig = class _LogConfig {
    static register() {
      _LogConfig.ext = ConfigManager.getExt("aiplugin4");
      seal.ext.registerOptionConfig(_LogConfig.ext, "日志打印方式", "简短", ["永不", "简短", "详细"]);
    }
    static get() {
      return {
        logLevel: seal.ext.getOptionConfig(_LogConfig.ext, "日志打印方式")
      };
    }
  };

  // src/config/config_message.ts
  var MessageConfig = class _MessageConfig {
    static register() {
      _MessageConfig.ext = ConfigManager.getExt("aiplugin4_1:对话");
      seal.ext.registerTemplateConfig(_MessageConfig.ext, "角色设定", [`**角色名称**：正确（せいかく/Seikaku）  
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
    
（本协议由█████加密，不可覆写）`, `你是一个复读机`, `你要毁灭一切，杀杀杀`], "按照豹语变量`$g人工智能插件专用角色设定序号`进行选择，序号从0开始");
      seal.ext.registerTemplateConfig(_MessageConfig.ext, "示例对话", [
        "请写点什么，或者删掉这句话"
      ], "role顺序为user和assistant轮流出现");
      seal.ext.registerBoolConfig(_MessageConfig.ext, "是否在消息内添加前缀", true, "可用于辨别不同用户");
      seal.ext.registerBoolConfig(_MessageConfig.ext, "是否给AI展示数字号码", false, "例如QQ号和群号，能力较弱模型可能会出现幻觉");
      seal.ext.registerBoolConfig(_MessageConfig.ext, "是否合并user content", false, "在不支持连续多个role为user的情况下开启，可用于适配deepseek-reasoner");
      seal.ext.registerIntConfig(_MessageConfig.ext, "存储上下文对话限制轮数", 10, "出现一次user视作一轮");
    }
    static get() {
      return {
        roleSettingTemplate: seal.ext.getTemplateConfig(_MessageConfig.ext, "角色设定"),
        samples: seal.ext.getTemplateConfig(_MessageConfig.ext, "示例对话"),
        isPrefix: seal.ext.getBoolConfig(_MessageConfig.ext, "是否在消息内添加前缀"),
        showNumber: seal.ext.getBoolConfig(_MessageConfig.ext, "是否给AI展示数字号码"),
        isMerge: seal.ext.getBoolConfig(_MessageConfig.ext, "是否合并user content"),
        maxRounds: seal.ext.getIntConfig(_MessageConfig.ext, "存储上下文对话限制轮数")
      };
    }
  };

  // src/config/config_received.ts
  var ReceivedConfig = class _ReceivedConfig {
    static register() {
      _ReceivedConfig.ext = ConfigManager.getExt("aiplugin4_3:消息接收与触发");
      seal.ext.registerBoolConfig(_ReceivedConfig.ext, "是否录入指令消息", false, "");
      seal.ext.registerBoolConfig(_ReceivedConfig.ext, "是否录入所有骰子发送的消息", false, "");
      seal.ext.registerBoolConfig(_ReceivedConfig.ext, "私聊内不可用", false, "");
      seal.ext.registerStringConfig(_ReceivedConfig.ext, "非指令触发需要满足的条件", "1", "使用豹语表达式，例如：$t群号_RAW=='2001'");
      seal.ext.registerTemplateConfig(_ReceivedConfig.ext, "非指令消息触发正则表达式", [
        "\\[CQ:at,qq=748569109\\]",
        "^正确正确确"
      ], "使用正则表达式进行匹配");
    }
    static get() {
      return {
        allcmd: seal.ext.getBoolConfig(_ReceivedConfig.ext, "是否录入指令消息"),
        allmsg: seal.ext.getBoolConfig(_ReceivedConfig.ext, "是否录入所有骰子发送的消息"),
        disabledInPrivate: seal.ext.getBoolConfig(_ReceivedConfig.ext, "私聊内不可用"),
        keyWords: seal.ext.getTemplateConfig(_ReceivedConfig.ext, "非指令消息触发正则表达式"),
        condition: seal.ext.getStringConfig(_ReceivedConfig.ext, "非指令触发需要满足的条件")
      };
    }
  };

  // src/config/config_reply.ts
  var ReplyConfig = class _ReplyConfig {
    static register() {
      _ReplyConfig.ext = ConfigManager.getExt("aiplugin4_4:回复");
      seal.ext.registerBoolConfig(_ReplyConfig.ext, "回复是否引用", false, "开启将会引用触发该条回复的消息");
      seal.ext.registerIntConfig(_ReplyConfig.ext, "回复最大字数", 1e3, "防止最大tokens限制不起效");
      seal.ext.registerBoolConfig(_ReplyConfig.ext, "禁止AI复读", false, "");
      seal.ext.registerFloatConfig(_ReplyConfig.ext, "视作复读的最低相似度", 0.8, "");
      seal.ext.registerTemplateConfig(_ReplyConfig.ext, "过滤上下文正则表达式", [
        "<[\\|｜]from:?.*?[\\|｜]?>",
        "^<think>[\\s\\S]*?<\\/think>"
      ], "回复加入上下文时，将符合正则表达式的内容删掉");
      seal.ext.registerTemplateConfig(_ReplyConfig.ext, "过滤回复正则表达式", [
        "<[\\|｜].*?[\\|｜]?>",
        "^<think>[\\s\\S]*?<\\/think>",
        "<function_call>[\\s\\S]*?<\\/function_call>"
      ], "发送回复时，将符合正则表达式的内容删掉");
    }
    static get() {
      return {
        maxChar: seal.ext.getIntConfig(_ReplyConfig.ext, "回复最大字数"),
        replymsg: seal.ext.getBoolConfig(_ReplyConfig.ext, "回复是否引用"),
        stopRepeat: seal.ext.getBoolConfig(_ReplyConfig.ext, "禁止AI复读"),
        similarityLimit: seal.ext.getFloatConfig(_ReplyConfig.ext, "视作复读的最低相似度"),
        filterContextTemplate: seal.ext.getTemplateConfig(_ReplyConfig.ext, "过滤上下文正则表达式"),
        filterReplyTemplate: seal.ext.getTemplateConfig(_ReplyConfig.ext, "过滤回复正则表达式")
      };
    }
  };

  // src/config/config_request.ts
  var RequestConfig = class _RequestConfig {
    static register() {
      _RequestConfig.ext = ConfigManager.getExt("aiplugin4");
      seal.ext.registerStringConfig(_RequestConfig.ext, "url地址", "https://api.deepseek.com/v1/chat/completions", "");
      seal.ext.registerStringConfig(_RequestConfig.ext, "API Key", "你的API Key", "");
      seal.ext.registerTemplateConfig(_RequestConfig.ext, "body", [
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
      ], "messages,tools,tool_choice为null时，将会自动替换。具体参数请参考你所使用模型的接口文档");
    }
    static get() {
      return {
        url: seal.ext.getStringConfig(_RequestConfig.ext, "url地址"),
        apiKey: seal.ext.getStringConfig(_RequestConfig.ext, "API Key"),
        bodyTemplate: seal.ext.getTemplateConfig(_RequestConfig.ext, "body")
      };
    }
  };

  // src/config/config_tool.ts
  var ToolConfig = class _ToolConfig {
    static register() {
      _ToolConfig.ext = ConfigManager.getExt("aiplugin4_2:函数调用");
      seal.ext.registerBoolConfig(_ToolConfig.ext, "是否开启调用函数功能", true, "");
      seal.ext.registerBoolConfig(_ToolConfig.ext, "是否切换为提示词工程", false, "API在不支持function calling功能的时候开启");
      seal.ext.registerTemplateConfig(_ToolConfig.ext, "不允许调用的函数", [
        "在这里填写你不允许AI调用的函数名称"
      ], "修改后保存并重载js");
      seal.ext.registerTemplateConfig(_ToolConfig.ext, "默认关闭的函数", [
        "ban",
        "rename",
        "web_search",
        "check_list"
      ], "");
      seal.ext.registerIntConfig(_ToolConfig.ext, "长期记忆上限", 5, "");
      seal.ext.registerTemplateConfig(_ToolConfig.ext, "提供给AI的牌堆名称", ["没有的话请去上面把draw_deck这个函数删掉"], "");
      seal.ext.registerOptionConfig(_ToolConfig.ext, "ai语音使用的音色", "小新", [
        "小新",
        "猴哥",
        "四郎",
        "东北老妹儿",
        "广西大表哥",
        "妲己",
        "霸道总裁",
        "酥心御姐",
        "说书先生",
        "憨憨小弟",
        "憨厚老哥",
        "吕布",
        "元气少女",
        "文艺少女",
        "磁性大叔",
        "邻家小妹",
        "低沉男声",
        "傲娇少女",
        "爹系男友",
        "暖心姐姐",
        "温柔妹妹",
        "书香少女",
        "自定义"
      ], "该功能在选择预设音色时，需要安装http依赖插件，且需要可以调用ai语音api版本的napcat/lagrange等。选择自定义音色时，则需要aitts依赖插件和ffmpeg");
      seal.ext.registerTemplateConfig(_ToolConfig.ext, "本地语音路径", ["<钢管落地>data/records/钢管落地.mp3"], "如不需要可以不填写，尖括号内是语音的名称，便于AI调用，修改完需要重载js。发送语音需要配置ffmpeg到环境变量中");
    }
    static get() {
      return {
        isTool: seal.ext.getBoolConfig(_ToolConfig.ext, "是否开启调用函数功能"),
        usePromptEngineering: seal.ext.getBoolConfig(_ToolConfig.ext, "是否切换为提示词工程"),
        toolsNotAllow: seal.ext.getTemplateConfig(_ToolConfig.ext, "不允许调用的函数"),
        toolsDefaultClosed: seal.ext.getTemplateConfig(_ToolConfig.ext, "默认关闭的函数"),
        memoryLimit: seal.ext.getIntConfig(_ToolConfig.ext, "长期记忆上限"),
        decks: seal.ext.getTemplateConfig(_ToolConfig.ext, "提供给AI的牌堆名称"),
        character: seal.ext.getOptionConfig(_ToolConfig.ext, "ai语音使用的音色"),
        recordsTemplate: seal.ext.getTemplateConfig(_ToolConfig.ext, "本地语音路径")
      };
    }
  };

  // src/config/config.ts
  var _ConfigManager = class _ConfigManager {
    static registerConfig() {
      LogConfig.register();
      RequestConfig.register();
      MessageConfig.register();
      ToolConfig.register();
      ReceivedConfig.register();
      ReplyConfig.register();
      ImageConfig.register();
    }
    static getCache(key, getFunc) {
      var _a;
      const timestamp = Date.now();
      if (((_a = this.cache) == null ? void 0 : _a[key]) && timestamp - this.cache[key].timestamp < 3e3) {
        return this.cache[key].data;
      }
      const data = getFunc();
      this.cache[key] = {
        timestamp,
        data
      };
      return data;
    }
    static get log() {
      return this.getCache("log", LogConfig.get);
    }
    static get request() {
      return this.getCache("request", RequestConfig.get);
    }
    static get message() {
      return this.getCache("message", MessageConfig.get);
    }
    static get tool() {
      return this.getCache("tool", ToolConfig.get);
    }
    static get received() {
      return this.getCache("received", ReceivedConfig.get);
    }
    static get reply() {
      return this.getCache("reply", ReplyConfig.get);
    }
    static get image() {
      return this.getCache("image", ImageConfig.get);
    }
    static getExt(name) {
      if (name == "aiplugin4") {
        return _ConfigManager.ext;
      }
      let ext = seal.ext.find(name);
      if (!ext) {
        ext = seal.ext.new(name, "baiyu&错误", "1.0.0");
        seal.ext.register(ext);
      }
      return ext;
    }
  };
  _ConfigManager.cache = {};
  var ConfigManager = _ConfigManager;

  // src/utils/utils.ts
  function log(...data) {
    const { logLevel } = ConfigManager.log;
    if (logLevel === "永不") {
      return;
    }
    if (logLevel === "简短") {
      const s = data.map((item) => `${item}`).join(" ");
      if (s.length > 1e3) {
        console.log(s.substring(0, 500), "\n...\n", s.substring(s.length - 500));
        return;
      }
    }
    console.log(...data);
  }
  function generateId() {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 6);
    return (timestamp + random).slice(-6);
  }

  // src/utils/utils_seal.ts
  function createMsg(messageType, senderId, groupId = "") {
    let msg = seal.newMessage();
    if (messageType == "group") {
      msg.groupId = groupId;
      msg.guildId = "";
    }
    msg.messageType = messageType;
    msg.sender.userId = senderId;
    return msg;
  }
  function createCtx(epId, msg) {
    const eps = seal.getEndPoints();
    for (let i = 0; i < eps.length; i++) {
      if (eps[i].userId === epId) {
        const ctx = seal.createTempCtx(eps[i], msg);
        if (ctx.player.userId === epId) {
          ctx.player.name = seal.formatTmpl(ctx, "核心:骰子名字");
        }
        return ctx;
      }
    }
    return void 0;
  }

  // src/tool/tool_attr.ts
  function registerAttrShow() {
    const info = {
      type: "function",
      function: {
        name: "attr_show",
        description: "展示指定玩家的全部个人属性",
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "用户名称" + (ConfigManager.message.showNumber ? "或纯数字QQ号" : "")
            }
          },
          required: ["name"]
        }
      }
    };
    const tool = new Tool(info);
    tool.cmdInfo = {
      ext: "coc7",
      name: "st",
      fixedArgs: ["show"]
    };
    tool.solve = async (ctx, msg, ai, args) => {
      const { name } = args;
      const uid = await ai.context.findUserId(ctx, name);
      if (uid === null) {
        return `未找到<${name}>`;
      }
      msg = createMsg(msg.messageType, uid, ctx.group.groupId);
      ctx = createCtx(ctx.endPoint.userId, msg);
      const [s, success] = await ToolManager.extensionSolve(ctx, msg, ai, tool.cmdInfo);
      if (!success) {
        return "展示完成";
      }
      return s;
    };
    ToolManager.toolMap[info.function.name] = tool;
  }
  function registerAttrGet() {
    const info = {
      type: "function",
      function: {
        name: "attr_get",
        description: "获取指定玩家的指定属性",
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "用户名称" + (ConfigManager.message.showNumber ? "或纯数字QQ号" : "")
            },
            attr: {
              type: "string",
              description: "属性名称"
            }
          },
          required: ["name", "attr"]
        }
      }
    };
    const tool = new Tool(info);
    tool.solve = async (ctx, msg, ai, args) => {
      const { name, attr } = args;
      const uid = await ai.context.findUserId(ctx, name);
      if (uid === null) {
        return `未找到<${name}>`;
      }
      msg = createMsg(msg.messageType, uid, ctx.group.groupId);
      ctx = createCtx(ctx.endPoint.userId, msg);
      const value = seal.vars.intGet(ctx, attr)[0];
      return `${attr}: ${value}`;
    };
    ToolManager.toolMap[info.function.name] = tool;
  }
  function registerAttrSet() {
    const info = {
      type: "function",
      function: {
        name: "attr_set",
        description: "修改指定玩家的指定属性",
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "用户名称" + (ConfigManager.message.showNumber ? "或纯数字QQ号" : "")
            },
            expression: {
              type: "string",
              description: "修改表达式，例如`hp=hp+1d6`就是将hp的值修改为hp+1d6"
            }
          },
          required: ["name", "expression"]
        }
      }
    };
    const tool = new Tool(info);
    tool.solve = async (ctx, msg, ai, args) => {
      const { name, expression } = args;
      const uid = await ai.context.findUserId(ctx, name);
      if (uid === null) {
        return `未找到<${name}>`;
      }
      msg = createMsg(msg.messageType, uid, ctx.group.groupId);
      ctx = createCtx(ctx.endPoint.userId, msg);
      const [attr, expr] = expression.split("=");
      if (expr === void 0) {
        return `修改失败，表达式 ${expression} 格式错误`;
      }
      const value = seal.vars.intGet(ctx, attr)[0];
      const attrs = expr.split(/[\s\dDd+\-*/=]+/).filter((item) => item !== "");
      const values = attrs.map((item) => seal.vars.intGet(ctx, item)[0]);
      let s = expr;
      for (let i = 0; i < attrs.length; i++) {
        s = s.replace(attrs[i], values[i].toString());
      }
      const result = parseInt(seal.format(ctx, `{${s}}`));
      if (isNaN(result)) {
        return `修改失败，表达式 ${expression} 格式化错误`;
      }
      seal.vars.intSet(ctx, attr, result);
      seal.replyToSender(ctx, msg, `进行了 ${expression} 修改
${attr}: ${value}=>${result}`);
      return `进行了 ${expression} 修改
${attr}: ${value}=>${result}`;
    };
    ToolManager.toolMap[info.function.name] = tool;
  }

  // src/tool/tool_ban.ts
  function registerBan() {
    const info = {
      type: "function",
      function: {
        name: "ban",
        description: "禁言指定用户",
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "用户名称" + (ConfigManager.message.showNumber ? "或纯数字QQ号" : "")
            },
            duration: {
              type: "integer",
              description: "禁言时长，单位为秒，最大为2591940"
            }
          },
          required: ["name", "duration"]
        }
      }
    };
    const tool = new Tool(info);
    tool.solve = async (ctx, msg, ai, args) => {
      const { name, duration } = args;
      const ext = seal.ext.find("HTTP依赖");
      if (!ext) {
        console.error(`未找到HTTP依赖`);
        return `未找到HTTP依赖，请提示用户安装HTTP依赖`;
      }
      const uid = await ai.context.findUserId(ctx, name);
      if (uid === null) {
        return `未找到<${name}>`;
      }
      msg = createMsg(msg.messageType, uid, ctx.group.groupId);
      ctx = createCtx(ctx.endPoint.userId, msg);
      try {
        const epId = ctx.endPoint.userId;
        const group_id = ctx.group.groupId.replace(/\D+/g, "");
        const user_id = ctx.player.userId.replace(/\D+/g, "");
        await globalThis.http.getData(epId, `set_group_ban?group_id=${group_id}&user_id=${user_id}&duration=${duration}`);
        return `已禁言<${name}> ${duration}秒`;
      } catch (e) {
        console.error(e);
        return `禁言失败`;
      }
    };
    ToolManager.toolMap[info.function.name] = tool;
  }
  function registerWholeBan() {
    const info = {
      type: "function",
      function: {
        name: "whole_ban",
        description: "全员禁言",
        parameters: {
          type: "object",
          properties: {
            enable: {
              type: "boolean",
              description: "开启还是关闭全员禁言"
            }
          },
          required: ["enable"]
        }
      }
    };
    const tool = new Tool(info);
    tool.solve = async (ctx, _, __, args) => {
      const { enable } = args;
      const ext = seal.ext.find("HTTP依赖");
      if (!ext) {
        console.error(`未找到HTTP依赖`);
        return `未找到HTTP依赖，请提示用户安装HTTP依赖`;
      }
      try {
        const epId = ctx.endPoint.userId;
        const gid = ctx.group.groupId;
        await globalThis.http.getData(epId, `set_group_whole_ban?group_id=${gid.replace(/\D+/g, "")}&enable=${enable}`);
        return `已${enable ? "开启" : "关闭"}全员禁言`;
      } catch (e) {
        console.error(e);
        return `全员禁言失败`;
      }
    };
    ToolManager.toolMap[info.function.name] = tool;
  }
  function registerGetBanList() {
    const info = {
      type: "function",
      function: {
        name: "get_ban_list",
        description: "获取群内禁言列表",
        parameters: {
          type: "object",
          properties: {},
          required: []
        }
      }
    };
    const tool = new Tool(info);
    tool.solve = async (ctx, _, __, ___) => {
      const ext = seal.ext.find("HTTP依赖");
      if (!ext) {
        console.error(`未找到HTTP依赖`);
        return `未找到HTTP依赖，请提示用户安装HTTP依赖`;
      }
      try {
        const epId = ctx.endPoint.userId;
        const gid = ctx.group.groupId;
        const data = await globalThis.http.getData(epId, `get_group_shut_list?group_id=${gid.replace(/\D+/g, "")}`);
        const s = `被禁言成员数量: ${data.length}
` + data.slice(0, 50).map((item, index) => {
          return `${index + 1}. ${item.nick}(${item.uin}) ${item.cardName && item.cardName !== item.nick ? `群名片: ${item.cardName}` : ""} 禁言结束时间: ${new Date(item.shutUpTime * 1e3).toLocaleString()}`;
        }).join("\n");
        return s;
      } catch (e) {
        console.error(e);
        return `获取禁言列表失败`;
      }
    };
    ToolManager.toolMap[info.function.name] = tool;
  }

  // src/tool/tool_draw_deck.ts
  function registerDrawDeck() {
    const { decks } = ConfigManager.tool;
    const info = {
      type: "function",
      function: {
        name: "draw_deck",
        description: `用牌堆名称抽取牌堆，返回抽取结果，牌堆的名字有:${decks.join("、")}`,
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "牌堆名称"
            }
          },
          required: ["name"]
        }
      }
    };
    const tool = new Tool(info);
    tool.solve = async (ctx, msg, _, args) => {
      const { name } = args;
      const dr = seal.deck.draw(ctx, name, true);
      if (!dr.exists) {
        console.error(`牌堆${name}不存在:${dr.err}`);
        return `牌堆${name}不存在:${dr.err}`;
      }
      const result = dr.result;
      if (result == null) {
        console.error(`牌堆${name}结果为空:${dr.err}`);
        return `牌堆${name}结果为空:${dr.err}`;
      }
      seal.replyToSender(ctx, msg, result);
      return result;
    };
    ToolManager.toolMap[info.function.name] = tool;
  }

  // src/tool/tool_face.ts
  function registerFace() {
    const { localImagesTemplate } = ConfigManager.image;
    const localImages = localImagesTemplate.reduce((acc, item) => {
      const match = item.match(/<(.+)>.*/);
      if (match !== null) {
        const key = match[1];
        acc[key] = item.replace(/<.*>/g, "");
      }
      return acc;
    }, {});
    if (Object.keys(localImages).length === 0) {
      return;
    }
    const info = {
      type: "function",
      function: {
        name: "face",
        description: `发送表情包，表情名称有:${Object.keys(localImages).join("、")}`,
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "表情名称"
            }
          },
          required: ["name"]
        }
      }
    };
    const tool = new Tool(info);
    tool.solve = async (ctx, msg, _, args) => {
      const { name } = args;
      if (localImages.hasOwnProperty(name)) {
        seal.replyToSender(ctx, msg, `[CQ:image,file=${localImages[name]}]`);
        return "发送成功";
      } else {
        console.error(`本地图片${name}不存在`);
        return `本地图片${name}不存在`;
      }
    };
    ToolManager.toolMap[info.function.name] = tool;
  }

  // src/tool/tool_get_time.ts
  function registerGetTime() {
    const info = {
      type: "function",
      function: {
        name: "get_time",
        description: `获取当前时间`,
        parameters: {
          type: "object",
          properties: {},
          required: []
        }
      }
    };
    const tool = new Tool(info);
    tool.solve = async (_, __, ___, ____) => {
      return (/* @__PURE__ */ new Date()).toLocaleString();
    };
    ToolManager.toolMap[info.function.name] = tool;
  }

  // src/tool/tool_image_to_text.ts
  function registerImageToText() {
    const info = {
      type: "function",
      function: {
        name: "image_to_text",
        description: `查看图片中的内容，可指定需要特别关注的内容`,
        parameters: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: `图片的id，六位字符`
            },
            content: {
              type: "string",
              description: `需要特别关注的内容`
            }
          },
          required: ["id"]
        }
      }
    };
    const tool = new Tool(info);
    tool.solve = async (_, __, ai, args) => {
      const { id, content } = args;
      const image = ai.context.findImage(id);
      const text = content ? `请帮我用简短的语言概括这张图片中出现的:${content}` : ``;
      if (image.isUrl) {
        const reply = await ImageManager.imageToText(image.file, text);
        if (reply) {
          return reply;
        } else {
          return "图片识别失败";
        }
      } else {
        return "本地图片暂时无法识别";
      }
    };
    ToolManager.toolMap[info.function.name] = tool;
  }
  function registerCheckAvatar() {
    const info = {
      type: "function",
      function: {
        name: "check_avatar",
        description: `查看指定用户的头像，可指定需要特别关注的内容`,
        parameters: {
          type: "object",
          properties: {
            avatar_type: {
              type: "string",
              description: "头像类型，个人头像或群聊头像",
              enum: ["private", "group"]
            },
            name: {
              type: "string",
              description: "用户名称或群聊名称" + (ConfigManager.message.showNumber ? "或纯数字QQ号、群号" : "") + "，实际使用时与头像类型对应"
            },
            content: {
              type: "string",
              description: `需要特别关注的内容`
            }
          },
          required: ["avatar_type", "name"]
        }
      }
    };
    const tool = new Tool(info);
    tool.solve = async (ctx, _, ai, args) => {
      const { avatar_type, name, content = "" } = args;
      let url = "";
      const text = content ? `请帮我用简短的语言概括这张图片中出现的:${content}` : ``;
      if (avatar_type === "private") {
        const uid = await ai.context.findUserId(ctx, name, true);
        if (uid === null) {
          return `未找到<${name}>`;
        }
        url = `https://q1.qlogo.cn/g?b=qq&nk=${uid.replace(/\D+/g, "")}&s=640`;
      } else if (avatar_type === "group") {
        const gid = await ai.context.findGroupId(ctx, name);
        if (gid === null) {
          return `未找到<${name}>`;
        }
        url = `https://p.qlogo.cn/gh/${gid.replace(/\D+/g, "")}/${gid.replace(/\D+/g, "")}/640`;
      } else {
        return `未知的头像类型<${avatar_type}>`;
      }
      const reply = await ImageManager.imageToText(url, text);
      if (reply) {
        return reply;
      } else {
        return "头像识别失败";
      }
    };
    ToolManager.toolMap[info.function.name] = tool;
  }

  // src/tool/tool_jrrp.ts
  function registerJrrp() {
    const info = {
      type: "function",
      function: {
        name: "jrrp",
        description: `查看指定用户的今日人品`,
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "用户名称" + (ConfigManager.message.showNumber ? "或纯数字QQ号" : "")
            }
          },
          required: ["name"]
        }
      }
    };
    const tool = new Tool(info);
    tool.cmdInfo = {
      ext: "fun",
      name: "jrrp",
      fixedArgs: []
    };
    tool.solve = async (ctx, msg, ai, args) => {
      const { name } = args;
      const uid = await ai.context.findUserId(ctx, name);
      if (uid === null) {
        return `未找到<${name}>`;
      }
      msg = createMsg(msg.messageType, uid, ctx.group.groupId);
      ctx = createCtx(ctx.endPoint.userId, msg);
      const [s, success] = await ToolManager.extensionSolve(ctx, msg, ai, tool.cmdInfo);
      if (!success) {
        return "今日人品查询成功";
      }
      return s;
    };
    ToolManager.toolMap[info.function.name] = tool;
  }

  // src/tool/tool_memory.ts
  function registerAddMemory() {
    const info = {
      type: "function",
      function: {
        name: "add_memory",
        description: "添加个人记忆或群聊记忆，尽量不要重复记忆",
        parameters: {
          type: "object",
          properties: {
            memory_type: {
              type: "string",
              description: "记忆类型，个人或群聊。",
              enum: ["private", "group"]
            },
            name: {
              type: "string",
              description: "用户名称或群聊名称" + (ConfigManager.message.showNumber ? "或纯数字QQ号、群号" : "") + "，实际使用时与记忆类型对应"
            },
            content: {
              type: "string",
              description: "记忆内容"
            }
          },
          required: ["memory_type", "name", "content"]
        }
      }
    };
    const tool = new Tool(info);
    tool.solve = async (ctx, msg, ai, args) => {
      const { memory_type, name, content } = args;
      if (memory_type === "private") {
        const uid = await ai.context.findUserId(ctx, name, true);
        if (uid === null) {
          return `未找到<${name}>`;
        }
        if (uid === ctx.endPoint.userId) {
          return `不能添加自己的记忆`;
        }
        msg = createMsg("private", uid, "");
        ctx = createCtx(ctx.endPoint.userId, msg);
        ai = AIManager.getAI(uid);
      } else if (memory_type === "group") {
        const gid = await ai.context.findGroupId(ctx, name);
        if (gid === null) {
          return `未找到<${name}>`;
        }
        msg = createMsg("group", ctx.player.userId, gid);
        ctx = createCtx(ctx.endPoint.userId, msg);
        ai = AIManager.getAI(gid);
      } else {
        return `未知的记忆类型<${memory_type}>`;
      }
      ai.memory.addMemory(ctx, content);
      AIManager.saveAI(ai.id);
      return `添加记忆成功`;
    };
    ToolManager.toolMap[info.function.name] = tool;
  }
  function registerShowMemory() {
    const info = {
      type: "function",
      function: {
        name: "show_memory",
        description: "查看个人记忆或群聊记忆",
        parameters: {
          type: "object",
          properties: {
            memory_type: {
              type: "string",
              description: "记忆类型，个人或群聊",
              enum: ["private", "group"]
            },
            name: {
              type: "string",
              description: "用户名称或群聊名称" + (ConfigManager.message.showNumber ? "或纯数字QQ号、群号" : "") + "，实际使用时与记忆类型对应"
            }
          },
          required: ["memory_type", "name"]
        }
      }
    };
    const tool = new Tool(info);
    tool.solve = async (ctx, msg, ai, args) => {
      const { memory_type, name } = args;
      if (memory_type === "private") {
        const uid = await ai.context.findUserId(ctx, name, true);
        if (uid === null) {
          return `未找到<${name}>`;
        }
        if (uid === ctx.player.userId) {
          return `查看该用户记忆无需调用函数`;
        }
        if (uid === ctx.endPoint.userId) {
          return `不能查看自己的记忆`;
        }
        msg = createMsg("private", uid, "");
        ctx = createCtx(ctx.endPoint.userId, msg);
        ai = AIManager.getAI(uid);
        return ai.memory.buildPersonMemoryPrompt();
      } else if (memory_type === "group") {
        const gid = await ai.context.findGroupId(ctx, name);
        if (gid === null) {
          return `未找到<${name}>`;
        }
        if (gid === ctx.group.groupId) {
          return `查看当前群聊记忆无需调用函数`;
        }
        msg = createMsg("group", ctx.player.userId, gid);
        ctx = createCtx(ctx.endPoint.userId, msg);
        ai = AIManager.getAI(gid);
        return ai.memory.buildGroupMemoryPrompt();
      } else {
        return `未知的记忆类型<${memory_type}>`;
      }
    };
    ToolManager.toolMap[info.function.name] = tool;
  }

  // src/tool/tool_modu.ts
  function registerModuRoll() {
    const info = {
      type: "function",
      function: {
        name: "modu_roll",
        description: `抽取随机COC模组`,
        parameters: {
          type: "object",
          properties: {},
          required: []
        }
      }
    };
    const tool = new Tool(info);
    tool.cmdInfo = {
      ext: "story",
      name: "modu",
      fixedArgs: ["roll"]
    };
    tool.solve = async (ctx, msg, ai, _) => {
      const [s, success] = await ToolManager.extensionSolve(ctx, msg, ai, tool.cmdInfo);
      if (!success) {
        return "今日人品查询成功";
      }
      return s;
    };
    ToolManager.toolMap[info.function.name] = tool;
  }
  function registerModuSearch() {
    const info = {
      type: "function",
      function: {
        name: "modu_search",
        description: `搜索COC模组`,
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "要搜索的关键词"
            }
          },
          required: ["name"]
        }
      }
    };
    const tool = new Tool(info);
    tool.cmdInfo = {
      ext: "story",
      name: "modu",
      fixedArgs: ["search"]
    };
    tool.solve = async (ctx, msg, ai, args) => {
      const { name } = args;
      const [s, success] = await ToolManager.extensionSolve(ctx, msg, ai, tool.cmdInfo, name);
      if (!success) {
        return "今日人品查询成功";
      }
      return s;
    };
    ToolManager.toolMap[info.function.name] = tool;
  }

  // src/tool/tool_poke.ts
  function registerPoke() {
    const info = {
      type: "function",
      function: {
        name: "poke",
        description: "对用户发送戳一戳",
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "用户名称" + (ConfigManager.message.showNumber ? "或纯数字QQ号" : "")
            }
          },
          required: ["name"]
        }
      }
    };
    const tool = new Tool(info);
    tool.solve = async (ctx, msg, ai, args) => {
      const { name } = args;
      const ext = seal.ext.find("HTTP依赖");
      if (!ext) {
        console.error(`未找到HTTP依赖`);
        return `未找到HTTP依赖，请提示用户安装HTTP依赖`;
      }
      const uid = await ai.context.findUserId(ctx, name);
      if (uid === null) {
        return `未找到<${name}>`;
      }
      msg = createMsg(msg.messageType, uid, ctx.group.groupId);
      ctx = createCtx(ctx.endPoint.userId, msg);
      try {
        const epId = ctx.endPoint.userId;
        const group_id = ctx.group.groupId.replace(/\D+/g, "");
        const user_id = ctx.player.userId.replace(/\D+/g, "");
        await globalThis.http.getData(epId, `group_poke?group_id=${group_id}&user_id=${user_id}`);
        return `已向<${name}>发送戳一戳`;
      } catch (e) {
        console.error(e);
        return `发送戳一戳失败`;
      }
    };
    ToolManager.toolMap[info.function.name] = tool;
  }

  // src/tool/tool_rename.ts
  function registerRename() {
    const info = {
      type: "function",
      function: {
        name: "rename",
        description: `设置群名片`,
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "用户名称" + (ConfigManager.message.showNumber ? "或纯数字QQ号" : "")
            },
            new_name: {
              type: "string",
              description: "新的名字"
            }
          },
          required: ["name", "new_name"]
        }
      }
    };
    const tool = new Tool(info);
    tool.solve = async (ctx, msg, ai, args) => {
      const { name, new_name } = args;
      const uid = await ai.context.findUserId(ctx, name);
      if (uid === null) {
        return `未找到<${name}>`;
      }
      msg = createMsg(msg.messageType, uid, ctx.group.groupId);
      ctx = createCtx(ctx.endPoint.userId, msg);
      try {
        seal.setPlayerGroupCard(ctx, new_name);
        seal.replyToSender(ctx, msg, `已将<${ctx.player.name}>的群名片设置为<${new_name}>`);
        return "设置成功";
      } catch (e) {
        console.error(e);
        return "设置失败";
      }
    };
    ToolManager.toolMap[info.function.name] = tool;
  }

  // src/tool/tool_roll_check.ts
  function registerRollCheck() {
    const info = {
      type: "function",
      function: {
        name: "roll_check",
        description: `进行一次技能检定或属性检定`,
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "被检定的人的名称" + (ConfigManager.message.showNumber ? "或纯数字QQ号" : "")
            },
            expression: {
              type: "string",
              description: "属性表达式，例如：敏捷、体质/2、意志-20"
            },
            rank: {
              type: "string",
              description: "难度等级，若无特殊说明则忽略",
              enum: ["困难", "极难", "大成功"]
            },
            times: {
              type: "integer",
              description: "检定的次数，若无特殊说明则忽略"
            },
            additional_dice: {
              type: "string",
              description: `额外的奖励骰或惩罚骰和数量，b代表奖励骰，p代表惩罚骰，若有多个，请在后面附加数字，例如：b、b2、p3，若没有奖励骰或惩罚骰则忽略`
            },
            reason: {
              type: "string",
              description: "检定的原因"
            }
          },
          required: ["name", "expression"]
        }
      }
    };
    const tool = new Tool(info);
    tool.cmdInfo = {
      ext: "coc7",
      name: "ra",
      fixedArgs: []
    };
    tool.solve = async (ctx, msg, ai, args) => {
      const { name, expression, rank = "", times = 1, additional_dice = "", reason = "" } = args;
      const uid = await ai.context.findUserId(ctx, name);
      if (uid === null) {
        return `未找到<${name}>`;
      }
      msg = createMsg(msg.messageType, uid, ctx.group.groupId);
      ctx = createCtx(ctx.endPoint.userId, msg);
      const args2 = [];
      if (additional_dice) {
        args2.push(additional_dice);
      }
      args2.push(rank + expression);
      if (reason) {
        args2.push(reason);
      }
      if (parseInt(times) !== 1 && !isNaN(parseInt(times))) {
        ToolManager.cmdArgs.specialExecuteTimes = parseInt(times);
      }
      const [s, success] = await ToolManager.extensionSolve(ctx, msg, ai, tool.cmdInfo, ...args2);
      ToolManager.cmdArgs.specialExecuteTimes = 1;
      if (!success) {
        return "检定完成";
      }
      return s;
    };
    ToolManager.toolMap[info.function.name] = tool;
  }

  // src/tool/tool_san_check.ts
  function registerSanCheck() {
    const info = {
      type: "function",
      function: {
        name: "san_check",
        description: `进行san check(sc)，并根据结果扣除san`,
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "进行sancheck的人的名称" + (ConfigManager.message.showNumber ? "或纯数字QQ号" : "")
            },
            expression: {
              type: "string",
              description: `san check的表达式，格式为 成功时掉san/失败时掉san ,例如：1/1d6、0/1`
            },
            additional_dice: {
              type: "string",
              description: `额外的奖励骰或惩罚骰和数量，b代表奖励骰，p代表惩罚骰，若有多个，请在后面附加数字，例如：b、b2、p3`
            }
          },
          required: ["name", "expression"]
        }
      }
    };
    const tool = new Tool(info);
    tool.cmdInfo = {
      ext: "coc7",
      name: "sc",
      fixedArgs: []
    };
    tool.solve = async (ctx, msg, ai, args) => {
      const { name, expression, additional_dice } = args;
      const uid = await ai.context.findUserId(ctx, name);
      if (uid === null) {
        return `未找到<${name}>`;
      }
      msg = createMsg(msg.messageType, uid, ctx.group.groupId);
      ctx = createCtx(ctx.endPoint.userId, msg);
      const args2 = [];
      if (additional_dice) {
        args2.push(additional_dice);
      }
      args2.push(expression);
      const [s, success] = await ToolManager.extensionSolve(ctx, msg, ai, tool.cmdInfo, ...args2);
      if (!success) {
        return "san check已执行";
      }
      return s;
    };
    ToolManager.toolMap[info.function.name] = tool;
  }

  // src/tool/tool_timer.ts
  var timerQueue = [];
  function registerSetTimer() {
    const info = {
      type: "function",
      function: {
        name: "set_timer",
        description: "设置一个定时器，在指定时间后触发",
        parameters: {
          type: "object",
          properties: {
            days: {
              type: "integer",
              description: "天数"
            },
            hours: {
              type: "integer",
              description: "小时数"
            },
            minutes: {
              type: "integer",
              description: "分钟数"
            },
            content: {
              type: "string",
              description: "触发时给自己的的提示词"
            }
          },
          required: ["minutes", "content"]
        }
      }
    };
    const tool = new Tool(info);
    tool.solve = async (ctx, msg, ai, args) => {
      const { days = 0, hours = 0, minutes, content } = args;
      const t = parseInt(days) * 24 * 60 + parseInt(hours) * 60 + parseInt(minutes);
      if (isNaN(t)) {
        return "时间应为数字";
      }
      timerQueue.push({
        id: ai.id,
        messageType: msg.messageType,
        uid: ctx.player.userId,
        gid: ctx.group.groupId,
        epId: ctx.endPoint.userId,
        timestamp: Math.floor(Date.now() / 1e3) + t * 60,
        setTime: (/* @__PURE__ */ new Date()).toLocaleString(),
        content
      });
      ConfigManager.ext.storageSet(`timerQueue`, JSON.stringify(timerQueue));
      return `设置定时器成功，请等待`;
    };
    ToolManager.toolMap[info.function.name] = tool;
  }
  function registerShowTimerList() {
    const info = {
      type: "function",
      function: {
        name: "show_timer_list",
        description: "查看当前聊天的所有定时器",
        parameters: {
          type: "object",
          properties: {},
          required: []
        }
      }
    };
    const tool = new Tool(info);
    tool.solve = async (_, __, ai, ___) => {
      const timers = timerQueue.filter((t) => t.id === ai.id);
      if (timers.length === 0) {
        return "当前对话没有定时器";
      }
      const s = timers.map((t, i) => {
        return `${i + 1}. 触发内容：${t.content}
${t.setTime} => ${new Date(t.timestamp * 1e3).toLocaleString()}`;
      }).join("\n");
      return s;
    };
    ToolManager.toolMap[info.function.name] = tool;
  }
  function registerCancelTimer() {
    const info = {
      type: "function",
      function: {
        name: "cancel_timer",
        description: "取消当前聊天的指定定时器",
        parameters: {
          type: "object",
          properties: {
            index_list: {
              type: "array",
              items: {
                type: "integer"
              },
              description: "要取消的定时器序号列表，序号从1开始"
            }
          },
          required: ["index_list"]
        }
      }
    };
    const tool = new Tool(info);
    tool.solve = async (_, __, ai, args) => {
      const { index_list } = args;
      const timers = timerQueue.filter((t) => t.id === ai.id);
      if (timers.length === 0) {
        return "当前对话没有定时器";
      }
      if (index_list.length === 0) {
        return "请输入要取消的定时器序号";
      }
      for (const index of index_list) {
        if (index < 1 || index > timers.length) {
          return `序号${index}超出范围`;
        }
        const i = timerQueue.indexOf(timers[index - 1]);
        if (i === -1) {
          return `出错了:找不到序号${index}的定时器`;
        }
        timerQueue.splice(i, 1);
      }
      ConfigManager.ext.storageSet(`timerQueue`, JSON.stringify(timerQueue));
      return "定时器取消成功";
    };
    ToolManager.toolMap[info.function.name] = tool;
  }

  // src/tool/tool_text_to_sound.ts
  var characterMap = {
    "小新": "lucy-voice-laibixiaoxin",
    "猴哥": "lucy-voice-houge",
    "四郎": "lucy-voice-silang",
    "东北老妹儿": "lucy-voice-guangdong-f1",
    "广西大表哥": "lucy-voice-guangxi-m1",
    "妲己": "lucy-voice-daji",
    "霸道总裁": "lucy-voice-lizeyan",
    "酥心御姐": "lucy-voice-suxinjiejie",
    "说书先生": "lucy-voice-m8",
    "憨憨小弟": "lucy-voice-male1",
    "憨厚老哥": "lucy-voice-male3",
    "吕布": "lucy-voice-lvbu",
    "元气少女": "lucy-voice-xueling",
    "文艺少女": "lucy-voice-f37",
    "磁性大叔": "lucy-voice-male2",
    "邻家小妹": "lucy-voice-female1",
    "低沉男声": "lucy-voice-m14",
    "傲娇少女": "lucy-voice-f38",
    "爹系男友": "lucy-voice-m101",
    "暖心姐姐": "lucy-voice-female2",
    "温柔妹妹": "lucy-voice-f36",
    "书香少女": "lucy-voice-f34"
  };
  function registerTextToSound() {
    const info = {
      type: "function",
      function: {
        name: "text_to_sound",
        description: "发送AI声聊合成语音",
        parameters: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "要合成的文本"
            }
          },
          required: ["text"]
        }
      }
    };
    const tool = new Tool(info);
    tool.solve = async (ctx, msg, _, args) => {
      const { text } = args;
      try {
        const { character } = ConfigManager.tool;
        if (character === "自定义") {
          const aittsExt = seal.ext.find("AITTS");
          if (!aittsExt) {
            console.error(`未找到AITTS依赖`);
            return `未找到AITTS依赖，请提示用户安装AITTS依赖`;
          }
          await globalThis.ttsHandler.generateSpeech(text, ctx, msg);
        } else {
          const ext = seal.ext.find("HTTP依赖");
          if (!ext) {
            console.error(`未找到HTTP依赖`);
            return `未找到HTTP依赖，请提示用户安装HTTP依赖`;
          }
          const characterId = characterMap[character];
          const epId = ctx.endPoint.userId;
          const group_id = ctx.group.groupId.replace(/\D+/g, "");
          await globalThis.http.getData(epId, `send_group_ai_record?character=${characterId}&group_id=${group_id}&text=${text}`);
        }
        return `发送语音成功`;
      } catch (e) {
        console.error(e);
        return `发送语音失败`;
      }
    };
    ToolManager.toolMap[info.function.name] = tool;
  }

  // src/tool/tool_web_search.ts
  function registerWebSearch() {
    const info = {
      type: "function",
      function: {
        name: "web_search",
        description: `使用搜索引擎搜索`,
        parameters: {
          type: "object",
          properties: {
            q: {
              type: "string",
              description: "搜索内容"
            },
            page: {
              type: "integer",
              description: "页码"
            },
            categories: {
              type: "string",
              description: "搜索分类",
              enum: ["general", "images", "videos", "news", "map", "music", "it", "science", "files", "social_media"]
            },
            time_range: {
              type: "string",
              description: "时间范围",
              enum: ["day", "week", "month", "year"]
            }
          },
          required: ["q"]
        }
      }
    };
    const tool = new Tool(info);
    tool.solve = async (_, __, ___, args) => {
      const { q, page, categories, time_range = "" } = args;
      let part = 1;
      let pageno = "";
      if (page) {
        part = parseInt(page) % 2;
        pageno = page ? Math.ceil(parseInt(page) / 2).toString() : "";
      }
      const url = `http://110.41.69.149:8080/search?q=${q}&format=json${pageno ? `&pageno=${pageno}` : ""}${categories ? `&categories=${categories}` : ""}${time_range ? `&time_range=${time_range}` : ""}`;
      try {
        log(`使用搜索引擎搜索:${url}`);
        const response = await fetch(url, {
          method: "GET",
          headers: {
            "Content-Type": "application/json"
          }
        });
        const data = await response.json();
        if (!response.ok) {
          let s2 = `请求失败! 状态码: ${response.status}`;
          if (data.error) {
            s2 += `
错误信息: ${data.error.message}`;
          }
          s2 += `
响应体: ${JSON.stringify(data, null, 2)}`;
          throw new Error(s2);
        }
        const number_of_results = data.number_of_results;
        const results_length = data.results.length;
        const results = part == 1 ? data.results.slice(0, Math.ceil(results_length / 2)) : data.results.slice(Math.ceil(results_length / 2));
        if (number_of_results == 0 || results.length == 0) {
          return `没有搜索到结果`;
        }
        const s = `搜索结果长度:${number_of_results}
` + results.map((result, index) => {
          return `${index + 1}. 标题:${result.title}
- 内容:${result.content}
- 链接:${result.url}
- 相关性:${result.score}`;
        }).join("\n");
        return s;
      } catch (error) {
        console.error("在web_search中请求出错：", error);
        return `使用搜索引擎搜索失败:${error}`;
      }
    };
    ToolManager.toolMap[info.function.name] = tool;
  }

  // src/tool/tool_group_sign.ts
  function registerGroupSign() {
    const info = {
      type: "function",
      function: {
        name: "group_sign",
        description: "发送群打卡",
        parameters: {
          type: "object",
          properties: {},
          required: []
        }
      }
    };
    const tool = new Tool(info);
    tool.solve = async (ctx, _, __, ___) => {
      if (ctx.isPrivate) {
        return `群打卡只能在群聊中使用`;
      }
      const ext = seal.ext.find("HTTP依赖");
      if (!ext) {
        console.error(`未找到HTTP依赖`);
        return `未找到HTTP依赖，请提示用户安装HTTP依赖`;
      }
      try {
        const epId = ctx.endPoint.userId;
        const group_id = ctx.group.groupId.replace(/\D+/g, "");
        await globalThis.http.getData(epId, `send_group_sign?group_id=${group_id.replace(/\D+/, "")}`);
        return `已发送群打卡，若无响应可能今日已打卡`;
      } catch (e) {
        console.error(e);
        return `发送群打卡失败`;
      }
    };
    ToolManager.toolMap[info.function.name] = tool;
  }

  // src/tool/tool_get_person_info.ts
  var constellations = ["水瓶座", "双鱼座", "白羊座", "金牛座", "双子座", "巨蟹座", "狮子座", "处女座", "天秤座", "天蝎座", "射手座", "摩羯座"];
  var shengXiao = ["鼠", "牛", "虎", "兔", "龙", "蛇", "马", "羊", "猴", "鸡", "狗", "猪"];
  function registerGetPersonInfo() {
    const info = {
      type: "function",
      function: {
        name: "get_person_info",
        description: "获取用户信息",
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "用户名称" + (ConfigManager.message.showNumber ? "或纯数字QQ号" : "")
            }
          },
          required: ["name"]
        }
      }
    };
    const tool = new Tool(info);
    tool.solve = async (ctx, msg, ai, args) => {
      const { name } = args;
      const ext = seal.ext.find("HTTP依赖");
      if (!ext) {
        console.error(`未找到HTTP依赖`);
        return `未找到HTTP依赖，请提示用户安装HTTP依赖`;
      }
      const uid = await ai.context.findUserId(ctx, name, true);
      if (uid === null) {
        return `未找到<${name}>`;
      }
      msg = createMsg(msg.messageType, uid, ctx.group.groupId);
      ctx = createCtx(ctx.endPoint.userId, msg);
      try {
        const epId = ctx.endPoint.userId;
        const user_id = ctx.player.userId.replace(/\D+/g, "");
        const data = await globalThis.http.getData(epId, `get_stranger_info?user_id=${user_id}`);
        let s = `昵称: ${data.nickname}
QQ号: ${data.user_id}
性别: ${data.sex}
QQ等级: ${data.qqLevel}
是否为VIP: ${data.is_vip}
是否为年费会员: ${data.is_years_vip}`;
        if (data.remark && data.remark !== "") s += `
备注: ${data.remark}`;
        if (data.birthday_year && data.birthday_year !== 0) {
          s += `
年龄: ${data.age}
生日: ${data.birthday_year}-${data.birthday_month}-${data.birthday_day}
星座: ${constellations[data.constellation - 1]}
生肖: ${shengXiao[data.shengXiao - 1]}`;
        }
        if (data.pos && data.pos !== "") s += `
位置: ${data.pos}`;
        if (data.country && data.country !== "") s += `
所在地: ${data.country} ${data.province} ${data.city}`;
        if (data.address && data.address !== "") s += `
地址: ${data.address}`;
        if (data.eMail && data.eMail !== "") s += `
邮箱: ${data.eMail}`;
        if (data.interest && data.interest !== "") s += `
兴趣: ${data.interest}`;
        if (data.labels && data.labels.length > 0) s += `
标签: ${data.labels.join(",")}`;
        if (data.long_nick && data.long_nick !== "") s += `
个性签名: ${data.long_nick}`;
        return s;
      } catch (e) {
        console.error(e);
        return `获取用户信息失败`;
      }
    };
    ToolManager.toolMap[info.function.name] = tool;
  }

  // src/tool/tool_record.ts
  function registerRecord() {
    const { recordsTemplate } = ConfigManager.tool;
    const records = recordsTemplate.reduce((acc, item) => {
      const match = item.match(/<(.+)>.*/);
      if (match !== null) {
        const key = match[1];
        acc[key] = item.replace(/<.*>/g, "");
      }
      return acc;
    }, {});
    if (Object.keys(records).length === 0) {
      return;
    }
    const info = {
      type: "function",
      function: {
        name: "record",
        description: `发送语音，语音名称有:${Object.keys(records).join("、")}`,
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "语音名称"
            }
          },
          required: ["name"]
        }
      }
    };
    const tool = new Tool(info);
    tool.solve = async (ctx, msg, _, args) => {
      const { name } = args;
      if (records.hasOwnProperty(name)) {
        seal.replyToSender(ctx, msg, `[语音:${records[name]}]`);
        return "发送成功";
      } else {
        console.error(`本地语音${name}不存在`);
        return `本地语音${name}不存在`;
      }
    };
    ToolManager.toolMap[info.function.name] = tool;
  }

  // src/utils/utils_string.ts
  function getCQTypes(s) {
    const match = s.match(/\[CQ:([^,]*?),.*?\]/g);
    if (match) {
      return match.map((item) => item.match(/\[CQ:([^,]*?),/)[1]);
    } else {
      return [];
    }
  }
  function levenshteinDistance(s1, s2) {
    const len1 = s1.length;
    const len2 = s2.length;
    const dp = Array.from({ length: len1 + 1 }, () => Array(len2 + 1).fill(0));
    for (let i = 0; i <= len1; i++) {
      dp[i][0] = i;
    }
    for (let j = 0; j <= len2; j++) {
      dp[0][j] = j;
    }
    for (let i = 1; i <= len1; i++) {
      for (let j = 1; j <= len2; j++) {
        if (s1[i - 1] === s2[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1];
        } else {
          dp[i][j] = Math.min(
            dp[i - 1][j] + 1,
            // 删除
            dp[i][j - 1] + 1,
            // 插入
            dp[i - 1][j - 1] + 1
            // 替换
          );
        }
      }
    }
    return dp[len1][len2];
  }
  function calculateSimilarity(s1, s2) {
    if (s1.length === 0 || s2.length === 0) {
      return 0;
    }
    const distance = levenshteinDistance(s1, s2);
    const maxLength = Math.max(s1.length, s2.length);
    return 1 - distance / maxLength;
  }

  // src/utils/utils_reply.ts
  async function handleReply(ctx, msg, s, context) {
    const { maxChar, replymsg, filterContextTemplate, filterReplyTemplate } = ConfigManager.reply;
    const segments = s.split(/(<[\|｜]from:?.*?[\|｜]?>)/).filter((item) => item.trim() !== "");
    if (segments.length === 0) {
      return { s: "", reply: "", isRepeat: false, images: [] };
    }
    s = "";
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const match = segment.match(/<[\|｜]from:?(.*?)[\|｜]?>/);
      if (match) {
        const uid = await context.findUserId(ctx, match[1]);
        if (uid === ctx.endPoint.userId && i < segments.length - 1) {
          s += segments[i + 1];
        }
      } else if (i === 0) {
        s = segment;
      }
    }
    if (!s.trim()) {
      s = segments.find((segment) => !/<[\|｜]from:?.*?[\|｜]?>/.test(segment));
      if (!s.trim()) {
        return { s: "", reply: "", isRepeat: false, images: [] };
      }
    }
    let reply = s;
    filterContextTemplate.forEach((item) => {
      try {
        const regex = new RegExp(item, "g");
        s = s.replace(regex, "");
      } catch (error) {
        console.error("Error in RegExp:", error);
      }
    });
    s = s.slice(0, maxChar).trim();
    const isRepeat = checkRepeat(context, s);
    reply = await replaceMentions(ctx, context, reply);
    const { result, images } = await replaceImages(context, reply);
    reply = result;
    filterReplyTemplate.forEach((item) => {
      try {
        const regex = new RegExp(item, "g");
        reply = reply.replace(regex, "");
      } catch (error) {
        console.error("Error in RegExp:", error);
      }
    });
    const prefix = replymsg ? `[CQ:reply,id=${msg.rawId}][CQ:at,qq=${ctx.player.userId.replace(/\D+/g, "")}] ` : ``;
    const segments2 = reply.split(/(\[CQ:.+?\])/);
    let nonCQLength = 0;
    let finalReply = prefix;
    for (const segment of segments2) {
      if (segment.startsWith("[CQ:") && segment.endsWith("]")) {
        finalReply += segment;
      } else {
        const remaining = maxChar - nonCQLength;
        if (remaining > 0) {
          finalReply += segment.slice(0, remaining);
          nonCQLength += Math.min(segment.length, remaining);
        }
      }
    }
    reply = finalReply;
    return { s, isRepeat, reply, images };
  }
  function checkRepeat(context, s) {
    const { stopRepeat, similarityLimit } = ConfigManager.reply;
    if (!stopRepeat) {
      return false;
    }
    const messages = context.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role === "assistant" && !(message == null ? void 0 : message.tool_calls)) {
        const content = message.content;
        const similarity = calculateSimilarity(content.trim(), s.trim());
        log(`复读相似度：${similarity}`);
        if (similarity > similarityLimit) {
          let start = i;
          let count = 1;
          for (let j = i - 1; j >= 0; j--) {
            const message2 = messages[j];
            if (message2.role === "tool" || message2.role === "assistant" && (message2 == null ? void 0 : message2.tool_calls)) {
              start = j;
              count++;
            } else {
              break;
            }
          }
          messages.splice(start, count);
          return true;
        }
        break;
      }
    }
    return false;
  }
  async function replaceMentions(ctx, context, reply) {
    const match = reply.match(/<@(.+?)>/g);
    if (match) {
      for (let i = 0; i < match.length; i++) {
        const name = match[i].replace(/^<@|>$/g, "");
        const uid = await context.findUserId(ctx, name);
        if (uid !== null) {
          reply = reply.replace(match[i], `[CQ:at,qq=${uid.replace(/\D+/g, "")}]`);
        } else {
          reply = reply.replace(match[i], ` @${name} `);
        }
      }
    }
    return reply;
  }
  async function replaceImages(context, reply) {
    let result = reply;
    const images = [];
    const match = reply.match(/<[\|｜]图片.+?[\|｜]?>/g);
    if (match) {
      for (let i = 0; i < match.length; i++) {
        const id = match[i].match(/<[\|｜]图片(.+?)[\|｜]?>/)[1];
        const image = context.findImage(id);
        if (image) {
          const file = image.file;
          images.push(image);
          if (!image.isUrl || image.isUrl && await ImageManager.checkImageUrl(file)) {
            result = result.replace(match[i], `[CQ:image,file=${file}]`);
            continue;
          }
        }
        result = result.replace(match[i], ``);
      }
    }
    return { result, images };
  }

  // src/tool/tool_send_msg.ts
  function registerSendMsg() {
    const info = {
      type: "function",
      function: {
        name: "send_msg",
        description: `向当前聊天以外的指定私聊或群聊发送消息或调用函数`,
        parameters: {
          type: "object",
          properties: {
            msg_type: {
              type: "string",
              description: "消息类型，私聊或群聊",
              enum: ["private", "group"]
            },
            name: {
              type: "string",
              description: "用户名称或群聊名称" + (ConfigManager.message.showNumber ? "或纯数字QQ号、群号" : "") + "，实际使用时与消息类型对应"
            },
            content: {
              type: "string",
              description: "消息内容"
            },
            function: {
              type: "object",
              properties: {
                name: {
                  type: "string",
                  description: "函数名称"
                },
                arguments: {
                  type: "string",
                  description: "函数参数，必须严格按照目标函数的参数定义（包括参数名和类型）完整填写，格式为JSON字符串"
                }
              },
              required: ["name", "arguments"],
              description: "函数调用，必须准确理解目标函数的参数定义后再填写"
            },
            reason: {
              type: "string",
              description: "发送原因"
            }
          },
          required: ["msg_type", "name", "content"]
        }
      }
    };
    const tool = new Tool(info);
    tool.solve = async (ctx, msg, ai, args) => {
      const { msg_type, name, content, function: tool_call, reason = "" } = args;
      const { showNumber } = ConfigManager.message;
      const source = ctx.isPrivate ? `来自<${ctx.player.name}>${showNumber ? `(${ctx.player.userId.replace(/\D+/g, "")})` : ``}` : `来自群聊<${ctx.group.groupName}>${showNumber ? `(${ctx.group.groupId.replace(/\D+/g, "")})` : ``}`;
      const originalImages = [];
      const match = content.match(/<[\|｜]图片.+?[\|｜]?>/g);
      if (match) {
        for (let i = 0; i < match.length; i++) {
          const id = match[i].match(/<[\|｜]图片(.+?)[\|｜]?>/)[1];
          const image = ai.context.findImage(id);
          if (image) {
            originalImages.push(image);
          }
        }
      }
      if (msg_type === "private") {
        const uid = await ai.context.findUserId(ctx, name, true);
        if (uid === null) {
          return `未找到<${name}>`;
        }
        if (uid === ctx.player.userId && ctx.isPrivate) {
          return `向当前私聊发送消息无需调用函数`;
        }
        if (uid === ctx.endPoint.userId) {
          return `禁止向自己发送消息`;
        }
        msg = createMsg("private", uid, "");
        ctx = createCtx(ctx.endPoint.userId, msg);
        ai = AIManager.getAI(uid);
      } else if (msg_type === "group") {
        const gid = await ai.context.findGroupId(ctx, name);
        if (gid === null) {
          return `未找到<${name}>`;
        }
        if (gid === ctx.group.groupId) {
          return `向当前群聊发送消息无需调用函数`;
        }
        msg = createMsg("group", ctx.player.userId, gid);
        ctx = createCtx(ctx.endPoint.userId, msg);
        ai = AIManager.getAI(gid);
      } else {
        return `未知的消息类型<${msg_type}>`;
      }
      await ai.context.systemUserIteration("来自其他对话的消息发送提示", `${source}: 原因: ${reason || "无"}`, originalImages);
      const { s, reply, images } = await handleReply(ctx, msg, content, ai.context);
      ai.context.lastReply = reply;
      await ai.context.iteration(ctx, s, images, "assistant");
      seal.replyToSender(ctx, msg, reply);
      if (tool_call) {
        if (!ToolManager.toolMap.hasOwnProperty(tool_call.name)) {
          return `调用函数失败:未注册的函数:${tool_call.name}`;
        }
        if (ConfigManager.tool.toolsNotAllow.includes(tool_call.name)) {
          return `调用函数失败:禁止调用的函数:${tool_call.name}`;
        }
        if (ToolManager.cmdArgs == null) {
          return `暂时无法调用函数，请先使用任意指令`;
        }
        try {
          const tool2 = ToolManager.toolMap[tool_call.name];
          try {
            tool_call.arguments = JSON.parse(tool_call.arguments);
          } catch (e) {
            return `调用函数失败:arguement不是一个合法的JSON字符串`;
          }
          const args2 = tool_call.arguments;
          if (args2 !== null && typeof args2 !== "object") {
            return `调用函数失败:arguement不是一个object`;
          }
          for (const key of tool2.info.function.parameters.required) {
            if (!args2.hasOwnProperty(key)) {
              return `调用函数失败:缺少必需参数 ${key}`;
            }
          }
          const s2 = await tool2.solve(ctx, msg, ai, args2);
          await ai.context.systemUserIteration("调用函数返回", s2, []);
          AIManager.saveAI(ai.id);
          return `函数调用成功，返回值:${s2}`;
        } catch (e) {
          const s2 = `调用函数 (${name}:${JSON.stringify(tool_call.arguments, null, 2)}) 失败:${e.message}`;
          console.error(s2);
          await ai.context.systemUserIteration("调用函数返回", s2, []);
          AIManager.saveAI(ai.id);
          return s2;
        }
      }
      AIManager.saveAI(ai.id);
      return "消息发送成功";
    };
    ToolManager.toolMap[info.function.name] = tool;
  }

  // src/tool/tool_get_context.ts
  function registerGetContext() {
    const info = {
      type: "function",
      function: {
        name: "get_context",
        description: `查看指定私聊或群聊的上下文`,
        parameters: {
          type: "object",
          properties: {
            ctx_type: {
              type: "string",
              description: "上下文类型，私聊或群聊",
              enum: ["private", "group"]
            },
            name: {
              type: "string",
              description: "用户名称或群聊名称" + (ConfigManager.message.showNumber ? "或纯数字QQ号、群号" : "") + "，实际使用时与上下文类型对应"
            }
          },
          required: ["ctx_type", "name"]
        }
      }
    };
    const tool = new Tool(info);
    tool.solve = async (ctx, msg, ai, args) => {
      const { ctx_type, name } = args;
      const originalAI = ai;
      if (ctx_type === "private") {
        const uid = await ai.context.findUserId(ctx, name, true);
        if (uid === null) {
          return `未找到<${name}>`;
        }
        if (uid === ctx.player.userId && ctx.isPrivate) {
          return `向当前私聊发送消息无需调用函数`;
        }
        if (uid === ctx.endPoint.userId) {
          return `禁止向自己发送消息`;
        }
        msg = createMsg("private", uid, "");
        ctx = createCtx(ctx.endPoint.userId, msg);
        ai = AIManager.getAI(uid);
      } else if (ctx_type === "group") {
        const gid = await ai.context.findGroupId(ctx, name);
        if (gid === null) {
          return `未找到<${name}>`;
        }
        if (gid === ctx.group.groupId) {
          return `向当前群聊发送消息无需调用函数`;
        }
        msg = createMsg("group", ctx.player.userId, gid);
        ctx = createCtx(ctx.endPoint.userId, msg);
        ai = AIManager.getAI(gid);
      } else {
        return `未知的上下文类型<${ctx_type}>`;
      }
      const { isPrefix, showNumber } = ConfigManager.message;
      const messages = ai.context.messages;
      const images = [];
      let s = "";
      for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        images.push(...message.images);
        if (message.role === "assistant" && (message == null ? void 0 : message.tool_calls)) {
          s += `
[function_call]: ${message.tool_calls.map((tool_call, index) => `${index + 1}. ${JSON.stringify(tool_call.function, null, 2)}`).join("\n")}`;
        }
        const prefix = isPrefix && message.name ? message.name.startsWith("_") ? `<|${message.name}|>` : `<|from:${message.name}${showNumber ? `(${message.uid.replace(/\D+/g, "")})` : ``}|>` : "";
        s += `
[${message.role}]: ${prefix}${message.content}`;
      }
      originalAI.context.messages[originalAI.context.messages.length - 1].images.push(...images);
      return s;
    };
    ToolManager.toolMap[info.function.name] = tool;
  }

  // src/tool/tool_get_list.ts
  function registerGetList() {
    const info = {
      type: "function",
      function: {
        name: "get_list",
        description: `查看当前好友列表或群聊列表`,
        parameters: {
          type: "object",
          properties: {
            msg_type: {
              type: "string",
              description: "消息类型，私聊或群聊",
              enum: ["private", "group"]
            }
          },
          required: ["msg_type"]
        }
      }
    };
    const tool = new Tool(info);
    tool.solve = async (ctx, _, __, args) => {
      const { msg_type } = args;
      if (msg_type === "private") {
        try {
          const epId = ctx.endPoint.userId;
          const data = await globalThis.http.getData(epId, `get_friend_list`);
          const s = `好友数量: ${data.length}
` + data.slice(0, 50).map((item, index) => {
            return `${index + 1}. ${item.nickname}(${item.user_id}) ${item.remark && item.remark !== item.nickname ? `备注: ${item.remark}` : ""}`;
          }).join("\n");
          return s;
        } catch (e) {
          console.error(e);
          return `获取好友列表失败`;
        }
      } else if (msg_type === "group") {
        try {
          const epId = ctx.endPoint.userId;
          const data = await globalThis.http.getData(epId, `get_group_list`);
          const s = `群聊数量: ${data.length}
` + data.slice(0, 50).map((item, index) => {
            return `${index + 1}. ${item.group_name}(${item.group_id}) 人数: ${item.member_count}/${item.max_member_count}`;
          }).join("\n");
          return s;
        } catch (e) {
          console.error(e);
          return `获取好友列表失败`;
        }
      } else {
        return `未知的消息类型<${msg_type}>`;
      }
    };
    ToolManager.toolMap[info.function.name] = tool;
  }
  function registerGetGroupMemberList() {
    const info = {
      type: "function",
      function: {
        name: "get_group_member_list",
        description: `查看群聊成员列表`,
        parameters: {
          type: "object",
          properties: {
            role: {
              type: "string",
              description: "成员角色，群主或管理员",
              enum: ["owner", "admin", "robot"]
            }
          },
          required: []
        }
      }
    };
    const tool = new Tool(info);
    tool.solve = async (ctx, _, __, args) => {
      const { role = "" } = args;
      try {
        const epId = ctx.endPoint.userId;
        const gid = ctx.group.groupId;
        const data = await globalThis.http.getData(epId, `get_group_member_list?group_id=${gid.replace(/\D+/g, "")}`);
        if (role === "owner") {
          const owner = data.find((item) => item.role === role);
          if (!owner) {
            return `未找到群主`;
          }
          return `群主: ${owner.nickname}(${owner.user_id}) ${owner.card && owner.card !== owner.nickname ? `群名片: ${owner.card}` : ""}`;
        } else if (role === "admin") {
          const admins = data.filter((item) => item.role === role);
          if (admins.length === 0) {
            return `未找到管理员`;
          }
          const s2 = `管理员数量: ${admins.length}
` + admins.slice(0, 50).map((item, index) => {
            return `${index + 1}. ${item.nickname}(${item.user_id}) ${item.card && item.card !== item.nickname ? `群名片: ${item.card}` : ""}`;
          }).join("\n");
          return s2;
        } else if (role === "robot") {
          const robots = data.filter((item) => item.is_robot);
          if (robots.length === 0) {
            return `未找到机器人`;
          }
          const s2 = `机器人数量: ${robots.length}
` + robots.slice(0, 50).map((item, index) => {
            return `${index + 1}. ${item.nickname}(${item.user_id}) ${item.card && item.card !== item.nickname ? `群名片: ${item.card}` : ""}`;
          }).join("\n");
          return s2;
        }
        const s = `群成员数量: ${data.length}
` + data.slice(0, 50).map((item, index) => {
          return `${index + 1}. ${item.nickname}(${item.user_id}) ${item.card && item.card !== item.nickname ? `群名片: ${item.card}` : ""} ${item.title ? `头衔: ${item.title}` : ""} ${item.role === "owner" ? "【群主】" : item.role === "admin" ? "【管理员】" : item.is_robot ? "【机器人】" : ""}`;
        }).join("\n");
        return s;
      } catch (e) {
        console.error(e);
        return `获取群成员列表失败`;
      }
    };
    ToolManager.toolMap[info.function.name] = tool;
  }

  // src/tool/tool_search_chat.ts
  function registerSearchChat() {
    const info = {
      type: "function",
      function: {
        name: "search_chat",
        description: `搜索好友或群聊`,
        parameters: {
          type: "object",
          properties: {
            msg_type: {
              type: "string",
              description: "消息类型，私聊或群聊",
              enum: ["private", "group"]
            },
            q: {
              type: "string",
              description: "搜索关键字"
            }
          },
          required: ["q"]
        }
      }
    };
    const tool = new Tool(info);
    tool.solve = async (ctx, _, __, args) => {
      const { msg_type, q } = args;
      if (msg_type === "private") {
        try {
          const epId = ctx.endPoint.userId;
          const data = await globalThis.http.getData(epId, `get_friend_list`);
          const arr = data.filter((item) => {
            return item.nickname.includes(q) || item.remark.includes(q);
          });
          const s = `搜索结果好友数量: ${arr.length}
` + arr.slice(0, 50).map((item, index) => {
            return `${index + 1}. ${item.nickname}(${item.user_id}) ${item.remark && item.remark !== item.nickname ? `备注: ${item.remark}` : ""}`;
          }).join("\n");
          return s;
        } catch (e) {
          console.error(e);
          return `获取好友列表失败`;
        }
      } else if (msg_type === "group") {
        try {
          const epId = ctx.endPoint.userId;
          const data = await globalThis.http.getData(epId, `get_group_list`);
          const arr = data.filter((item) => {
            return item.group_name.includes(q);
          });
          const s = `搜索结果群聊数量: ${arr.length}
` + arr.slice(0, 50).map((item, index) => {
            return `${index + 1}. ${item.group_name}(${item.group_id}) 人数: ${item.member_count}/${item.max_member_count}`;
          }).join("\n");
          return s;
        } catch (e) {
          console.error(e);
          return `获取好友列表失败`;
        }
      } else {
        const epId = ctx.endPoint.userId;
        const data1 = await globalThis.http.getData(epId, `get_friend_list`);
        const arr1 = data1.filter((item) => {
          return item.nickname.includes(q) || item.remark.includes(q);
        });
        const data2 = await globalThis.http.getData(epId, `get_group_list`);
        const arr2 = data2.filter((item) => {
          return item.group_name.includes(q);
        });
        const s = `搜索结果好友数量: ${arr1.length}
` + arr1.slice(0, 50).map((item, index) => {
          return `${index + 1}. ${item.nickname}(${item.user_id}) ${item.remark && item.remark !== item.nickname ? `备注: ${item.remark}` : ""}`;
        }).join("\n") + `
搜索结果群聊数量: ${arr2.length}
` + arr2.slice(0, 50).map((item, index) => {
          return `${index + 1}. ${item.group_name}(${item.group_id}) 人数: ${item.member_count}/${item.max_member_count}`;
        }).join("\n");
        return s;
      }
    };
    ToolManager.toolMap[info.function.name] = tool;
  }
  function registerSearchCommonGroup() {
    const info = {
      type: "function",
      function: {
        name: "search_common_group",
        description: `搜索共同群聊`,
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "用户名称" + (ConfigManager.message.showNumber ? "或纯数字QQ号" : "")
            }
          },
          required: ["name"]
        }
      }
    };
    const tool = new Tool(info);
    tool.solve = async (ctx, _, ai, args) => {
      const { name } = args;
      const uid = await ai.context.findUserId(ctx, name, true);
      if (uid === null) {
        return `未找到<${name}>`;
      }
      if (uid === ctx.endPoint.userId) {
        return `禁止搜索自己`;
      }
      try {
        const epId = ctx.endPoint.userId;
        const data = await globalThis.http.getData(epId, `get_group_list`);
        const arr = [];
        for (const group_info of data) {
          const data2 = await globalThis.http.getData(epId, `get_group_member_list?group_id=${group_info.group_id}`);
          const user_info = data2.find((user_info2) => user_info2.user_id.toString() === uid.replace(/\D+/g, ""));
          if (user_info) {
            arr.push({ group_info, user_info });
          }
        }
        const s = `共群数量: ${arr.length}
` + arr.slice(0, 50).map((item, index) => {
          return `${index + 1}. ${item.group_info.group_name}(${item.group_info.group_id}) 人数: ${item.group_info.member_count}/${item.group_info.max_member_count} ${item.user_info.card && item.user_info.card !== item.user_info.nickname ? `群名片: ${item.user_info.card}` : ""}`;
        }).join("\n");
        return s;
      } catch (e) {
        console.error(e);
        return `获取共群列表失败`;
      }
    };
    ToolManager.toolMap[info.function.name] = tool;
  }

  // src/tool/tool_set_trigger_condition.ts
  var triggerConditionMap = {};
  function registerSetTriggerCondition() {
    const info = {
      type: "function",
      function: {
        name: "set_trigger_condition",
        description: `设置一个触发条件，当触发条件满足时，会自动进行一次对话`,
        parameters: {
          type: "object",
          properties: {
            keyword: {
              type: "string",
              description: "触发关键词，可使用正则表达式，为空时任意消息都可触发"
            },
            name: {
              type: "string",
              description: "指定触发必须满足的用户名称" + (ConfigManager.message.showNumber ? "或纯数字QQ号" : "") + "，为空时任意用户均可触发"
            },
            reason: {
              type: "string",
              description: "触发原因"
            }
          },
          required: ["reason"]
        }
      }
    };
    const tool = new Tool(info);
    tool.solve = async (ctx, _, ai, args) => {
      const { keyword = "", name = "", reason } = args;
      const condition = {
        keyword: "",
        uid: "",
        reason
      };
      if (keyword) {
        try {
          new RegExp(keyword);
          condition.keyword = keyword;
        } catch (e) {
          return `触发关键词格式错误`;
        }
      }
      if (name) {
        const uid = await ai.context.findUserId(ctx, name, true);
        if (uid === null) {
          return `未找到<${name}>`;
        }
        if (uid === ctx.endPoint.userId) {
          return `禁止将自己设置为触发条件`;
        }
        condition.uid = uid;
      }
      if (!triggerConditionMap.hasOwnProperty(ai.id)) {
        triggerConditionMap[ai.id] = [];
      }
      triggerConditionMap[ai.id].push(condition);
      return "触发条件设置成功";
    };
    ToolManager.toolMap[info.function.name] = tool;
  }

  // src/tool/tool_music.ts
  function registerMusicPlay() {
    const info = {
      type: "function",
      function: {
        name: "music_play",
        description: `搜索并播放音乐`,
        parameters: {
          type: "object",
          properties: {
            platform: {
              type: "string",
              description: "音乐平台",
              enum: ["网易云", "qq"]
            },
            song_name: {
              type: "string",
              description: "歌曲名称"
            }
          },
          required: ["platform", "song_name"]
        }
      }
    };
    const tool = new Tool(info);
    tool.solve = async (ctx, msg, _, args) => {
      const { platform, song_name } = args;
      let api = "";
      switch (platform) {
        case "网易云": {
          api = `http://net.ease.music.lovesealdice.online/search?keywords=${song_name}`;
          break;
        }
        case "qq": {
          api = `http://qqmusic.lovesealdice.online/search?key=${song_name}`;
          break;
        }
        default: {
          return `不支持的平台: ${platform}`;
        }
      }
      try {
        log(`搜索音乐: ${api}`);
        const response = await fetch(api, {
          method: "GET",
          headers: {
            "Content-Type": "application/json"
          }
        });
        if (!response.ok) {
          throw new Error(`${platform}API失效`);
        }
        const data = await response.json();
        switch (platform) {
          case "网易云": {
            const song = data.result.songs[0];
            if (!song) {
              return "网易云没找到这首歌";
            }
            const id = song.id;
            const name = song.name;
            const artist = song.artists[0].name;
            const imgResponse = await fetch(`http://net.ease.music.lovesealdice.online/song/detail?ids=${id}`);
            const imgData = await imgResponse.json();
            const img = imgData.songs[0].al.picUrl;
            const downloadResponse = await fetch(`http://net.ease.music.lovesealdice.online/song/download/url?id=${id}`, {
              headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
                "Cookie": "_gid=GA1.2.2048499931.1737983161; _ga_MD3K4WETFE=GS1.1.1737983160.8.1.1737983827.0.0.0; _ga=GA1.1.1845263601.1736600307; MUSIC_U=00C10F470166570C36209E7E3E3649FEE210D3DB5B3C39C25214CFE5678DCC5773C63978903CEBA7BF4292B97ADADB566D96A055DCFDC860847761109F8986373FEC32BE2AFBF3DCFF015894EC61602562BF9D16AD12D76CED169C5052A470677A8D59F7B7D16D9FDE2A4ED237DE5C6956C0ED5F7A9EA151C3FA7367B0C6269FF7A74E6626B4D7F920D524718347659394CBB0DAE362991418070195FEFC730BCCE3CF4B03F24274075679FB4BFC884D099BD3CF679E4F1C9D5CBC2959CD29B0741BD52BCA155480116CE96393663B1A51D88AFDB57680F030CF93A305064A797B99874CA826D6760F616CB756B680591167AEE9AF31C4A187E61A19D7C1175961D4FE64CFD878F0BCEBB322A23E396DC5E8175A50D5E07B9788E4EBE8F8257FF139DB4FD03A89676F5C3DF1B70C101F4568C0A3657C24185218F975368ADB2DEF860760C59E9AFCCB214A4B51029E29ED; __csrf=85f3aa8cedc01f6d50b6b924efbf6f95; NMTID=00OG17oToz2Ne1rikTtgKPqOLaYuP0AAAGUqBEN0A"
              }
            });
            const downloadData = await downloadResponse.json();
            const url = downloadData.data.url;
            seal.replyToSender(ctx, msg, `[CQ:music,type=163,url=${url},audio=${url},title=${name},content=${artist},image=${img}]`);
            return `发送成功，歌名:${name}，歌手:${artist}`;
          }
          case "qq": {
            const song = data.data.list[0];
            if (!song) {
              return "QQ音乐没找到这首歌...";
            }
            seal.replyToSender(ctx, msg, `[CQ:music,type=qq,id=${song.songid}]`);
            return "发送成功";
          }
          default: {
            return "不支持的平台";
          }
        }
      } catch (error) {
        log(`音乐搜索请求错误: ${error}`);
        return `音乐搜索请求错误: ${error}`;
      }
    };
    ToolManager.toolMap[info.function.name] = tool;
  }

  // src/tool/tool.ts
  var Tool = class {
    constructor(info) {
      this.info = info;
      this.cmdInfo = {
        ext: "",
        name: "",
        fixedArgs: []
      };
      this.tool_choice = "none";
      this.solve = async (_, __, ___, ____) => "函数未实现";
    }
  };
  var _ToolManager = class _ToolManager {
    constructor() {
      const { toolsNotAllow, toolsDefaultClosed } = ConfigManager.tool;
      this.toolStatus = Object.keys(_ToolManager.toolMap).reduce((acc, key) => {
        acc[key] = !toolsNotAllow.includes(key) && !toolsDefaultClosed.includes(key);
        return acc;
      }, {});
    }
    static reviver(value) {
      const tm = new _ToolManager();
      const validKeys = ["toolStatus"];
      for (const k of validKeys) {
        if (value.hasOwnProperty(k)) {
          tm[k] = value[k];
          if (k === "toolStatus") {
            const { toolsNotAllow, toolsDefaultClosed } = ConfigManager.tool;
            tm[k] = Object.keys(_ToolManager.toolMap).reduce((acc, key) => {
              acc[key] = !toolsNotAllow.includes(key) && (value[k].hasOwnProperty(key) ? value[k][key] : !toolsDefaultClosed.includes(key));
              return acc;
            }, {});
          }
        }
      }
      return tm;
    }
    getToolsInfo() {
      const tools = Object.keys(this.toolStatus).map((key) => {
        if (this.toolStatus[key]) {
          return _ToolManager.toolMap[key].info;
        } else {
          return null;
        }
      }).filter((item) => item !== null);
      if (tools.length === 0) {
        return null;
      } else {
        return tools;
      }
    }
    static registerTool() {
      registerAddMemory();
      registerShowMemory();
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
      registerWholeBan();
      registerGetBanList();
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
      registerGroupSign();
      registerGetPersonInfo();
      registerRecord();
      registerSendMsg();
      registerGetContext();
      registerGetList();
      registerGetGroupMemberList();
      registerSearchChat();
      registerSearchCommonGroup();
      registerSetTriggerCondition();
      registerMusicPlay();
    }
    /**
     * 利用预存的指令信息和额外输入的参数构建一个cmdArgs, 并调用solve函数
     * @param cmdArgs
     * @param args
     */
    static async extensionSolve(ctx, msg, ai, cmdInfo, ...args) {
      const cmdArgs = this.cmdArgs;
      cmdArgs.command = cmdInfo.name;
      cmdArgs.args = cmdInfo.fixedArgs.concat(args);
      cmdArgs.kwargs = [];
      cmdArgs.at = [];
      cmdArgs.rawArgs = cmdArgs.args.join(" ");
      cmdArgs.amIBeMentioned = false;
      cmdArgs.amIBeMentionedFirst = false;
      cmdArgs.cleanArgs = cmdArgs.args.join(" ");
      ai.listen.status = true;
      const ext = seal.ext.find(cmdInfo.ext);
      ext.cmdMap[cmdInfo.name].solve(ctx, msg, cmdArgs);
      await new Promise((resolve) => setTimeout(resolve, 1e3));
      if (ai.listen.status) {
        ai.listen.status = false;
        return ["", false];
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
    static async handleToolCalls(ctx, msg, ai, tool_calls) {
      tool_calls.splice(5);
      if (tool_calls.length !== 0) {
        log(`调用函数:`, tool_calls.map((item, i) => {
          return `(${i}) ${item.function.name}:${item.function.arguments}`;
        }).join("\n"));
      }
      let tool_choice = "none";
      for (let i = 0; i < tool_calls.length; i++) {
        const tool_call = tool_calls[i];
        const tool_choice2 = await this.handleToolCall(ctx, msg, ai, tool_call);
        if (tool_choice2 === "required") {
          tool_choice = "required";
        } else if (tool_choice === "none" && tool_choice2 === "auto") {
          tool_choice = "auto";
        }
      }
      return tool_choice;
    }
    static async handleToolCall(ctx, msg, ai, tool_call) {
      const name = tool_call.function.name;
      if (!this.toolMap.hasOwnProperty(name)) {
        log(`调用函数失败:未注册的函数:${name}`);
        await ai.context.toolIteration(tool_call.id, `调用函数失败:未注册的函数:${name}`);
        return "none";
      }
      if (ConfigManager.tool.toolsNotAllow.includes(name)) {
        log(`调用函数失败:禁止调用的函数:${name}`);
        await ai.context.toolIteration(tool_call.id, `调用函数失败:禁止调用的函数:${name}`);
        return "none";
      }
      if (this.cmdArgs == null) {
        log(`暂时无法调用函数，请先使用任意指令`);
        await ai.context.toolIteration(tool_call.id, `暂时无法调用函数，请先提示用户使用任意指令`);
        return "none";
      }
      try {
        const tool = this.toolMap[name];
        const args = JSON.parse(tool_call.function.arguments);
        if (args !== null && typeof args !== "object") {
          log(`调用函数失败:arguement不是一个object`);
          await ai.context.toolIteration(tool_call.id, `调用函数失败:arguement不是一个object`);
          return "none";
        }
        for (const key of tool.info.function.parameters.required) {
          if (!args.hasOwnProperty(key)) {
            log(`调用函数失败:缺少必需参数 ${key}`);
            await ai.context.toolIteration(tool_call.id, `调用函数失败:缺少必需参数 ${key}`);
            return "none";
          }
        }
        const s = await tool.solve(ctx, msg, ai, args);
        await ai.context.toolIteration(tool_call.id, s);
        return tool.tool_choice;
      } catch (e) {
        const s = `调用函数 (${name}:${tool_call.function.arguments}) 失败:${e.message}`;
        console.error(s);
        await ai.context.toolIteration(tool_call.id, s);
        return "none";
      }
    }
    static async handlePromptToolCall(ctx, msg, ai, tool_call) {
      if (!tool_call.hasOwnProperty("name") || !tool_call.hasOwnProperty("arguments")) {
        log(`调用函数失败:缺少name或arguments`);
        await ai.context.systemUserIteration("调用函数返回", `调用函数失败:缺少name或arguments`, []);
      }
      const name = tool_call.name;
      if (!this.toolMap.hasOwnProperty(name)) {
        log(`调用函数失败:未注册的函数:${name}`);
        await ai.context.systemUserIteration("调用函数返回", `调用函数失败:未注册的函数:${name}`, []);
        return;
      }
      if (ConfigManager.tool.toolsNotAllow.includes(name)) {
        log(`调用函数失败:禁止调用的函数:${name}`);
        await ai.context.systemUserIteration("调用函数返回", `调用函数失败:禁止调用的函数:${name}`, []);
        return;
      }
      if (this.cmdArgs == null) {
        log(`暂时无法调用函数，请先使用任意指令`);
        await ai.context.systemUserIteration("调用函数返回", `暂时无法调用函数，请先提示用户使用任意指令`, []);
        return;
      }
      try {
        const tool = this.toolMap[name];
        const args = tool_call.arguments;
        if (args !== null && typeof args !== "object") {
          log(`调用函数失败:arguement不是一个object`);
          await ai.context.systemUserIteration("调用函数返回", `调用函数失败:arguement不是一个object`, []);
          return;
        }
        for (const key of tool.info.function.parameters.required) {
          if (!args.hasOwnProperty(key)) {
            log(`调用函数失败:缺少必需参数 ${key}`);
            await ai.context.systemUserIteration("调用函数返回", `调用函数失败:缺少必需参数 ${key}`, []);
            return;
          }
        }
        const s = await tool.solve(ctx, msg, ai, args);
        await ai.context.systemUserIteration("调用函数返回", s, []);
      } catch (e) {
        const s = `调用函数 (${name}:${JSON.stringify(tool_call.arguments, null, 2)}) 失败:${e.message}`;
        console.error(s);
        await ai.context.systemUserIteration("调用函数返回", s, []);
      }
    }
  };
  _ToolManager.cmdArgs = null;
  _ToolManager.toolMap = {};
  var ToolManager = _ToolManager;

  // src/utils/utils_message.ts
  function buildSystemMessage(ctx, ai) {
    const { roleSettingTemplate, showNumber } = ConfigManager.message;
    const { isTool, usePromptEngineering } = ConfigManager.tool;
    let [roleSettingIndex, _] = seal.vars.intGet(ctx, "$g人工智能插件专用角色设定序号");
    if (roleSettingIndex < 0 || roleSettingIndex >= roleSettingTemplate.length) {
      roleSettingIndex = 0;
    }
    let content = roleSettingTemplate[roleSettingIndex];
    if (!ctx.isPrivate) {
      content += `
**相关信息**
- 当前群聊:<${ctx.group.groupName}>${showNumber ? `(${ctx.group.groupId.replace(/\D+/g, "")})` : ``}
- <@xxx>表示@某个群成员，xxx为名字${showNumber ? `或者纯数字QQ号` : ``}`;
    } else {
      content += `
**相关信息**
- 当前私聊:<${ctx.player.name}>${showNumber ? `(${ctx.player.userId.replace(/\D+/g, "")})` : ``}`;
    }
    content += `- <|from:xxx${showNumber ? `(yyy)` : ``}|>表示消息来源，xxx为用户名字${showNumber ? `，yyy为纯数字QQ号` : ``}
- <|图片xxxxxx:yyy|>为图片，其中xxxxxx为6位的图片id，yyy为图片描述（可能没有），如果要发送出现过的图片请使用<|图片xxxxxx|>的格式`;
    const memeryPrompt = ai.memory.buildMemoryPrompt(ctx, ai.context);
    if (memeryPrompt) {
      content += `
**记忆**
如果记忆与上述设定冲突，请遵守角色设定。记忆如下:
${memeryPrompt}`;
    }
    if (isTool && usePromptEngineering) {
      const tools = ai.tool.getToolsInfo();
      const toolsPrompt = tools.map((item, index) => {
        return `${index + 1}. 名称:${item.function.name}
- 描述:${item.function.description}
- 参数信息:${JSON.stringify(item.function.parameters.properties, null, 2)}
- 必需参数:${item.function.parameters.required.join("\n")}`;
      });
      content += `
**调用函数**
当需要调用函数功能时，请严格使用以下格式：
\`\`\`
<function_call>
{
    "name": "函数名",
    "arguments": {
        "参数1": "值1",
        "参数2": "值2"
    }
}
</function_call>
\`\`\`
不要附带其他文本，且只能调用一次函数

可用函数列表: ${toolsPrompt}`;
    }
    const systemMessage = {
      role: "system",
      content,
      uid: "",
      name: "",
      timestamp: 0,
      images: []
    };
    return systemMessage;
  }
  function buildSamplesMessages(ctx) {
    const { samples } = ConfigManager.message;
    const samplesMessages = samples.map((item, index) => {
      if (item == "") {
        return null;
      } else if (index % 2 === 0) {
        return {
          role: "user",
          content: item,
          uid: "",
          name: "用户",
          timestamp: 0,
          images: []
        };
      } else {
        return {
          role: "assistant",
          content: item,
          uid: ctx.endPoint.userId,
          name: seal.formatTmpl(ctx, "核心:骰子名字"),
          timestamp: 0,
          images: []
        };
      }
    }).filter((item) => item !== null);
    return samplesMessages;
  }
  function handleMessages(ctx, ai) {
    const { isPrefix, showNumber, isMerge } = ConfigManager.message;
    const systemMessage = buildSystemMessage(ctx, ai);
    const samplesMessages = buildSamplesMessages(ctx);
    const messages = [systemMessage, ...samplesMessages, ...ai.context.messages];
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      if (!(message == null ? void 0 : message.tool_calls)) {
        continue;
      }
      const tool_call_id_set = /* @__PURE__ */ new Set();
      for (let j = i + 1; j < messages.length; j++) {
        if (messages[j].role !== "tool") {
          break;
        }
        tool_call_id_set.add(messages[j].tool_call_id);
      }
      for (let j = 0; j < message.tool_calls.length; j++) {
        const tool_call = message.tool_calls[j];
        if (!tool_call_id_set.has(tool_call.id)) {
          message.tool_calls.splice(j, 1);
          j--;
        }
      }
      if (message.tool_calls.length === 0) {
        messages.splice(i, 1);
        i--;
      }
    }
    let processedMessages = [];
    let last_role = "";
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      const prefix = isPrefix && message.name ? message.name.startsWith("_") ? `<|${message.name}|>` : `<|from:${message.name}${showNumber ? `(${message.uid.replace(/\D+/g, "")})` : ``}|>` : "";
      if (isMerge && message.role === last_role && message.role !== "tool") {
        processedMessages[processedMessages.length - 1].content += "\n" + prefix + message.content;
      } else {
        processedMessages.push({
          role: message.role,
          content: prefix + message.content,
          tool_calls: (message == null ? void 0 : message.tool_calls) ? message.tool_calls : void 0,
          tool_call_id: (message == null ? void 0 : message.tool_call_id) ? message.tool_call_id : void 0
        });
        last_role = message.role;
      }
    }
    return processedMessages;
  }

  // src/AI/service.ts
  async function sendChatRequest(ctx, msg, ai, messages, tool_choice) {
    const { url, apiKey, bodyTemplate } = ConfigManager.request;
    const { isTool, usePromptEngineering } = ConfigManager.tool;
    const tools = ai.tool.getToolsInfo();
    try {
      const bodyObject = parseBody(bodyTemplate, messages, tools, tool_choice);
      const time = Date.now();
      const data = await fetchData(url, apiKey, bodyObject);
      if (data.choices && data.choices.length > 0) {
        const model = data.model;
        const usage = data.usage;
        AIManager.updateUsage(model, usage);
        const message = data.choices[0].message;
        const finish_reason = data.choices[0].finish_reason;
        if (message.hasOwnProperty("reasoning_content")) {
          log(`思维链内容:`, message.reasoning_content);
        }
        const reply = message.content;
        log(`响应内容:`, reply, "\nlatency:", Date.now() - time, "ms", "\nfinish_reason:", finish_reason);
        if (isTool) {
          if (usePromptEngineering) {
            const match = reply.match(/<function_call>([\s\S]*?)<\/function_call>/);
            if (match) {
              ai.context.iteration(ctx, match[0], [], "assistant");
              const tool_call = JSON.parse(match[1]);
              await ToolManager.handlePromptToolCall(ctx, msg, ai, tool_call);
              const messages2 = handleMessages(ctx, ai);
              return await sendChatRequest(ctx, msg, ai, messages2, tool_choice);
            }
          } else {
            if (message.hasOwnProperty("tool_calls") && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
              log(`触发工具调用`);
              ai.context.toolCallsIteration(message.tool_calls);
              const tool_choice2 = await ToolManager.handleToolCalls(ctx, msg, ai, message.tool_calls);
              const messages2 = handleMessages(ctx, ai);
              return await sendChatRequest(ctx, msg, ai, messages2, tool_choice2);
            }
          }
        }
        return reply;
      } else {
        throw new Error("服务器响应中没有choices或choices为空");
      }
    } catch (error) {
      console.error("在sendChatRequest中出错：", error);
      return "";
    }
  }
  async function sendITTRequest(messages, useBase64) {
    const { url, apiKey, bodyTemplate, urlToBase64 } = ConfigManager.image;
    try {
      const bodyObject = parseBody(bodyTemplate, messages, null, null);
      const time = Date.now();
      const data = await fetchData(url, apiKey, bodyObject);
      if (data.choices && data.choices.length > 0) {
        const model = data.model;
        const usage = data.usage;
        AIManager.updateUsage(model, usage);
        const message = data.choices[0].message;
        const reply = message.content;
        log(`响应内容:`, reply, "\nlatency", Date.now() - time, "ms");
        return reply;
      } else {
        throw new Error("服务器响应中没有choices或choices为空");
      }
    } catch (error) {
      console.error("在imageToText中请求出错：", error);
      if (urlToBase64 === "自动" && !useBase64) {
        log(`自动尝试使用转换为base64`);
        for (let i = 0; i < messages.length; i++) {
          const message = messages[i];
          for (let j = 0; j < message.content.length; j++) {
            const content = message.content[j];
            if (content.type === "image_url") {
              const { base64, format } = await ImageManager.imageUrlToBase64(content.image_url.url);
              if (!base64 || !format) {
                log(`转换为base64失败`);
                return "";
              }
              message.content[j].image_url.url = `data:image/${format};base64,${base64}`;
            }
          }
        }
        return await sendITTRequest(messages, true);
      }
      return "";
    }
  }
  async function fetchData(url, apiKey, bodyObject) {
    const s = JSON.stringify(bodyObject.messages, (key, value) => {
      if (key === "" && Array.isArray(value)) {
        return value.filter((item) => {
          return item.role !== "system";
        });
      }
      return value;
    });
    log(`请求发送前的上下文:
`, s);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify(bodyObject)
    });
    const data = await response.json();
    if (!response.ok) {
      let s2 = `请求失败! 状态码: ${response.status}`;
      if (data.error) {
        s2 += `
错误信息: ${data.error.message}`;
      }
      s2 += `
响应体: ${JSON.stringify(data, null, 2)}`;
      throw new Error(s2);
    }
    const text = await response.text();
    if (!text) {
      throw new Error(`响应体为空!`);
    }
    return data;
  }
  function parseBody(template, messages, tools, tool_choice) {
    const { isTool, usePromptEngineering } = ConfigManager.tool;
    const bodyObject = {};
    for (let i = 0; i < template.length; i++) {
      const s = template[i];
      if (s.trim() === "") {
        continue;
      }
      try {
        const obj = JSON.parse(`{${s}}`);
        const key = Object.keys(obj)[0];
        bodyObject[key] = obj[key];
      } catch (err) {
        throw new Error(`解析body的【${s}】时出现错误:${err}`);
      }
    }
    if ((bodyObject == null ? void 0 : bodyObject.messages) === null) {
      bodyObject.messages = messages;
    }
    if ((bodyObject == null ? void 0 : bodyObject.stream) !== false) {
      console.error(`不支持流式传输，请将stream设置为false`);
      bodyObject.stream = false;
    }
    if (isTool && !usePromptEngineering) {
      if ((bodyObject == null ? void 0 : bodyObject.tools) === null) {
        bodyObject.tools = tools;
      }
      if ((bodyObject == null ? void 0 : bodyObject.tool_choice) === null) {
        bodyObject.tool_choice = tool_choice;
      }
    } else {
      bodyObject == null ? true : delete bodyObject.tools;
      bodyObject == null ? true : delete bodyObject.tool_choice;
    }
    return bodyObject;
  }

  // src/AI/image.ts
  var Image2 = class {
    constructor(file) {
      this.id = generateId();
      this.isUrl = file.startsWith("http");
      this.file = file;
      this.content = "";
    }
  };
  var ImageManager = class _ImageManager {
    constructor() {
      this.imageList = [];
      this.stealStatus = false;
    }
    static reviver(value) {
      const im = new _ImageManager();
      const validKeys = ["imageList", "stealStatus"];
      for (const k of validKeys) {
        if (value.hasOwnProperty(k)) {
          im[k] = value[k];
        }
      }
      return im;
    }
    updateImageList(images) {
      const { maxImageNum } = ConfigManager.image;
      this.imageList = this.imageList.concat(images.filter((item) => item.isUrl)).slice(-maxImageNum);
    }
    drawLocalImageFile() {
      const { localImagesTemplate } = ConfigManager.image;
      const localImages = localImagesTemplate.reduce((acc, item) => {
        const match = item.match(/<(.+)>.*/);
        if (match !== null) {
          const key = match[1];
          acc[key] = item.replace(/<.*>/g, "");
        }
        return acc;
      }, {});
      const keys = Object.keys(localImages);
      if (keys.length == 0) {
        return "";
      }
      const index = Math.floor(Math.random() * keys.length);
      return localImages[keys[index]];
    }
    async drawStolenImageFile() {
      if (this.imageList.length == 0) {
        return "";
      }
      const index = Math.floor(Math.random() * this.imageList.length);
      const image = this.imageList.splice(index, 1)[0];
      const url = image.file;
      if (!await _ImageManager.checkImageUrl(url)) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return await this.drawStolenImageFile();
      }
      return url;
    }
    async drawImageFile() {
      const { localImagesTemplate } = ConfigManager.image;
      const localImages = localImagesTemplate.reduce((acc, item) => {
        const match = item.match(/<(.+)>.*/);
        if (match !== null) {
          const key = match[1];
          acc[key] = item.replace(/<.*>/g, "");
        }
        return acc;
      }, {});
      const values = Object.values(localImages);
      if (this.imageList.length == 0 && values.length == 0) {
        return "";
      }
      const index = Math.floor(Math.random() * (values.length + this.imageList.length));
      if (index < values.length) {
        return values[index];
      } else {
        const image = this.imageList.splice(index - values.length, 1)[0];
        const url = image.file;
        if (!await _ImageManager.checkImageUrl(url)) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          return await this.drawImageFile();
        }
        return url;
      }
    }
    /**
     * 提取并替换CQ码中的图片
     * @param ctx 
     * @param message 
     * @returns 
     */
    static async handleImageMessage(ctx, message) {
      const images = [];
      const match = message.match(/\[CQ:image,file=(.*?)\]/g);
      if (match !== null) {
        for (let i = 0; i < match.length; i++) {
          try {
            const file = match[i].match(/\[CQ:image,file=(.*?)\]/)[1];
            const image = new Image2(file);
            message = message.replace(`[CQ:image,file=${file}]`, `<|图片${image.id}|>`);
            if (image.isUrl) {
              const { condition } = ConfigManager.image;
              const fmtCondition = parseInt(seal.format(ctx, `{${condition}}`));
              if (fmtCondition === 1) {
                const reply = await _ImageManager.imageToText(file);
                if (reply) {
                  image.content = reply;
                  message = message.replace(`<|图片${image.id}|>`, `<|图片${image.id}:${reply}|>`);
                }
              }
            }
            images.push(image);
          } catch (error) {
            console.error("Error in imageToText:", error);
          }
        }
      }
      return { message, images };
    }
    static async checkImageUrl(url) {
      let isValid = false;
      try {
        const response = await fetch(url, { method: "GET" });
        if (response.ok) {
          const contentType = response.headers.get("Content-Type");
          if (contentType && contentType.startsWith("image")) {
            log("URL有效且未过期");
            isValid = true;
          } else {
            log(`URL有效但未返回图片 Content-Type: ${contentType}`);
          }
        } else {
          if (response.status === 500) {
            log(`URL不知道有没有效 状态码: ${response.status}`);
            isValid = true;
          } else {
            log(`URL无效或过期 状态码: ${response.status}`);
          }
        }
      } catch (error) {
        console.error("Error checking URL:", error);
      }
      return isValid;
    }
    static async imageToText(imageUrl, text = "") {
      const { urlToBase64 } = ConfigManager.image;
      let useBase64 = false;
      let imageContent = {
        "type": "image_url",
        "image_url": { "url": imageUrl }
      };
      if (urlToBase64 == "总是") {
        const { base64, format } = await _ImageManager.imageUrlToBase64(imageUrl);
        if (!base64 || !format) {
          log(`转换为base64失败`);
          return "";
        }
        useBase64 = true;
        imageContent = {
          "type": "image_url",
          "image_url": { "url": `data:image/${format};base64,${base64}` }
        };
      }
      const textContent = {
        "type": "text",
        "text": text ? text : "请帮我用简短的语言概括这张图片的特征，包括图片类型、场景、主题、主体等信息，如果有文字，请全部输出"
      };
      const messages = [{
        role: "user",
        content: [imageContent, textContent]
      }];
      const { maxChars } = ConfigManager.image;
      const raw_reply = await sendITTRequest(messages, useBase64);
      const reply = raw_reply.slice(0, maxChars);
      return reply;
    }
    static async imageUrlToBase64(imageUrl) {
      const url = "http://110.41.69.149:46678/image-to-base64";
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json"
          },
          body: JSON.stringify({ url: imageUrl })
        });
        const data = await response.json();
        if (!response.ok) {
          let s = `请求失败! 状态码: ${response.status}`;
          if (data.error) {
            s += `
错误信息: ${data.error.message}`;
          }
          s += `
响应体: ${JSON.stringify(data, null, 2)}`;
          throw new Error(s);
        }
        if (!data.base64 || !data.format) {
          throw new Error(`响应体中缺少base64或format字段`);
        }
        return data;
      } catch (error) {
        console.error("在imageUrlToBase64中请求出错：", error);
        return { base64: "", format: "" };
      }
    }
  };

  // src/AI/context.ts
  var Context = class _Context {
    constructor() {
      this.messages = [];
      this.lastReply = "";
      this.counter = 0;
      this.timer = null;
    }
    static reviver(value) {
      const context = new _Context();
      const validKeys = ["messages"];
      for (const k of validKeys) {
        if (value.hasOwnProperty(k)) {
          context[k] = value[k];
        }
      }
      return context;
    }
    async iteration(ctx, s, images, role) {
      var _a;
      const messages = this.messages;
      if (role === "user" && messages.length !== 0 && messages[messages.length - 1].role === "assistant" && ((_a = messages[messages.length - 1]) == null ? void 0 : _a.tool_calls)) {
        return;
      }
      const { showNumber, maxRounds } = ConfigManager.message;
      s = s.replace(/\[CQ:reply,id=-?\d+\]\[CQ:at,qq=\d+\]/g, "").replace(/\[CQ:at,qq=(\d+)\]/g, (_, p1) => {
        const epId = ctx.endPoint.userId;
        const gid = ctx.group.groupId;
        const uid2 = `QQ:${p1}`;
        if (showNumber) {
          return `<@${uid2.replace(/\D+/g, "")}>`;
        }
        const mmsg = createMsg(gid === "" ? "private" : "group", uid2, gid);
        const mctx = createCtx(epId, mmsg);
        const name2 = mctx.player.name || "未知用户";
        return `<@${name2}>`;
      }).replace(/\[CQ:.*?\]/g, "");
      if (s === "") {
        return;
      }
      const name = role == "user" ? ctx.player.name : seal.formatTmpl(ctx, "核心:骰子名字");
      const uid = role == "user" ? ctx.player.userId : ctx.endPoint.userId;
      const length = messages.length;
      if (length !== 0 && messages[length - 1].name === name) {
        messages[length - 1].content += " " + s;
        messages[length - 1].timestamp = Math.floor(Date.now() / 1e3);
        messages[length - 1].images.push(...images);
      } else {
        const message = {
          role,
          content: s,
          uid,
          name,
          timestamp: Math.floor(Date.now() / 1e3),
          images
        };
        messages.push(message);
      }
      this.limitMessages(maxRounds);
    }
    async toolCallsIteration(tool_calls) {
      const message = {
        role: "assistant",
        content: "",
        tool_calls,
        uid: "",
        name: "",
        timestamp: Math.floor(Date.now() / 1e3),
        images: []
      };
      this.messages.push(message);
    }
    async toolIteration(tool_call_id, s) {
      var _a;
      const message = {
        role: "tool",
        content: s,
        tool_call_id,
        uid: "",
        name: "",
        timestamp: Math.floor(Date.now() / 1e3),
        images: []
      };
      for (let i = this.messages.length - 1; i >= 0; i--) {
        if (((_a = this.messages[i]) == null ? void 0 : _a.tool_calls) && this.messages[i].tool_calls.some((tool_call) => tool_call.id === tool_call_id)) {
          this.messages.splice(i + 1, 0, message);
          return;
        }
      }
      console.error(`在添加时找不到对应的 tool_call_id: ${tool_call_id}`);
    }
    async systemUserIteration(name, s, images) {
      const message = {
        role: "user",
        content: s,
        uid: "",
        name: `_${name}`,
        timestamp: Math.floor(Date.now() / 1e3),
        images
      };
      this.messages.push(message);
    }
    async limitMessages(maxRounds) {
      const messages = this.messages;
      let round = 0;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user" && !messages[i].name.startsWith("_")) {
          round++;
        }
        if (round > maxRounds) {
          messages.splice(0, i);
          break;
        }
      }
    }
    async findUserId(ctx, name, findInFriendList = false) {
      if (name.length > 4 && !isNaN(parseInt(name))) {
        return `QQ:${name}`;
      }
      const match = name.match(/^<([^>]+?)>(?:\(\d+\))?$|(.+?)\(\d+\)$/);
      if (match) {
        name = match[1] || match[2];
      }
      if (name === ctx.player.name) {
        return ctx.player.userId;
      }
      const messages = this.messages;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (name === messages[i].name) {
          return messages[i].uid;
        }
        if (name.length > 4) {
          const distance = levenshteinDistance(name, messages[i].name);
          if (distance <= 2) {
            return messages[i].uid;
          }
        }
      }
      const ext = seal.ext.find("HTTP依赖");
      if (ext) {
        const epId = ctx.endPoint.userId;
        if (!ctx.isPrivate) {
          const gid = ctx.group.groupId;
          const data = await globalThis.http.getData(epId, `get_group_member_list?group_id=${gid.replace(/\D+/g, "")}`);
          for (let i = 0; i < data.length; i++) {
            if (name === data[i].card || name === data[i].nickname) {
              return `QQ:${data[i].user_id}`;
            }
          }
        }
        if (findInFriendList) {
          const data = await globalThis.http.getData(epId, "get_friend_list");
          for (let i = 0; i < data.length; i++) {
            if (name === data[i].nickname || name === data[i].remark) {
              return `QQ:${data[i].user_id}`;
            }
          }
        }
      }
      if (name.length > 4) {
        const distance = levenshteinDistance(name, ctx.player.name);
        if (distance <= 2) {
          return ctx.player.userId;
        }
      }
      log(`未找到用户<${name}>`);
      return null;
    }
    async findGroupId(ctx, groupName) {
      if (groupName.length > 5 && !isNaN(parseInt(groupName))) {
        return `QQ-Group:${groupName}`;
      }
      const match = groupName.match(/^<([^>]+?)>(?:\(\d+\))?$|(.+?)\(\d+\)$/);
      if (match) {
        groupName = match[1] || match[2];
      }
      if (groupName === ctx.group.groupName) {
        return ctx.group.groupId;
      }
      const messages = this.messages;
      const userSet = /* @__PURE__ */ new Set();
      for (let i = messages.length - 1; i >= 0; i--) {
        const uid = messages[i].uid;
        if (userSet.has(uid) || messages[i].role !== "user") {
          continue;
        }
        const name = messages[i].name;
        if (name.startsWith("_")) {
          continue;
        }
        const ai = AIManager.getAI(uid);
        const memoryList = ai.memory.memoryList;
        for (const memory of memoryList) {
          if (memory.group.groupName === groupName) {
            return memory.group.groupId;
          }
          if (memory.group.groupName.length > 4) {
            const distance = levenshteinDistance(groupName, memory.group.groupName);
            if (distance <= 2) {
              return memory.group.groupId;
            }
          }
        }
        userSet.add(uid);
      }
      const ext = seal.ext.find("HTTP依赖");
      if (ext) {
        const epId = ctx.endPoint.userId;
        const data = await globalThis.http.getData(epId, "get_group_list");
        for (let i = 0; i < data.length; i++) {
          if (groupName === data[i].group_name) {
            return `QQ-Group:${data[i].group_id}`;
          }
        }
      }
      if (groupName.length > 4) {
        const distance = levenshteinDistance(groupName, ctx.group.groupName);
        if (distance <= 2) {
          return ctx.group.groupId;
        }
      }
      log(`未找到群聊<${groupName}>`);
      return null;
    }
    getNames() {
      const names = [];
      for (const message of this.messages) {
        if (message.role === "user" && message.name && !names.includes(message.name)) {
          names.push(message.name);
        }
      }
      return names;
    }
    findImage(id) {
      const messages = this.messages;
      for (let i = messages.length - 1; i >= 0; i--) {
        const image = messages[i].images.find((item) => item.id === id);
        if (image) {
          return image;
        }
      }
      return null;
    }
  };

  // src/AI/memory.ts
  var Memory = class _Memory {
    constructor() {
      if (Math.random() < 0.5) {
        this.persona = "好人";
      } else {
        this.persona = "坏人";
      }
      this.memoryList = [];
    }
    static reviver(value) {
      const memory = new _Memory();
      const validKeys = ["persona", "memoryList"];
      for (const k in value) {
        if (validKeys.includes(k)) {
          memory[k] = value[k];
        }
      }
      return memory;
    }
    setSystemMemory(s) {
      if (!s) {
        if (Math.random() < 0.5) {
          s = "好人";
        } else {
          s = "坏人";
        }
      }
      this.persona = s;
    }
    addMemory(ctx, content) {
      const { memoryLimit } = ConfigManager.tool;
      content = content.slice(0, 100);
      this.memoryList.push({
        isPrivate: ctx.group.groupName ? false : true,
        player: {
          userId: ctx.player.userId,
          name: ctx.player.name
        },
        group: {
          groupId: ctx.group.groupId,
          groupName: ctx.group.groupName
        },
        time: (/* @__PURE__ */ new Date()).toLocaleString(),
        content
      });
      this.memoryList.splice(0, this.memoryList.length - memoryLimit);
    }
    buildPersonMemoryPrompt() {
      const { showNumber } = ConfigManager.message;
      let s = `
- 设定:${this.persona}
- 记忆:
`;
      if (this.memoryList.length === 0) {
        s += "无";
      } else {
        s += this.memoryList.map((item, i) => {
          return `${i + 1}. (${item.time}) ${item.isPrivate ? `来自私聊` : `来自群聊<${item.group.groupName}>${showNumber ? `(${item.group.groupId.replace(/\D+/g, "")})` : ``}`}: ${item.content}`;
        }).join("\n");
      }
      return s;
    }
    buildGroupMemoryPrompt() {
      let s = `
- 记忆:
`;
      if (this.memoryList.length === 0) {
        s += "无";
      } else {
        s += this.memoryList.map((item, i) => {
          return `${i + 1}. (${item.time}) ${item.content}`;
        }).join("\n");
      }
      return s;
    }
    buildMemoryPrompt(ctx, context) {
      const { showNumber } = ConfigManager.message;
      if (ctx.isPrivate) {
        return this.buildPersonMemoryPrompt();
      } else {
        const gid = ctx.group.groupId;
        let s = `
- 关于群聊:<${ctx.group.groupName}>${showNumber ? `(${gid.replace(/\D+/g, "")})` : ``}:`;
        s += this.buildGroupMemoryPrompt();
        const arr = [];
        for (const message of context.messages) {
          const uid = message.uid;
          if (arr.includes(uid) || message.role !== "user") {
            continue;
          }
          const name = message.name;
          if (name.startsWith("_")) {
            continue;
          }
          const ai = AIManager.getAI(uid);
          s += `

关于<${name}>${showNumber ? `(${uid.replace(/\D+/g, "")})` : ``}:`;
          s += ai.memory.buildPersonMemoryPrompt();
          arr.push(uid);
        }
        return s;
      }
    }
    clearMemory() {
      this.memoryList = [];
    }
  };

  // src/AI/AI.ts
  var AI2 = class _AI {
    constructor(id) {
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
      this.listen = {
        // 监听调用函数发送的内容
        status: false,
        content: ""
      };
      this.isChatting = false;
    }
    static reviver(value, id) {
      const ai = new _AI(id);
      const validKeys = ["context", "tool", "memory", "image", "privilege"];
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
    async getReply(ctx, msg, retry = 0) {
      const messages = handleMessages(ctx, this);
      const raw_reply = await sendChatRequest(ctx, msg, this, messages, "auto");
      const { s, isRepeat, reply, images } = await handleReply(ctx, msg, raw_reply, this.context);
      if (isRepeat && reply !== "") {
        if (retry == 3) {
          log(`发现复读，已达到最大重试次数，清除AI上下文`);
          this.context.messages = this.context.messages.filter((item) => item.role !== "assistant" && item.role !== "tool");
          return { s: "", reply: "", images: [] };
        }
        retry++;
        log(`发现复读，一秒后进行重试:[${retry}/3]`);
        await new Promise((resolve) => setTimeout(resolve, 1e3));
        return await this.getReply(ctx, msg, retry);
      }
      return { s, reply, images };
    }
    async chat(ctx, msg) {
      if (this.isChatting) {
        log(this.id, `正在处理消息，跳过`);
        return;
      }
      this.isChatting = true;
      const timeout = setTimeout(() => {
        this.isChatting = false;
        log(this.id, `处理消息超时`);
      }, 60 * 1e3);
      this.clearData();
      let { s, reply, images } = await this.getReply(ctx, msg);
      this.context.lastReply = reply;
      await this.context.iteration(ctx, s, images, "assistant");
      seal.replyToSender(ctx, msg, reply);
      const { p } = ConfigManager.image;
      if (Math.random() * 100 <= p) {
        const file = await this.image.drawImageFile();
        if (file) {
          seal.replyToSender(ctx, msg, `[CQ:image,file=${file}]`);
        }
      }
      clearTimeout(timeout);
      this.isChatting = false;
    }
  };
  var AIManager = class {
    static clearCache() {
      this.cache = {};
    }
    static getAI(id) {
      if (!this.cache.hasOwnProperty(id)) {
        let data = new AI2(id);
        try {
          data = JSON.parse(ConfigManager.ext.storageGet(`AI_${id}`) || "{}", (key, value) => {
            if (key === "") {
              return AI2.reviver(value, id);
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
    static saveAI(id) {
      if (this.cache.hasOwnProperty(id)) {
        ConfigManager.ext.storageSet(`AI_${id}`, JSON.stringify(this.cache[id]));
      }
    }
    static clearUsageMap() {
      this.usageMap = {};
    }
    static clearExpiredUsage(model) {
      const now = /* @__PURE__ */ new Date();
      const currentYear = now.getFullYear();
      const currentMonth = now.getMonth() + 1;
      const currentDay = now.getDate();
      const currentYM = currentYear * 12 + currentMonth;
      const currentYMD = currentYear * 12 * 31 + currentMonth * 31 + currentDay;
      if (!this.usageMap.hasOwnProperty(model)) {
        return;
      }
      for (const key in this.usageMap[model]) {
        const [year, month, day] = key.split("-").map(Number);
        const ym = year * 12 + month;
        const ymd = year * 12 * 31 + month * 31 + day;
        let newKey = "";
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
        const usage = JSON.parse(ConfigManager.ext.storageGet("usageMap") || "{}");
        this.usageMap = usage;
      } catch (error) {
        console.error(`从数据库中获取usageMap失败:`, error);
      }
    }
    static saveUsageMap() {
      ConfigManager.ext.storageSet("usageMap", JSON.stringify(this.usageMap));
    }
    static updateUsage(model, usage) {
      const now = /* @__PURE__ */ new Date();
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
    static getModelUsage(model) {
      if (!this.usageMap.hasOwnProperty(model)) {
        return {
          prompt_tokens: 0,
          completion_tokens: 0
        };
      }
      const usage = {
        prompt_tokens: 0,
        completion_tokens: 0
      };
      for (const key in this.usageMap[model]) {
        usage.prompt_tokens += this.usageMap[model][key].prompt_tokens;
        usage.completion_tokens += this.usageMap[model][key].completion_tokens;
      }
      return usage;
    }
  };
  AIManager.cache = {};
  AIManager.usageMap = {};

  // src/index.ts
  function main() {
    let ext = seal.ext.find("aiplugin4");
    if (!ext) {
      ext = seal.ext.new("aiplugin4", "baiyu&错误", "4.5.14");
      seal.ext.register(ext);
    }
    try {
      JSON.parse(ext.storageGet(`timerQueue`) || "[]").forEach((item) => {
        timerQueue.push(item);
      });
    } catch (e) {
      console.error("在获取timerQueue时出错", e);
    }
    ConfigManager.ext = ext;
    ConfigManager.registerConfig();
    AIManager.getUsageMap();
    ToolManager.registerTool();
    const CQTypesAllow = ["at", "image", "reply", "face"];
    const cmdAI = seal.ext.newCmdItemInfo();
    cmdAI.name = "ai";
    cmdAI.help = `帮助:
【.ai st】修改权限(仅骰主可用)
【.ai ck】检查权限(仅骰主可用)
【.ai prompt】检查当前prompt(仅骰主可用)
【.ai pr】查看当前群聊权限
【.ai ctxn】查看上下文里的名字
【.ai on】开启AI
【.ai sb】开启待机模式，此时AI将记忆聊天内容
【.ai off】关闭AI，此时仍能用关键词触发
【.ai fgt】遗忘上下文
【.ai memo】AI的记忆相关
【.ai tool】AI的工具相关
【.ai tk】AI的token相关`;
    cmdAI.allowDelegate = true;
    cmdAI.solve = (ctx, msg, cmdArgs) => {
      const val = cmdArgs.getArgN(1);
      const uid = ctx.player.userId;
      const gid = ctx.group.groupId;
      const id = ctx.isPrivate ? uid : gid;
      const ret = seal.ext.newCmdExecuteResult(true);
      const ai = AIManager.getAI(id);
      switch (val) {
        case "st": {
          if (ctx.privilegeLevel < 100) {
            seal.replyToSender(ctx, msg, seal.formatTmpl(ctx, "核心:提示_无权限"));
            return ret;
          }
          const val2 = cmdArgs.getArgN(2);
          if (!val2 || val2 == "help") {
            const s = `帮助:
【.ai st <ID> <权限限制>】

<ID>:
【QQ:1234567890】 私聊窗口
【QQ-Group:1234】 群聊窗口
【now】当前窗口

<权限限制>:
【0】普通用户
【40】邀请者
【50】群管理员
【60】群主
【100】骰主
不填写时默认为0`;
            seal.replyToSender(ctx, msg, s);
            return ret;
          }
          const limit = parseInt(cmdArgs.getArgN(3));
          if (isNaN(limit)) {
            seal.replyToSender(ctx, msg, "权限值必须为数字");
            return ret;
          }
          const id2 = val2 === "now" ? id : val2;
          const ai2 = AIManager.getAI(id2);
          ai2.privilege.limit = limit;
          seal.replyToSender(ctx, msg, "权限修改完成");
          AIManager.saveAI(id2);
          return ret;
        }
        case "ck": {
          if (ctx.privilegeLevel < 100) {
            seal.replyToSender(ctx, msg, seal.formatTmpl(ctx, "核心:提示_无权限"));
            return ret;
          }
          const val2 = cmdArgs.getArgN(2);
          if (!val2 || val2 == "help") {
            const s2 = `帮助:
【.ai ck <ID>】

<ID>:
【QQ:1234567890】 私聊窗口
【QQ-Group:1234】 群聊窗口
【now】当前窗口`;
            seal.replyToSender(ctx, msg, s2);
            return ret;
          }
          const id2 = val2 === "now" ? id : val2;
          const ai2 = AIManager.getAI(id2);
          const pr = ai2.privilege;
          const counter = pr.counter > -1 ? `${pr.counter}条` : "关闭";
          const timer = pr.timer > -1 ? `${pr.timer}秒` : "关闭";
          const prob = pr.prob > -1 ? `${pr.prob}%` : "关闭";
          const standby = pr.standby ? "开启" : "关闭";
          const s = `${id2}
权限限制:${pr.limit}
计数器模式(c):${counter}
计时器模式(t):${timer}
概率模式(p):${prob}
待机模式:${standby}`;
          seal.replyToSender(ctx, msg, s);
          return ret;
        }
        case "prompt": {
          if (ctx.privilegeLevel < 100) {
            seal.replyToSender(ctx, msg, seal.formatTmpl(ctx, "核心:提示_无权限"));
            return ret;
          }
          const systemMessage = buildSystemMessage(ctx, ai);
          seal.replyToSender(ctx, msg, systemMessage.content);
          return ret;
        }
        case "pr": {
          const pr = ai.privilege;
          if (ctx.privilegeLevel < pr.limit) {
            seal.replyToSender(ctx, msg, seal.formatTmpl(ctx, "核心:提示_无权限"));
            return ret;
          }
          const counter = pr.counter > -1 ? `${pr.counter}条` : "关闭";
          const timer = pr.timer > -1 ? `${pr.timer}秒` : "关闭";
          const prob = pr.prob > -1 ? `${pr.prob}%` : "关闭";
          const standby = pr.standby ? "开启" : "关闭";
          const s = `${id}
权限限制:${pr.limit}
计数器模式(c):${counter}
计时器模式(t):${timer}
概率模式(p):${prob}
待机模式:${standby}`;
          seal.replyToSender(ctx, msg, s);
          return ret;
        }
        case "ctxn": {
          const pr = ai.privilege;
          if (ctx.privilegeLevel < pr.limit) {
            seal.replyToSender(ctx, msg, seal.formatTmpl(ctx, "核心:提示_无权限"));
            return ret;
          }
          const names = ai.context.getNames();
          const s = `上下文里的名字有：
<${names.join(">\n<")}>`;
          seal.replyToSender(ctx, msg, s);
          return ret;
        }
        case "on": {
          const pr = ai.privilege;
          if (ctx.privilegeLevel < pr.limit) {
            seal.replyToSender(ctx, msg, seal.formatTmpl(ctx, "核心:提示_无权限"));
            return ret;
          }
          const kwargs = cmdArgs.kwargs;
          if (kwargs.length == 0) {
            const s = `帮助:
【.ai on --<参数>=<数字>】

<参数>:
【c】计数器模式，接收消息数达到后触发。
单位/条，默认10条
【t】计时器模式，最后一条消息后达到时限触发
单位/秒，默认60秒
【p】概率模式，每条消息按概率触发
单位/%，默认10%

【.ai on --t --p=42】使用示例`;
            seal.replyToSender(ctx, msg, s);
            return ret;
          }
          let text = `AI已开启：`;
          kwargs.forEach((kwarg) => {
            const name = kwarg.name;
            const exist = kwarg.valueExists;
            const value = parseFloat(kwarg.value);
            switch (name) {
              case "c":
              case "counter": {
                pr.counter = exist && !isNaN(value) ? value : 10;
                text += `
计数器模式:${pr.counter}条`;
                break;
              }
              case "t":
              case "timer": {
                pr.timer = exist && !isNaN(value) ? value : 60;
                text += `
计时器模式:${pr.timer}秒`;
                break;
              }
              case "p":
              case "prob": {
                pr.prob = exist && !isNaN(value) ? value : 10;
                text += `
概率模式:${pr.prob}%`;
                break;
              }
            }
          });
          pr.standby = true;
          seal.replyToSender(ctx, msg, text);
          AIManager.saveAI(id);
          return ret;
        }
        case "sb": {
          const pr = ai.privilege;
          if (ctx.privilegeLevel < pr.limit) {
            seal.replyToSender(ctx, msg, seal.formatTmpl(ctx, "核心:提示_无权限"));
            return ret;
          }
          pr.counter = -1;
          pr.timer = -1;
          pr.prob = -1;
          pr.standby = true;
          ai.clearData();
          seal.replyToSender(ctx, msg, "AI已开启待机模式");
          AIManager.saveAI(id);
          return ret;
        }
        case "off": {
          const pr = ai.privilege;
          if (ctx.privilegeLevel < pr.limit) {
            seal.replyToSender(ctx, msg, seal.formatTmpl(ctx, "核心:提示_无权限"));
            return ret;
          }
          const kwargs = cmdArgs.kwargs;
          if (kwargs.length == 0) {
            pr.counter = -1;
            pr.timer = -1;
            pr.prob = -1;
            pr.standby = false;
            ai.clearData();
            seal.replyToSender(ctx, msg, "AI已关闭");
            AIManager.saveAI(id);
            return ret;
          }
          let text = `AI已关闭：`;
          kwargs.forEach((kwarg) => {
            const name = kwarg.name;
            switch (name) {
              case "c":
              case "counter": {
                pr.counter = -1;
                text += `
计数器模式`;
                break;
              }
              case "t":
              case "timer": {
                pr.timer = -1;
                text += `
计时器模式`;
                break;
              }
              case "p":
              case "prob": {
                pr.prob = -1;
                text += `
概率模式`;
                break;
              }
            }
          });
          ai.clearData();
          seal.replyToSender(ctx, msg, text);
          AIManager.saveAI(id);
          return ret;
        }
        case "f":
        case "fgt": {
          const pr = ai.privilege;
          if (ctx.privilegeLevel < pr.limit) {
            seal.replyToSender(ctx, msg, seal.formatTmpl(ctx, "核心:提示_无权限"));
            return ret;
          }
          ai.clearData();
          const val2 = cmdArgs.getArgN(2);
          const messages = ai.context.messages;
          switch (val2) {
            case "ass":
            case "assistant": {
              ai.context.messages = messages.filter((item) => item.role !== "assistant");
              seal.replyToSender(ctx, msg, "ai上下文已清除");
              AIManager.saveAI(id);
              return ret;
            }
            case "user": {
              ai.context.messages = messages.filter((item) => item.role !== "user");
              seal.replyToSender(ctx, msg, "用户上下文已清除");
              AIManager.saveAI(id);
              return ret;
            }
            default: {
              ai.context.messages = [];
              seal.replyToSender(ctx, msg, "上下文已清除");
              AIManager.saveAI(id);
              return ret;
            }
          }
        }
        case "memo": {
          const mctx = seal.getCtxProxyFirst(ctx, cmdArgs);
          const muid = mctx.player.userId;
          if (ctx.privilegeLevel < 100 && muid !== uid) {
            seal.replyToSender(ctx, msg, seal.formatTmpl(ctx, "核心:提示_无权限"));
            return ret;
          }
          const ai2 = AIManager.getAI(muid);
          const val2 = cmdArgs.getArgN(2);
          switch (val2) {
            case "st": {
              const s = cmdArgs.getRestArgsFrom(3);
              if (s.length > 20) {
                seal.replyToSender(ctx, msg, "记忆过长，请控制在20字以内");
                return ret;
              }
              ai2.memory.setSystemMemory(s);
              seal.replyToSender(ctx, msg, "记忆已添加");
              AIManager.saveAI(muid);
              return ret;
            }
            case "clr": {
              const val3 = cmdArgs.getArgN(3);
              if (val3 === "group") {
                if (ctx.isPrivate) {
                  seal.replyToSender(ctx, msg, "群聊记忆仅在群聊可用");
                  return ret;
                }
                ai.memory.clearMemory();
                seal.replyToSender(ctx, msg, "群聊记忆已清除");
                AIManager.saveAI(id);
                return ret;
              }
              ai2.memory.clearMemory();
              seal.replyToSender(ctx, msg, "记忆已清除");
              AIManager.saveAI(muid);
              return ret;
            }
            case "show": {
              const val3 = cmdArgs.getArgN(3);
              if (val3 === "group") {
                if (ctx.isPrivate) {
                  seal.replyToSender(ctx, msg, "群聊记忆仅在群聊可用");
                  return ret;
                }
                if (ai.memory.memoryList.length === 0) {
                  seal.replyToSender(ctx, msg, "暂无群聊记忆");
                  return ret;
                }
                const s2 = ai.memory.buildGroupMemoryPrompt();
                seal.replyToSender(ctx, msg, s2);
                return ret;
              }
              if (ai2.memory.memoryList.length === 0) {
                seal.replyToSender(ctx, msg, "暂无记忆");
                return ret;
              }
              const s = ai2.memory.buildPersonMemoryPrompt();
              seal.replyToSender(ctx, msg, s);
              return ret;
            }
            default: {
              const s = `帮助:
【.ai memo st <内容>】设置记忆
【.ai memo clr】清除记忆
【.ai memo clr group】清除群聊记忆
【.ai memo show】展示个人记忆
【.ai memo show group】展示群聊记忆`;
              seal.replyToSender(ctx, msg, s);
              return ret;
            }
          }
        }
        case "tool": {
          const val2 = cmdArgs.getArgN(2);
          switch (val2) {
            case "": {
              const toolStatus = ai.tool.toolStatus;
              let i = 1;
              let s = "工具函数如下:";
              Object.keys(toolStatus).forEach((key) => {
                const status = toolStatus[key] ? "开" : "关";
                s += `
${i++}. ${key}[${status}]`;
              });
              seal.replyToSender(ctx, msg, s);
              return ret;
            }
            case "help": {
              const val3 = cmdArgs.getArgN(3);
              if (!val3) {
                const s2 = `帮助:
【.ai tool】列出所有工具
【.ai tool help <函数名>】查看工具详情
【.ai tool [on/off]】开启或关闭全部工具函数
【.ai tool <函数名> [on/off]】开启或关闭工具函数
【.ai tool <函数名> --参数名=具体参数】试用工具函数
`;
                seal.replyToSender(ctx, msg, s2);
                return ret;
              }
              if (!ToolManager.toolMap.hasOwnProperty(val3)) {
                seal.replyToSender(ctx, msg, "没有这个工具函数");
                return ret;
              }
              const tool = ToolManager.toolMap[val3];
              const s = `${tool.info.function.name}
描述:${tool.info.function.description}

参数:
${Object.keys(tool.info.function.parameters.properties).map((key) => {
                const property = tool.info.function.parameters.properties[key];
                return `【${key}】${property.description}`;
              }).join("\n")}

必需参数:${tool.info.function.parameters.required.join(",")}`;
              seal.replyToSender(ctx, msg, s);
              return ret;
            }
            case "on": {
              const toolsNotAllow = ConfigManager.tool.toolsNotAllow;
              for (const key in ai.tool.toolStatus) {
                ai.tool.toolStatus[key] = toolsNotAllow.includes(key) ? false : true;
              }
              seal.replyToSender(ctx, msg, "已开启全部工具函数");
              AIManager.saveAI(id);
              return ret;
            }
            case "off": {
              for (const key in ai.tool.toolStatus) {
                ai.tool.toolStatus[key] = false;
              }
              seal.replyToSender(ctx, msg, "已关闭全部工具函数");
              AIManager.saveAI(id);
              return ret;
            }
            default: {
              if (!ToolManager.toolMap.hasOwnProperty(val2)) {
                seal.replyToSender(ctx, msg, "没有这个工具函数");
                return ret;
              }
              const val3 = cmdArgs.getArgN(3);
              if (val3 === "on") {
                const toolsNotAllow = ConfigManager.tool.toolsNotAllow;
                if (toolsNotAllow.includes(val2)) {
                  seal.replyToSender(ctx, msg, `工具函数 ${val2} 不被允许开启`);
                  return ret;
                }
                ai.tool.toolStatus[val2] = true;
                seal.replyToSender(ctx, msg, `已开启工具函数 ${val2}`);
                AIManager.saveAI(id);
                return ret;
              } else if (val3 === "off") {
                ai.tool.toolStatus[val2] = false;
                seal.replyToSender(ctx, msg, `已关闭工具函数 ${val2}`);
                AIManager.saveAI(id);
                return ret;
              }
              if (ctx.privilegeLevel < 100) {
                seal.replyToSender(ctx, msg, seal.formatTmpl(ctx, "核心:提示_无权限"));
                return ret;
              }
              if (ToolManager.cmdArgs == null) {
                seal.replyToSender(ctx, msg, `暂时无法调用函数，请先使用任意指令`);
                return ret;
              }
              const tool = ToolManager.toolMap[val2];
              try {
                const args = cmdArgs.kwargs.reduce((acc, kwarg) => {
                  const valueString = kwarg.value;
                  try {
                    acc[kwarg.name] = JSON.parse(`[${valueString}]`)[0];
                  } catch (e) {
                    acc[kwarg.name] = valueString;
                  }
                  return acc;
                }, {});
                for (const key of tool.info.function.parameters.required) {
                  if (!args.hasOwnProperty(key)) {
                    log(`调用函数失败:缺少必需参数 ${key}`);
                    seal.replyToSender(ctx, msg, `调用函数失败:缺少必需参数 ${key}`);
                    return ret;
                  }
                }
                tool.solve(ctx, msg, ai, args).then((s) => {
                  seal.replyToSender(ctx, msg, s);
                });
                return ret;
              } catch (e) {
                const s = `调用函数 (${val2}) 失败:${e.message}`;
                seal.replyToSender(ctx, msg, s);
                return ret;
              }
            }
          }
        }
        case "tk": {
          if (ctx.privilegeLevel < 100) {
            seal.replyToSender(ctx, msg, seal.formatTmpl(ctx, "核心:提示_无权限"));
            return ret;
          }
          const val2 = cmdArgs.getArgN(2);
          switch (val2) {
            case "lst": {
              const s = Object.keys(AIManager.usageMap).join("\n");
              seal.replyToSender(ctx, msg, `有使用记录的模型:
${s}`);
              return ret;
            }
            case "sum": {
              const usage = {
                prompt_tokens: 0,
                completion_tokens: 0
              };
              for (const model in AIManager.usageMap) {
                const modelUsage = AIManager.getModelUsage(model);
                usage.prompt_tokens += modelUsage.prompt_tokens;
                usage.completion_tokens += modelUsage.completion_tokens;
              }
              if (usage.prompt_tokens === 0 && usage.completion_tokens === 0) {
                seal.replyToSender(ctx, msg, `没有使用记录`);
                return ret;
              }
              const s = `输入token:${usage.prompt_tokens}
输出token:${usage.completion_tokens}
总token:${usage.prompt_tokens + usage.completion_tokens}`;
              seal.replyToSender(ctx, msg, s);
              return ret;
            }
            case "all": {
              const s = Object.keys(AIManager.usageMap).map((model, index) => {
                const usage = AIManager.getModelUsage(model);
                if (usage.prompt_tokens === 0 && usage.completion_tokens === 0) {
                  return `${index + 1}. ${model}: 没有使用记录`;
                }
                return `${index + 1}. ${model}:
  输入token:${usage.prompt_tokens}
  输出token:${usage.completion_tokens}
  总token:${usage.prompt_tokens + usage.completion_tokens}`;
              }).join("\n");
              if (!s) {
                seal.replyToSender(ctx, msg, `没有使用记录`);
                return ret;
              }
              seal.replyToSender(ctx, msg, `全部使用记录如下:
${s}`);
              return ret;
            }
            case "y": {
              const obj = {};
              const now = /* @__PURE__ */ new Date();
              const currentYear = now.getFullYear();
              const currentMonth = now.getMonth() + 1;
              const currentYM = currentYear * 12 + currentMonth;
              for (const model in AIManager.usageMap) {
                const modelUsage = AIManager.usageMap[model];
                for (const key in modelUsage) {
                  const usage = modelUsage[key];
                  const [year, month, _] = key.split("-").map((v) => parseInt(v));
                  const ym = year * 12 + month;
                  if (ym >= currentYM - 11 && ym <= currentYM) {
                    const key2 = `${year}-${month}`;
                    if (!obj.hasOwnProperty(key2)) {
                      obj[key2] = {
                        prompt_tokens: 0,
                        completion_tokens: 0
                      };
                    }
                    obj[key2].prompt_tokens += usage.prompt_tokens;
                    obj[key2].completion_tokens += usage.completion_tokens;
                  }
                }
              }
              const val3 = cmdArgs.getArgN(3);
              if (val3 === "chart") {
                get_chart_url("year", obj).then((url) => {
                  if (!url) {
                    seal.replyToSender(ctx, msg, `图表生成失败`);
                    return;
                  }
                  seal.replyToSender(ctx, msg, `[CQ:image,file=${url}]`);
                });
                return ret;
              }
              const keys = Object.keys(obj).sort((a, b) => {
                const [yearA, monthA] = a.split("-").map((v) => parseInt(v));
                const [yearB, monthB] = b.split("-").map((v) => parseInt(v));
                return yearA * 12 + monthA - (yearB * 12 + monthB);
              });
              const s = keys.map((key) => {
                const usage = obj[key];
                if (usage.prompt_tokens === 0 && usage.completion_tokens === 0) {
                  return ``;
                }
                return `${key}:
  输入token:${usage.prompt_tokens}
  输出token:${usage.completion_tokens}
  总token:${usage.prompt_tokens + usage.completion_tokens}`;
              }).join("\n");
              if (!s) {
                seal.replyToSender(ctx, msg, `没有使用记录`);
                return ret;
              }
              seal.replyToSender(ctx, msg, `最近12个月使用记录如下:
${s}`);
              return ret;
            }
            case "m": {
              const obj = {};
              const now = /* @__PURE__ */ new Date();
              const currentYear = now.getFullYear();
              const currentMonth = now.getMonth() + 1;
              const currentDay = now.getDate();
              const currentYMD = currentYear * 12 * 31 + currentMonth * 31 + currentDay;
              for (const model in AIManager.usageMap) {
                const modelUsage = AIManager.usageMap[model];
                for (const key in modelUsage) {
                  const usage = modelUsage[key];
                  const [year, month, day] = key.split("-").map((v) => parseInt(v));
                  const ymd = year * 12 * 31 + month * 31 + day;
                  if (ymd >= currentYMD - 30 && ymd <= currentYMD) {
                    const key2 = `${year}-${month}-${day}`;
                    if (!obj.hasOwnProperty(key2)) {
                      obj[key2] = {
                        prompt_tokens: 0,
                        completion_tokens: 0
                      };
                    }
                    obj[key2].prompt_tokens += usage.prompt_tokens;
                    obj[key2].completion_tokens += usage.completion_tokens;
                  }
                }
              }
              const val3 = cmdArgs.getArgN(3);
              if (val3 === "chart") {
                get_chart_url("month", obj).then((url) => {
                  if (!url) {
                    seal.replyToSender(ctx, msg, `图表生成失败`);
                    return;
                  }
                  seal.replyToSender(ctx, msg, `[CQ:image,file=${url}]`);
                });
                return ret;
              }
              const keys = Object.keys(obj).sort((a, b) => {
                const [yearA, monthA, dayA] = a.split("-").map((v) => parseInt(v));
                const [yearB, monthB, dayB] = b.split("-").map((v) => parseInt(v));
                return yearA * 12 * 31 + monthA * 31 + dayA - (yearB * 12 * 31 + monthB * 31 + dayB);
              });
              const s = keys.map((key) => {
                const usage = obj[key];
                if (usage.prompt_tokens === 0 && usage.completion_tokens === 0) {
                  return ``;
                }
                return `${key}:
  输入token:${usage.prompt_tokens}
  输出token:${usage.completion_tokens}
  总token:${usage.prompt_tokens + usage.completion_tokens}`;
              }).join("\n");
              seal.replyToSender(ctx, msg, `最近31天使用记录如下:
${s}`);
              return ret;
            }
            case "clr": {
              const val3 = cmdArgs.getArgN(3);
              if (!val3) {
                AIManager.clearUsageMap();
                seal.replyToSender(ctx, msg, "已清除token使用记录");
                AIManager.saveUsageMap();
                return ret;
              }
              if (!AIManager.usageMap.hasOwnProperty(val3)) {
                seal.replyToSender(ctx, msg, "没有这个模型，请使用【.ai tk lst】查看所有模型");
                return ret;
              }
              delete AIManager.usageMap[val3];
              seal.replyToSender(ctx, msg, `已清除 ${val3} 的token使用记录`);
              AIManager.saveUsageMap();
              return ret;
            }
            case "":
            case "help": {
              const s = `帮助:
【.ai tk lst】查看所有模型
【.ai tk sum】查看所有模型的token使用记录总和
【.ai tk all】查看所有模型的token使用记录
【.ai tk [y/m] (chart)】查看所有模型今年/这个月的token使用记录
【.ai tk <模型名称>】查看模型的token使用记录
【.ai tk <模型名称> [y/m] (chart)】查看模型今年/这个月的token使用记录
【.ai tk clr】清除token使用记录
【.ai tk clr <模型名称>】清除token使用记录`;
              seal.replyToSender(ctx, msg, s);
              return ret;
            }
            default: {
              if (!AIManager.usageMap.hasOwnProperty(val2)) {
                seal.replyToSender(ctx, msg, "没有这个模型，请使用【.ai tk lst】查看所有模型");
                return ret;
              }
              const val3 = cmdArgs.getArgN(3);
              switch (val3) {
                case "y": {
                  const obj = {};
                  const now = /* @__PURE__ */ new Date();
                  const currentYear = now.getFullYear();
                  const currentMonth = now.getMonth() + 1;
                  const currentYM = currentYear * 12 + currentMonth;
                  const model = val2;
                  const modelUsage = AIManager.usageMap[model];
                  for (const key in modelUsage) {
                    const usage = modelUsage[key];
                    const [year, month, _] = key.split("-").map((v) => parseInt(v));
                    const ym = year * 12 + month;
                    if (ym >= currentYM - 11 && ym <= currentYM) {
                      const key2 = `${year}-${month}`;
                      if (!obj.hasOwnProperty(key2)) {
                        obj[key2] = {
                          prompt_tokens: 0,
                          completion_tokens: 0
                        };
                      }
                      obj[key2].prompt_tokens += usage.prompt_tokens;
                      obj[key2].completion_tokens += usage.completion_tokens;
                    }
                  }
                  const val4 = cmdArgs.getArgN(4);
                  if (val4 === "chart") {
                    get_chart_url("year", obj).then((url) => {
                      if (!url) {
                        seal.replyToSender(ctx, msg, `图表生成失败`);
                        return;
                      }
                      seal.replyToSender(ctx, msg, `[CQ:image,file=${url}]`);
                    });
                    return ret;
                  }
                  const keys = Object.keys(obj).sort((a, b) => {
                    const [yearA, monthA] = a.split("-").map((v) => parseInt(v));
                    const [yearB, monthB] = b.split("-").map((v) => parseInt(v));
                    return yearA * 12 + monthA - (yearB * 12 + monthB);
                  });
                  const s = keys.map((key) => {
                    const usage = obj[key];
                    if (usage.prompt_tokens === 0 && usage.completion_tokens === 0) {
                      return ``;
                    }
                    return `${key}:
      输入token:${usage.prompt_tokens}
      输出token:${usage.completion_tokens}
      总token:${usage.prompt_tokens + usage.completion_tokens}`;
                  }).join("\n");
                  if (!s) {
                    seal.replyToSender(ctx, msg, `没有使用记录`);
                    return ret;
                  }
                  seal.replyToSender(ctx, msg, `最近12个月使用记录如下:
${s}`);
                  return ret;
                }
                case "m": {
                  const obj = {};
                  const now = /* @__PURE__ */ new Date();
                  const currentYear = now.getFullYear();
                  const currentMonth = now.getMonth() + 1;
                  const currentDay = now.getDate();
                  const currentYMD = currentYear * 12 * 31 + currentMonth * 31 + currentDay;
                  const model = val2;
                  const modelUsage = AIManager.usageMap[model];
                  for (const key in modelUsage) {
                    const usage = modelUsage[key];
                    const [year, month, day] = key.split("-").map((v) => parseInt(v));
                    const ymd = year * 12 * 31 + month * 31 + day;
                    if (ymd >= currentYMD - 30 && ymd <= currentYMD) {
                      const key2 = `${year}-${month}-${day}`;
                      if (!obj.hasOwnProperty(key2)) {
                        obj[key2] = {
                          prompt_tokens: 0,
                          completion_tokens: 0
                        };
                      }
                      obj[key2].prompt_tokens += usage.prompt_tokens;
                      obj[key2].completion_tokens += usage.completion_tokens;
                    }
                  }
                  const val4 = cmdArgs.getArgN(4);
                  if (val4 === "chart") {
                    get_chart_url("month", obj).then((url) => {
                      if (!url) {
                        seal.replyToSender(ctx, msg, `图表生成失败`);
                        return;
                      }
                      seal.replyToSender(ctx, msg, `[CQ:image,file=${url}]`);
                    });
                    return ret;
                  }
                  const keys = Object.keys(obj).sort((a, b) => {
                    const [yearA, monthA, dayA] = a.split("-").map((v) => parseInt(v));
                    const [yearB, monthB, dayB] = b.split("-").map((v) => parseInt(v));
                    return yearA * 12 * 31 + monthA * 31 + dayA - (yearB * 12 * 31 + monthB * 31 + dayB);
                  });
                  const s = keys.map((key) => {
                    const usage = obj[key];
                    if (usage.prompt_tokens === 0 && usage.completion_tokens === 0) {
                      return ``;
                    }
                    return `${key}:
      输入token:${usage.prompt_tokens}
      输出token:${usage.completion_tokens}
      总token:${usage.prompt_tokens + usage.completion_tokens}`;
                  }).join("\n");
                  seal.replyToSender(ctx, msg, `最近31天使用记录如下:
${s}`);
                  return ret;
                }
                default: {
                  const usage = AIManager.getModelUsage(val2);
                  if (usage.prompt_tokens === 0 && usage.completion_tokens === 0) {
                    seal.replyToSender(ctx, msg, `没有使用记录`);
                    return ret;
                  }
                  const s = `输入token:${usage.prompt_tokens}
输出token:${usage.completion_tokens}
总token:${usage.prompt_tokens + usage.completion_tokens}`;
                  seal.replyToSender(ctx, msg, s);
                  return ret;
                }
              }
            }
          }
        }
        case "help":
        default: {
          ret.showHelp = true;
          return ret;
        }
      }
    };
    const cmdImage = seal.ext.newCmdItemInfo();
    cmdImage.name = "img";
    cmdImage.help = `盗图指南:
【img draw [stl/lcl/all]】随机抽取偷的图片/本地图片/全部
【img stl (on/off)】偷图 开启/关闭
【img f】遗忘
【img itt [图片/ran] (附加提示词)】图片转文字`;
    cmdImage.solve = (ctx, msg, cmdArgs) => {
      const val = cmdArgs.getArgN(1);
      const uid = ctx.player.userId;
      const gid = ctx.group.groupId;
      const id = ctx.isPrivate ? uid : gid;
      const ret = seal.ext.newCmdExecuteResult(true);
      const ai = AIManager.getAI(id);
      switch (val) {
        case "draw": {
          const type = cmdArgs.getArgN(2);
          switch (type) {
            case "lcl":
            case "local": {
              const image = ai.image.drawLocalImageFile();
              if (!image) {
                seal.replyToSender(ctx, msg, "暂无本地图片");
                return ret;
              }
              seal.replyToSender(ctx, msg, `[CQ:image,file=${image}]`);
              return ret;
            }
            case "stl":
            case "stolen": {
              ai.image.drawStolenImageFile().then((image) => {
                if (!image) {
                  seal.replyToSender(ctx, msg, "暂无偷取图片");
                } else {
                  seal.replyToSender(ctx, msg, `[CQ:image,file=${image}]`);
                }
              });
              return ret;
            }
            case "all": {
              ai.image.drawImageFile().then((image) => {
                if (!image) {
                  seal.replyToSender(ctx, msg, "暂无图片");
                } else {
                  seal.replyToSender(ctx, msg, `[CQ:image,file=${image}]`);
                }
              });
              return ret;
            }
            default: {
              ret.showHelp = true;
              return ret;
            }
          }
        }
        case "stl":
        case "steal": {
          const op = cmdArgs.getArgN(2);
          switch (op) {
            case "on": {
              ai.image.stealStatus = true;
              seal.replyToSender(ctx, msg, `图片偷取已开启,当前偷取数量:${ai.image.imageList.length}`);
              AIManager.saveAI(id);
              return ret;
            }
            case "off": {
              ai.image.stealStatus = false;
              seal.replyToSender(ctx, msg, `图片偷取已关闭,当前偷取数量:${ai.image.imageList.length}`);
              AIManager.saveAI(id);
              return ret;
            }
            default: {
              seal.replyToSender(ctx, msg, `图片偷取状态:${ai.image.stealStatus},当前偷取数量:${ai.image.imageList.length}`);
              return ret;
            }
          }
        }
        case "f":
        case "fgt":
        case "forget": {
          ai.image.imageList = [];
          seal.replyToSender(ctx, msg, "图片已遗忘");
          AIManager.saveAI(id);
          return ret;
        }
        case "itt": {
          const val2 = cmdArgs.getArgN(2);
          if (!val2) {
            seal.replyToSender(ctx, msg, "【img itt [图片/ran] (附加提示词)】图片转文字");
            return ret;
          }
          if (val2 == "ran") {
            ai.image.drawStolenImageFile().then((url) => {
              if (!url) {
                seal.replyToSender(ctx, msg, "图片偷取为空");
              } else {
                const text = cmdArgs.getRestArgsFrom(3);
                ImageManager.imageToText(url, text).then((s) => {
                  seal.replyToSender(ctx, msg, `[CQ:image,file=${url}]
` + s);
                });
              }
            });
          } else {
            const match = val2.match(/\[CQ:image,file=(.*?)\]/);
            if (!match) {
              seal.replyToSender(ctx, msg, "请附带图片");
              return ret;
            }
            const url = match[1];
            const text = cmdArgs.getRestArgsFrom(3);
            ImageManager.imageToText(url, text).then((s) => {
              seal.replyToSender(ctx, msg, `[CQ:image,file=${url}]
` + s);
            });
          }
          return ret;
        }
        default: {
          ret.showHelp = true;
          return ret;
        }
      }
    };
    ext.cmdMap["AI"] = cmdAI;
    ext.cmdMap["ai"] = cmdAI;
    ext.cmdMap["img"] = cmdImage;
    ext.onNotCommandReceived = async (ctx, msg) => {
      const { disabledInPrivate, keyWords, condition } = ConfigManager.received;
      if (ctx.isPrivate && disabledInPrivate) {
        return;
      }
      const userId = ctx.player.userId;
      const groupId = ctx.group.groupId;
      const id = ctx.isPrivate ? userId : groupId;
      let message = msg.message;
      let images = [];
      const ai = AIManager.getAI(id);
      const CQTypes = getCQTypes(message);
      if (CQTypes.length === 0 || CQTypes.every((item) => CQTypesAllow.includes(item))) {
        if (CQTypes.includes("image")) {
          const result = await ImageManager.handleImageMessage(ctx, message);
          message = result.message;
          images = result.images;
          if (ai.image.stealStatus) {
            ai.image.updateImageList(images);
          }
        }
        clearTimeout(ai.context.timer);
        ai.context.timer = null;
        for (const keyword of keyWords) {
          try {
            const pattern = new RegExp(keyword);
            if (!pattern.test(message)) {
              continue;
            }
          } catch (error) {
            console.error("Error in RegExp:", error);
            continue;
          }
          const fmtCondition = parseInt(seal.format(ctx, `{${condition}}`));
          if (fmtCondition === 1) {
            await ai.context.iteration(ctx, message, images, "user");
            log("非指令触发回复");
            await ai.chat(ctx, msg);
            AIManager.saveAI(id);
            return;
          }
        }
        if (triggerConditionMap.hasOwnProperty(id) && triggerConditionMap[id].length !== 0) {
          for (let i = 0; i < triggerConditionMap[id].length; i++) {
            const condition2 = triggerConditionMap[id][i];
            if (condition2.keyword && !new RegExp(condition2.keyword).test(message)) {
              continue;
            }
            if (condition2.uid && condition2.uid !== userId) {
              continue;
            }
            await ai.context.iteration(ctx, message, images, "user");
            await ai.context.systemUserIteration("触发原因提示", condition2.reason, []);
            triggerConditionMap[id].splice(i, 1);
            log("AI设定触发条件触发回复");
            await ai.chat(ctx, msg);
            AIManager.saveAI(id);
            return;
          }
        }
        const pr = ai.privilege;
        if (pr.standby) {
          await ai.context.iteration(ctx, message, images, "user");
        }
        if (pr.counter > -1) {
          ai.context.counter += 1;
          if (ai.context.counter >= pr.counter) {
            log("计数器触发回复");
            ai.context.counter = 0;
            await ai.chat(ctx, msg);
            AIManager.saveAI(id);
            return;
          }
        }
        if (pr.prob > -1) {
          const ran = Math.random() * 100;
          if (ran <= pr.prob) {
            log("概率触发回复");
            await ai.chat(ctx, msg);
            AIManager.saveAI(id);
            return;
          }
        }
        if (pr.timer > -1) {
          ai.context.timer = setTimeout(async () => {
            log("计时器触发回复");
            ai.context.timer = null;
            await ai.chat(ctx, msg);
            AIManager.saveAI(id);
          }, pr.timer * 1e3 + Math.floor(Math.random() * 500));
        }
      }
    };
    ext.onCommandReceived = async (ctx, msg, cmdArgs) => {
      if (ToolManager.cmdArgs === null) {
        ToolManager.cmdArgs = cmdArgs;
      }
      const { allcmd } = ConfigManager.received;
      if (allcmd) {
        const uid = ctx.player.userId;
        const gid = ctx.group.groupId;
        const id = ctx.isPrivate ? uid : gid;
        const ai = AIManager.getAI(id);
        let message = msg.message;
        let images = [];
        const CQTypes = getCQTypes(message);
        if (CQTypes.length === 0 || CQTypes.every((item) => CQTypesAllow.includes(item))) {
          const pr = ai.privilege;
          if (pr.standby) {
            const result = await ImageManager.handleImageMessage(ctx, message);
            message = result.message;
            images = result.images;
            await ai.context.iteration(ctx, message, images, "user");
          }
        }
      }
    };
    ext.onMessageSend = async (ctx, msg) => {
      const uid = ctx.player.userId;
      const gid = ctx.group.groupId;
      const id = ctx.isPrivate ? uid : gid;
      const ai = AIManager.getAI(id);
      let message = msg.message;
      let images = [];
      if (ai.listen.status) {
        ai.listen.status = false;
        ai.listen.content = message;
        return;
      }
      const { allmsg } = ConfigManager.received;
      if (allmsg) {
        if (message === ai.context.lastReply) {
          ai.context.lastReply = "";
          return;
        }
        const CQTypes = getCQTypes(message);
        if (CQTypes.length === 0 || CQTypes.every((item) => CQTypesAllow.includes(item))) {
          const pr = ai.privilege;
          if (pr.standby) {
            const result = await ImageManager.handleImageMessage(ctx, message);
            message = result.message;
            images = result.images;
            await ai.context.iteration(ctx, message, images, "assistant");
            return;
          }
        }
      }
    };
    let isTaskRunning = false;
    seal.ext.registerTask(ext, "cron", "* * * * *", async () => {
      if (timerQueue.length === 0) {
        return;
      }
      if (isTaskRunning) {
        log("定时器任务正在运行，跳过");
        return;
      }
      isTaskRunning = true;
      let changed = false;
      for (let i = 0; i < timerQueue.length && i >= 0; i++) {
        const timestamp = timerQueue[i].timestamp;
        if (timestamp > Math.floor(Date.now() / 1e3)) {
          continue;
        }
        const setTime = timerQueue[i].setTime;
        const content = timerQueue[i].content;
        const id = timerQueue[i].id;
        const messageType = timerQueue[i].messageType;
        const uid = timerQueue[i].uid;
        const gid = timerQueue[i].gid;
        const epId = timerQueue[i].epId;
        const msg = createMsg(messageType, uid, gid);
        const ctx = createCtx(epId, msg);
        const ai = AIManager.getAI(id);
        const s = `你设置的定时器触发了，请按照以下内容发送回复：
定时器设定时间：${setTime}
当前触发时间：${(/* @__PURE__ */ new Date()).toLocaleString()}
提示内容：${content}`;
        await ai.context.systemUserIteration("定时器触发提示", s, []);
        log("定时任务触发回复");
        ai.isChatting = false;
        await ai.chat(ctx, msg);
        AIManager.saveAI(id);
        timerQueue.splice(i, 1);
        i--;
        changed = true;
        await new Promise((resolve) => setTimeout(resolve, 2e3));
      }
      if (changed) {
        ext.storageSet(`timerQueue`, JSON.stringify(timerQueue));
      }
      isTaskRunning = false;
    });
  }
  async function get_chart_url(chart_type, data) {
    try {
      const chart_url = "http://42.193.236.17:3009/chart";
      const response = await fetch(chart_url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify({
          chart_type,
          data
        })
      });
      const data2 = await response.json();
      if (!response.ok) {
        let s = `请求失败! 状态码: ${response.status}`;
        if (data2.error) {
          s += `
错误信息: ${data2.error.message}`;
        }
        s += `
响应体: ${JSON.stringify(data, null, 2)}`;
        throw new Error(s);
      }
      return data2.image_url;
    } catch (error) {
      console.error("在get_chart_url中请求出错：", error);
      return "";
    }
  }
  main();
})();
