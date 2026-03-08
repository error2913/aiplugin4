export const VERSION = "4.12.0";
export const AUTHOR = "baiyu&错误";
export const NAME = "aiplugin4";

export const CONFIG_CACHE_TTL = 60000;

export const CQ_TYPES_ALLOW = ["at", "image", "reply", "face", "poke"];

export const PRIVILEGE_LEVEL_MAP = {
    "master": 100,
    "whitelist": 70,
    "owner": 60,
    "admin": 50,
    "inviter": 40,
    "user": 0,
    "blacklist": -30
}

export const HELP_MAP = {
    "ID": `<ID>:
【QQ:1234567890】 私聊窗口
【QQ-Group:1234】 群聊窗口
【now】当前窗口`,
    "会话权限": `<会话权限>:任意数字，越大权限越高`,
    "指令": `<指令>:指令名称和参数，多个指令用-连接，如ai-sb`,
    "权限限制": `<权限限制>:数字0-数字1-数字2，如0-0-0，含义如下:
0: 会话所需权限, 1: 会话检查通过后用户所需权限, 2: 强行触发指令用户所需权限, 进行检查时若通过0和1则无需检查2
【-30】黑名单用户
【0】普通用户
【40】邀请者
【50】群管理员
【60】群主
【70】白名单用户
【100】骰主`,
    "参数": `<参数>:
【c】计数器模式，接收消息数达到后触发
单位/条，默认10条
【t】计时器模式，最后一条消息后达到时限触发
单位/秒，默认60秒
【p】概率模式，每条消息按概率触发
单位/%，默认10%
【a】活跃时间段和活跃次数
格式为"开始时间-结束时间-活跃次数"(如"09:00-18:00-5")`
}

export const ALIAS_MAP = {
    "AI": "ai",
    "priv": "privilege",
    "ses": "session",
    "st": "set",
    "ck": "check",
    "clr": "clear",
    "sb": "standby",
    "fgt": "forget",
    "f": "forget",
    "ass": "assistant",
    "img": "image",
    "memo": "memory",
    "p": "private",
    "g": "group",
    "del": "delete",
    "ign": "ignore",
    "rm": "remove",
    "lst": "list",
    "tk": "token",
    "y": "year",
    "m": "month",
    "lcl": "local",
    "stl": "steal",
    "ran": "random",
    "nick": "nickname"
}

