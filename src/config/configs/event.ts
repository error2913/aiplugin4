// 依赖事件接收配置：ob11 依赖 notice/request 事件转文本提示词录入上下文（仅背景，不触发 AI）
import { ext } from "../config";

export default class EventConfig {
    static register() {
        seal.ext.registerBoolConfig(ext, "接收依赖通知事件", false, "开启后把 ob11 依赖订阅到的通知/请求事件（禁言/管理变动/文件上传/运气王/入群申请/好友申请等）转成文本提示词录入上下文，仅作背景不触发 AI；仅当会话待机或全局待机开启时才录入（与普通消息入库口径一致）", "事件接收");
        seal.ext.registerTemplateConfig(ext, "通知事件白名单", [
            "group_ban",
            "group_admin",
            "group_upload",
            "group_increase",
            "group_decrease",
            "group_recall",
            "group_joined",
            "group_name_change",
            "group_disband",
            "group_whole_mute",
            "group_message_reaction",
            "group_essence_message_change",
            "group_request",
            "friend_request",
            "friend_recall",
            "friend_add",
            "friend_file_upload",
            "peer_pin_change",
            "notify",
            "lucky_king",
            "honor"
        ], "每行一个事件类型，仅白名单内的事件会录入上下文。默认包含全部可转换事件类型（元事件除外）：元事件（心跳/生命周期）不属于通知/请求事件，始终不录入；poke 虽属 notify 子类型但由原生 onPoke 处理、不生成事件文本，实际不会录入；入群/好友申请属 request 事件，与 notice 共用白名单；原生与 ob11 依赖双路径由事件级去重防双录，如需排除可自行删除", "事件接收");
    }

    static get() {
        return {
            RECEIVE_NOTICE: seal.ext.getBoolConfig(ext, "接收依赖通知事件"),
            NOTICE_TYPES: seal.ext.getTemplateConfig(ext, "通知事件白名单"),
        }
    }
}
