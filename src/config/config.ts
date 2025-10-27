import { BackendConfig } from "./config_backend";
import { ImageConfig } from "./config_image";
import { LogConfig } from "./config_log";
import { MemoryConfig } from "./config_memory";
import { MessageConfig } from "./config_message";
import { ReceivedConfig } from "./config_received";
import { ReplyConfig } from "./config_reply";
import { RequestConfig } from "./config_request";
import { ToolConfig } from "./config_tool";

export const VERSION = "4.11.2";
export const AUTHOR = "baiyu&错误";
export const NAME = "aiplugin4";
export const CQTYPESALLOW = ["at", "image", "reply", "face", "poke"];
export const PRIVILEGELEVELMAP = {
    "master": 100,
    "whitelist": 70,
    "owner": 60,
    "admin": 50,
    "inviter": 40,
    "user": 0,
    "blacklist": -30
}
export const HELPMAP = {
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

export class ConfigManager {
    static ext: seal.ExtInfo;
    static cache: {
        [key: string]: {
            timestamp: number,
            data: any
        }
    } = {}

    static registerConfig() {
        this.ext = ConfigManager.getExt(NAME);
        LogConfig.register();
        RequestConfig.register();
        MessageConfig.register();
        ToolConfig.register();
        ReceivedConfig.register();
        ReplyConfig.register();
        ImageConfig.register();
        BackendConfig.register();
        MemoryConfig.register();
    }

    static getCache<T>(key: string, getFunc: () => T): T {
        const timestamp = Date.now()
        if (this.cache?.[key] && timestamp - this.cache[key].timestamp < 3000) {
            return this.cache[key].data;
        }

        const data = getFunc();
        this.cache[key] = {
            timestamp: timestamp,
            data: data
        }

        return data;
    }

    static get log() { return this.getCache('log', LogConfig.get) }
    static get request() { return this.getCache('request', RequestConfig.get) }
    static get message() { return this.getCache('message', MessageConfig.get) }
    static get tool() { return this.getCache('tool', ToolConfig.get) }
    static get received() { return this.getCache('received', ReceivedConfig.get) }
    static get reply() { return this.getCache('reply', ReplyConfig.get) }
    static get image() { return this.getCache('image', ImageConfig.get) }
    static get backend() { return this.getCache('backend', BackendConfig.get) }
    static get memory() { return this.getCache('memory', MemoryConfig.get) }

    static getExt(name: string): seal.ExtInfo {
        if (name == NAME && ConfigManager.ext) {
            return ConfigManager.ext;
        }

        let ext = seal.ext.find(name);
        if (!ext) {
            ext = seal.ext.new(name, AUTHOR, VERSION);
            seal.ext.register(ext);
        }

        return ext;
    }
}