export const FACE_MAP = {
    "0": "惊讶",
    "1": "撇嘴",
    "2": "色",
    "3": "发呆",
    "4": "得意",
    "5": "流泪",
    "6": "害羞",
    "7": "闭嘴",
    "8": "睡",
    "9": "大哭",
    "10": "尴尬",
    "11": "发怒",
    "12": "调皮",
    "13": "呲牙",
    "14": "微笑",
    "15": "难过",
    "16": "酷",
    "18": "抓狂",
    "19": "吐",
    "20": "偷笑",
    "21": "可爱",
    "22": "白眼",
    "23": "傲慢",
    "24": "饥饿",
    "25": "困",
    "26": "惊恐",
    "27": "流汗",
    "28": "憨笑",
    "29": "悠闲",
    "30": "奋斗",
    "31": "咒骂",
    "32": "疑问",
    "33": "嘘",
    "34": "晕",
    "35": "折磨",
    "36": "衰",
    "37": "骷髅",
    "38": "敲打",
    "39": "再见",
    "41": "发抖",
    "42": "爱情",
    "43": "跳跳",
    "46": "猪头",
    "49": "拥抱",
    "53": "蛋糕",
    "55": "炸弹",
    "56": "刀",
    "59": "便便",
    "60": "咖啡",
    "63": "玫瑰",
    "64": "凋谢",
    "66": "爱心",
    "67": "心碎",
    "74": "太阳",
    "75": "月亮",
    "76": "赞",
    "77": "踩",
    "78": "握手",
    "79": "胜利",
    "85": "飞吻",
    "86": "怄火",
    "89": "西瓜",
    "96": "冷汗",
    "97": "擦汗",
    "98": "抠鼻",
    "99": "鼓掌",
    "100": "糗大了",
    "101": "坏笑",
    "102": "左哼哼",
    "103": "右哼哼",
    "104": "哈欠",
    "105": "鄙视",
    "106": "委屈",
    "107": "快哭了",
    "108": "阴险",
    "109": "左亲亲",
    "110": "吓",
    "111": "可怜",
    "112": "菜刀",
    "114": "篮球",
    "116": "示爱",
    "118": "抱拳",
    "119": "勾引",
    "120": "拳头",
    "121": "差劲",
    "122": "爱你",
    "123": "NO",
    "124": "OK",
    "125": "转圈",
    "129": "挥手",
    "137": "鞭炮",
    "144": "喝彩",
    "146": "爆筋",
    "147": "棒棒糖",
    "148": "喝奶",
    "169": "手枪",
    "171": "茶",
    "172": "眨眼睛",
    "173": "泪奔",
    "174": "无奈",
    "175": "卖萌",
    "176": "小纠结",
    "177": "喷血",
    "178": "斜眼笑",
    "179": "doge",
    "180": "惊喜",
    "181": "戳一戳",
    "182": "笑哭",
    "183": "我最美",
    "185": "羊驼",
    "187": "幽灵",
    "193": "大笑",
    "194": "不开心",
    "198": "呃",
    "200": "求求",
    "201": "点赞",
    "202": "无聊",
    "203": "托脸",
    "204": "吃",
    "206": "害怕",
    "210": "飙泪",
    "211": "我不看",
    "212": "托腮",
    "214": "啵啵",
    "215": "糊脸",
    "216": "拍头",
    "217": "扯一扯",
    "218": "舔一舔",
    "219": "蹭一蹭",
    "221": "顶呱呱",
    "222": "抱抱",
    "223": "暴击",
    "224": "开枪",
    "225": "撩一撩",
    "226": "拍桌",
    "227": "拍手",
    "229": "干杯",
    "230": "嘲讽",
    "231": "哼",
    "232": "佛系",
    "233": "掐一掐",
    "235": "颤抖",
    "237": "偷看",
    "238": "扇脸",
    "239": "原谅",
    "240": "喷脸",
    "241": "生日快乐",
    "243": "甩头",
    "244": "扔狗",
    "262": "脑阔疼",
    "263": "沧桑",
    "264": "捂脸",
    "265": "辣眼睛",
    "266": "哦哟",
    "267": "头秃",
    "268": "问号脸",
    "269": "暗中观察",
    "270": "emm",
    "271": "吃瓜",
    "272": "呵呵哒",
    "273": "我酸了",
    "277": "汪汪",
    "278": "汗",
    "281": "无眼笑",
    "282": "敬礼",
    "283": "狂笑",
    "284": "面无表情",
    "285": "摸鱼",
    "286": "魔鬼笑",
    "287": "哦",
    "288": "请",
    "289": "睁眼",
    "290": "敲开心",
    "292": "让我康康",
    "293": "摸锦鲤",
    "294": "期待",
    "295": "拿到红包",
    "297": "拜谢",
    "298": "元宝",
    "299": "牛啊",
    "300": "胖三斤",
    "301": "好闪",
    "302": "左拜年",
    "303": "右拜年",
    "305": "右亲亲",
    "306": "牛气冲天",
    "307": "喵喵",
    "311": "打call",
    "312": "变形",
    "314": "仔细分析",
    "317": "菜汪",
    "318": "崇拜",
    "319": "比心",
    "320": "庆祝",
    "322": "拒绝",
    "323": "嫌弃",
    "324": "吃糖",
    "325": "惊吓",
    "326": "生气",
    "332": "举牌牌",
    "333": "烟花",
    "334": "虎虎生威",
    "336": "豹富",
    "337": "花朵脸",
    "338": "我想开了",
    "339": "舔屏",
    "341": "打招呼",
    "342": "酸Q",
    "343": "我方了",
    "344": "大怨种",
    "345": "红包多多",
    "346": "你真棒棒",
    "347": "大展宏兔",
    "348": "福萝卜",
    "349": "坚强",
    "350": "贴贴",
    "351": "敲敲",
    "352": "咦",
    "353": "拜托",
    "354": "尊嘟假嘟",
    "355": "耶",
    "356": "666",
    "357": "裂开",
    "358": "骰子",
    "359": "包剪锤",
    "360": "亲亲",
    "361": "狗狗笑哭",
    "362": "好兄弟",
    "363": "狗狗可怜",
    "364": "超级赞",
    "365": "狗狗生气",
    "366": "芒狗",
    "367": "狗狗疑问",
    "368": "奥特笑哭",
    "369": "彩虹",
    "370": "祝贺",
    "371": "冒泡",
    "372": "气呼呼",
    "373": "忙",
    "374": "波波流泪",
    "375": "超级鼓掌",
    "376": "跺脚",
    "377": "嗨",
    "378": "企鹅笑哭",
    "379": "企鹅流泪",
    "380": "真棒",
    "381": "路过",
    "382": "emo",
    "383": "企鹅爱心",
    "384": "晚安",
    "385": "太气了",
    "386": "呜呜呜",
    "387": "太好笑",
    "388": "太头疼",
    "389": "太赞了",
    "390": "太头秃",
    "391": "太沧桑",
    "392": "龙年快乐",
    "393": "新年中龙",
    "394": "新年大龙",
    "395": "略略略",
    "396": "狼狗",
    "397": "抛媚眼",
    "398": "超级ok",
    "399": "tui",
    "400": "快乐",
    "401": "超级转圈",
    "402": "别说话",
    "403": "出去玩",
    "404": "闪亮登场",
    "405": "好运来",
    "406": "姐是女王",
    "407": "我听听",
    "408": "臭美",
    "409": "送你花花",
    "410": "么么哒",
    "411": "一起嗨",
    "412": "开心",
    "413": "摇起来",
    "415": "划龙舟",
    "416": "中龙舟",
    "417": "大龙舟",
    "419": "火车",
    "420": "中火车",
    "421": "大火车",
    "422": "粽于等到你",
    "423": "复兴号",
    "424": "续标识",
    "425": "求放过",
    "426": "玩火",
    "427": "偷感",
    "428": "收到",
    "429": "蛇年快乐",
    "430": "蛇身",
    "431": "蛇尾",
    "432": "灵蛇献瑞"
}

