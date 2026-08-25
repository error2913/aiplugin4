// 依赖事件接收配置：ob11 依赖 notice/request 事件转文本提示词录入上下文（仅背景，不触发 AI）
import { ext } from "../config";

export default class EventConfig {
    static register() {
        seal.ext.registerBoolConfig(ext, "接收依赖通知事件", false, "开启后把 ob11 依赖订阅到的群通知事件（禁言/管理变动/文件上传/运气王等）转成文本提示词录入上下文，仅作背景不触发 AI；仅当会话待机或全局待机开启时才录入（与普通消息入库口径一致）", "事件接收");
        seal.ext.registerTemplateConfig(ext, "通知事件白名单", [
            "group_ban",
            "group_admin",
            "group_upload",
            "group_name_change",
            "group_disband",
            "group_whole_mute",
            "lucky_king",
            "honor"
        ], "每行一个 notice 类型，仅白名单内的事件会录入上下文。poke/group_increase/group_recall/friend_add/group_decrease 等海豹原生已覆盖的类型默认不在此列（避免与原生回调重复），如确需收录可自行加入，事件级去重会防止双录", "事件接收");
        seal.ext.registerIntConfig(ext, "每会话每分钟事件上限", 10, "同一会话 60 秒内最多录入的事件条数，超出丢弃（防刷屏）；0 表示不限制", "事件接收");
        seal.ext.registerIntConfig(ext, "单条事件文本最大长度", 300, "事件提示词超长时截断（字符数）", "事件接收");
        seal.ext.registerBoolConfig(ext, "接收请求事件", false, "开启后把好友/入群申请事件录入上下文（默认仅日志，避免隐私与打扰）", "事件接收");
        seal.ext.registerBoolConfig(ext, "无会话时自动建会话记录事件", false, "事件来自从未聊过天的群/陌生人时是否自动创建会话并记录；关闭则跳过，避免产生空会话", "事件接收");
    }

    static get() {
        return {
            RECEIVE_NOTICE: seal.ext.getBoolConfig(ext, "接收依赖通知事件"),
            NOTICE_TYPES: seal.ext.getTemplateConfig(ext, "通知事件白名单"),
            EVENT_RATE_LIMIT: seal.ext.getIntConfig(ext, "每会话每分钟事件上限"),
            EVENT_MAX_LENGTH: seal.ext.getIntConfig(ext, "单条事件文本最大长度"),
            RECEIVE_REQUEST: seal.ext.getBoolConfig(ext, "接收请求事件"),
            EVENT_CREATE_SESSION: seal.ext.getBoolConfig(ext, "无会话时自动建会话记录事件")
        }
    }
}
