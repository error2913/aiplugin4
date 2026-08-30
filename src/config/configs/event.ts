// 依赖事件接收配置：ob11 依赖 notice/request 事件转文本提示词录入上下文（仅背景，不触发 AI）
import { ext } from "../config";

export default class EventConfig {
    static register() {
        seal.ext.registerBoolConfig(ext, "接收依赖通知事件", false, "开启后把 ob11 依赖订阅到的通知/请求事件（禁言/管理变动/文件上传/名片变更/表情回应/精华/运气王/入群申请/好友申请等）转成文本提示词录入上下文，仅作背景不触发 AI；仅当会话待机或全局待机开启时才录入（与普通消息入库口径一致）", "事件接收");
        seal.ext.registerTemplateConfig(ext, "通知事件白名单", [
            "group_ban",
            "group_admin",
            "group_upload",
            "group_card",
            "group_increase",
            "group_decrease",
            "group_recall",
            "group_joined",
            "notify",
            "lucky_king",
            "honor",
            "group_name",
            "title",
            "profile_like",
            "essence",
            "group_msg_emoji_like",
            "group_request",
            "friend_request",
            "friend_recall",
            "friend_add"
        ], "每行一个事件类型，仅白名单内的事件会录入上下文。默认包含 NapCat/OneBot 可上报的绝大多数通知/请求事件：禁言、管理变动、文件上传、群名片变更、成员增减、消息撤回、群名变更（notify/group_name）、群头衔变更（notify/title）、资料点赞（notify/profile_like）、精华（essence）、表情回应（group_msg_emoji_like）、运气王/群荣誉、入群/好友申请等。notify 为通知大类，其子类型需单独在白名单内才会收录（默认含 lucky_king/honor/group_name/title/profile_like）；poke 属 notify 子类型但由原生 onPoke 处理、不生成事件文本，实际不会录入；gray_tip（灰条，内容为 JSON 且可伪造）、input_status（输入状态，纯噪音）未默认收录，如需可自行加入对应子类型名；机器人离线（bot_offline）与在线文件（online_file_receive/send）无会话可归属、不录入上下文；原生与 ob11 依赖双路径由事件级去重防双录，如需排除可自行删除", "事件接收");
    }

    static get() {
        return {
            RECEIVE_NOTICE: seal.ext.getBoolConfig(ext, "接收依赖通知事件"),
            NOTICE_TYPES: seal.ext.getTemplateConfig(ext, "通知事件白名单"),
        }
    }
}