export interface ModelInfo {
    provider: string;
    model: string[];
    baseUrl: string;
}

export const CHAT_MODEL_MAP: { [key: string]: ModelInfo } = {
    // 海外厂商
    "openai": {
        provider: "openai",
        model: ["gpt-4o", "gpt-4-turbo", "gpt-4", "gpt-3.5-turbo", "o1-mini", "o1-preview"],
        baseUrl: "https://api.openai.com/v1"
    },
    "anthropic": {
        provider: "anthropic",
        model: ["claude-3-5-sonnet-20241022", "claude-3-opus-20240229", "claude-3-sonnet-20240229", "claude-3-haiku-20240307"],
        baseUrl: "https://api.anthropic.com/v1"
    },
    "google": {
        provider: "google",
        model: ["gemini-2.5-pro-exp-03-25", "gemini-2.0-flash-exp", "gemini-1.5-pro", "gemini-1.5-flash"],
        baseUrl: "https://generativelanguage.googleapis.com/v1beta" // 或使用 Vertex AI 的端点
    },
    "meta": { // 通过特定服务商调用，如Replicate, Together AI，或自托管
        provider: "meta",
        model: ["llama-3.1-405b-instruct", "llama-3.1-70b-instruct", "llama-3.1-8b-instruct"],
        baseUrl: "https://api.together.xyz/v1" // 示例：使用 Together AI 作为代理
    },
    "mistralai": {
        provider: "mistralai",
        model: ["mistral-large-latest", "mistral-small-latest", "codestral-latest"],
        baseUrl: "https://api.mistral.ai/v1"
    },
    "cohere": {
        provider: "cohere",
        model: ["command-r-plus", "command-r", "command-light"],
        baseUrl: "https://api.cohere.ai/v1"
    },
    "xai": {
        provider: "xai",
        model: ["grok-2", "grok-2-mini"],
        baseUrl: "https://api.x.ai/v1" // 示例地址，实际需确认
    },
    "deepseek": { // 深度求索，以推理能力见长 [citation:8]
        provider: "deepseek",
        model: ["deepseek-chat", "deepseek-reasoner"], // 对应 V3 和 R1 系列
        baseUrl: "https://api.deepseek.com/v1"
    },
    // 国内厂商
    "alibaba": {
        provider: "alibaba",
        model: ["qwen-max", "qwen-plus", "qwen-turbo", "qwen2.5-72b-instruct"],
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" // 通义千问 DashScope 兼容OpenAI的地址
    },
    "baidu": {
        provider: "baidu",
        model: ["ernie-4.0-turbo-8k", "ernie-3.5-8k", "ernie-lite-8k"],
        baseUrl: "https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop" // 文心一言 API 地址
    },
    "tencent": {
        provider: "tencent",
        model: ["hunyuan-pro", "hunyuan-standard", "hunyuan-lite"],
        baseUrl: "https://api.hunyuan.cloud.tencent.com/v1" // 示例地址，实际需确认
    },
    "zhipu": { // 智谱AI [citation:8]
        provider: "zhipu",
        model: ["glm-4-plus", "glm-4-0520", "glm-4-air", "glm-3-turbo"],
        baseUrl: "https://open.bigmodel.cn/api/paas/v4" // 智谱AI API 地址
    },
    "minimax": {
        provider: "minimax",
        model: ["abab6.5s-chat", "abab5.5s-chat"],
        baseUrl: "https://api.minimax.chat/v1" // 示例地址
    },
    "moonshot": { // 月之暗面 Kimi [citation:8]
        provider: "moonshot",
        model: ["moonshot-v1-128k", "moonshot-v1-32k", "moonshot-v1-8k"],
        baseUrl: "https://api.moonshot.cn/v1"
    }
};

export const IMAGE_MODEL_MAP: { [key: string]: ModelInfo } = {
    "openai": {
        provider: "openai",
        model: ["dall-e-3", "dall-e-2", "gpt-image-1.5"], // GPT Image 1.5 是2025年底的新模型 [citation:2]
        baseUrl: "https://api.openai.com/v1"
    },
    "google": {
        provider: "google",
        model: ["imagen-3.0-generate-001", "imagen-3.0-fast-001"], // Imagen 3 系列 [citation:2][citation:10]
        baseUrl: "https://us-central1-aiplatform.googleapis.com/v1" // Vertex AI 端点
    },
    "stabilityai": {
        provider: "stabilityai",
        model: ["stable-diffusion-3-5-large", "stable-diffusion-3-5-large-turbo", "stable-diffusion-3-medium"],
        baseUrl: "https://api.stability.ai/v2beta" // Stability AI 官方API
    },
    "black-forest-labs": { // 黑森林实验室，由前 Stability AI 成员创建，Flux 模型表现优异 [citation:2]
        provider: "black-forest-labs",
        model: ["flux-1.1-pro", "flux-1-pro", "flux-1-dev"],
        baseUrl: "https://api.bfl.ml/v1" // Black Forest Labs 官方API
    },
    "ideogram": {
        provider: "ideogram",
        model: ["ideogram-v2", "ideogram-v2-turbo"],
        baseUrl: "https://api.ideogram.ai/v1"
    },
    "midjourney": { // Midjourney 通常通过 Discord 调用，或通过第三方API [citation:5][citation:10]
        provider: "midjourney",
        model: ["midjourney-v7", "midjourney-v6"],
        baseUrl: "https://api.midjourney.com/v1" // 官方API，可能需要申请
    },
    "bytedance": { // 字节跳动 [citation:2]
        provider: "bytedance",
        model: ["seedream-4.5", "seedream-3.0"],
        baseUrl: "https://api.bytedance.com/v1" // 示例地址
    },
    "tencent": {
        provider: "tencent",
        model: ["hunyuan-image-3.0"],
        baseUrl: "https://api.hunyuan.cloud.tencent.com/v1" // 示例地址 [citation:2]
    }
};

export const EMBEDDING_MODEL_MAP: { [key: string]: ModelInfo } = {
    "openai": {
        provider: "openai",
        model: ["text-embedding-3-large", "text-embedding-3-small", "text-embedding-ada-002"],
        baseUrl: "https://api.openai.com/v1"
    },
    "google": {
        provider: "google",
        model: ["text-embedding-004", "text-multilingual-embedding-002"],
        baseUrl: "https://generativelanguage.googleapis.com/v1beta" // 或 Vertex AI
    },
    "cohere": {
        provider: "cohere",
        model: ["embed-english-v3.0", "embed-multilingual-v3.0"],
        baseUrl: "https://api.cohere.ai/v1"
    },
    "alibaba": {
        provider: "alibaba",
        model: ["text-embedding-v4", "text-embedding-v3"],
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" // DashScope 兼容地址
    },
    "baidu": {
        provider: "baidu",
        model: ["embedding-v1"],
        baseUrl: "https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop" // 文心 Embedding API
    },
    "zhipu": {
        provider: "zhipu",
        model: ["embedding-3", "embedding-2"],
        baseUrl: "https://open.bigmodel.cn/api/paas/v4" // 智谱AI API
    },
    "siliconflow": { // SiliconFlow 提供多种开源嵌入模型的托管服务 [citation:6]
        provider: "siliconflow",
        model: ["BAAI/bge-large-zh-v1.5", "BAAI/bge-large-en-v1.5", "Pro/BAAI/bge-m3"],
        baseUrl: "https://api.siliconflow.cn/v1"
    },
    "huggingface": { // Hugging Face 的 Inference API 可以调用多种嵌入模型 [citation:6]
        provider: "huggingface",
        model: ["sentence-transformers/all-MiniLM-L6-v2", "intfloat/multilingual-e5-large-instruct"],
        baseUrl: "https://api-inference.huggingface.co/models/"
    }
};