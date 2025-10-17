import { AIManager } from "./AI/AI";
import { ConfigManager } from "./config/config";
import { logger } from "./logger";
import { createCtx, createMsg } from "./utils/utils_seal";
import { transformMsgId } from "./utils/utils";

function labelForEvent(event: any): string {
  const { post_type, notice_type, request_type, sub_type } = event;
  if (post_type === "notice") {
    switch (notice_type) {
      case "group_upload": return "群文件上传";
      case "group_decrease": return sub_type === "kick" ? "成员被踢" : "成员退群";
      case "group_increase": return "成员加群";
      case "group_ban": return "群禁言";
      case "group_admin": return "设置群管理员";
      case "group_recall": return "群撤回";
      case "friend_recall": return "私聊撤回";
      case "group_msg_emoji_like": return "群内表情回复";
      case "essence": return "群精华";
      case "notify":
        if (sub_type === "poke") return "群内戳一戳";
        if (sub_type === "lucky_king") return "红包王";
        if (sub_type === "honor") return "群荣誉";
        return "通知";
      default: return "通知";
    }
  }
  if (post_type === "request") {
    if (request_type === "friend") return "加好友请求";
    if (request_type === "group") return sub_type === "invite" ? "入群邀请" : "加群申请";
    return "请求";
  }
  return "事件";
}

function formatEventString(event: any): string {
  const label = labelForEvent(event);
  const kvs: string[] = [];
  if (event.group_id) kvs.push(`群=${event.group_id}`);
  if (event.user_id) kvs.push(`用户=${event.user_id}`);
  if (event.operator_id) kvs.push(`操作者=${event.operator_id}`);
  if (event.target_id) kvs.push(`目标=${event.target_id}`);
  if (event.sub_type) kvs.push(`子类型=${event.sub_type}`);
  if (event.duration) kvs.push(`时长=${event.duration}`);
  if (event.message_id) kvs.push(`消息ID=${event.message_id}`);
  if (event.comment) kvs.push(`消息=${event.comment}`);
  if (event.file && event.file.name) kvs.push(`文件=${event.file.name}`);
  if (event.honor_type) kvs.push(`荣誉=${event.honor_type}`);
  return `<事件:${label}>` + (kvs.length ? " " + kvs.join(" ") : "");
}

function formatEventForAI(event: any): string {
  const label = labelForEvent(event);
  const gid = event.group_id ? `群 ${event.group_id}` : "";
  const uid = event.user_id ? `用户 ${event.user_id}` : "";
  const op = event.operator_id ? `操作者 ${event.operator_id}` : "";
  
  switch (label) {
    case "成员退群": return `${uid} 退出了 ${gid}`;
    case "成员被踢": return `${uid} 被 ${op} 移出了 ${gid}`;
    case "成员加群": return `${uid} 加入了 ${gid}`;
    case "群撤回": return `${uid} 在 ${gid} 撤回了一条消息`;
    case "私聊撤回": return `${uid} 撤回了一条私聊消息`;
    case "群禁言": return `${uid} 在 ${gid} 被禁言 ${event.duration || 0} 秒`;
    case "设置群管理员": return `${op} 在 ${gid} ${event.sub_type === "set" ? "设置" : "取消"} 了 ${uid} 的管理员`;
    case "加好友请求": return `${uid} 请求加为好友，附言：${event.comment || ""}`;
    case "入群邀请": return `${uid} 邀请加入 ${gid}`;
    case "加群申请": return `${uid} 申请加入 ${gid}，附言：${event.comment || ""}`;
    case "群文件上传": return `${uid} 在 ${gid} 上传了文件 ${event.file?.name || ""}`;
    case "群内戳一戳": return `${uid} 向 ${event.target_id || "群内成员"} 发起了戳一戳（在 ${gid}）`;
    case "群精华": {
      const op2 = event.operator_id ? `操作者 ${event.operator_id}` : "";
      const act = event.sub_type === 'delete' ? '移除了精华' : '添加为精华';
      const mid = event.message_id ? `（消息ID:${event.message_id}）` : '';
      return `${op2} 将 ${uid} 在 ${gid} 的一条消息${act}${mid}`.trim();
    }
    default: return formatEventString(event);
  }
}

function isEventMatched(event: any, triggerRegexes: string[]): boolean {
  const triggerRegex = triggerRegexes.join('|');
  if (!triggerRegex) return false;
  
  try {
    const pattern = new RegExp(triggerRegex);
    
    const eventDesc = buildEventDescription(event);
    return pattern.test(eventDesc);
  } catch (e) {
    logger.error(`事件正则表达式错误: ${triggerRegex}, 错误: ${e.message}`);
    return false;
  }
}

function buildEventDescription(event: any): string {
  const { post_type, notice_type, request_type, sub_type } = event;
  
  let desc = post_type;
  if (notice_type) desc += `.${notice_type}`;
  if (request_type) desc += `.${request_type}`;
  if (sub_type) desc += `.${sub_type}`;
  
  const fields = [];
  if (event.group_id) fields.push(`群=${event.group_id}`);
  if (event.user_id) fields.push(`用户=${event.user_id}`);
  if (event.operator_id) fields.push(`操作者=${event.operator_id}`);
  if (event.target_id) fields.push(`目标=${event.target_id}`);
  if (event.duration) fields.push(`时长=${event.duration}`);
  if (event.message_id) fields.push(`消息ID=${event.message_id}`);
  if (event.comment) fields.push(`消息=${event.comment}`);
  if (event.file?.name) fields.push(`文件=${event.file.name}`);
  if (event.honor_type) fields.push(`荣誉=${event.honor_type}`);
  
  return fields.length > 0 ? `${desc} ${fields.join(' ')}` : desc;
}

export function registerEventHandlers() {
  try {
    function doRegister() {
        const net = globalThis.net || globalThis.http;
        if (!net) {
            logger.error(`未找到ob11网络连接依赖`);
            return `未找到ob11网络连接依赖，请提示用户安装`;
        }
        if (globalThis.net?.getWs) {
          globalThis.net.getWs(net)
            .then((ws) => {
              ws.onNoticeEvent = (epId, event) => handleEvent(epId, event);
              ws.onRequestEvent = (epId, event) => handleEvent(epId, event);
            })
            .catch((err) => {
              logger.error(`获取 WebSocket 连接失败: ${err.message}`);
            });
          return true;
        }
      return false;
    }

    if (!doRegister()) {
      const interval = setInterval(() => {
        if (doRegister()) clearInterval(interval);
      }, 1000);
      setTimeout(() => clearInterval(interval), 60000);
    }

    async function handleEvent(epId: string, event: any) {
      const { post_type } = event;
      if (post_type !== "notice" && post_type !== "request") return;

      const { triggerRegexes, triggerCondition, disabledInPrivate, globalStandby } = ConfigManager.received;
      const isGroup = !!event.group_id;
      
      if (!isGroup && event.notice_type !== "friend_recall") return;

      const messageType = isGroup ? "group" : "private";
      const id = isGroup ? `QQ-Group:${event.group_id}` : `QQ:${event.user_id}`;
      const msg = createMsg(messageType, `QQ:${event.user_id || event.self_id || "0"}`, isGroup ? `QQ-Group:${event.group_id}` : "");

      if (event.message_id != null) {
        const num = typeof event.message_id === 'string' ? parseInt(event.message_id) : event.message_id;
        if (!isNaN(num)) {
          event.message_id = transformMsgId(num);
        }
      }

      const contentMachine = formatEventString(event);
      const contentNatural = formatEventForAI(event);
      msg.message = contentNatural;

      const ctx = createCtx(epId, msg);
      if (!ctx || (ctx.isPrivate && disabledInPrivate)) return;

      const ai = AIManager.getAI(id);
      if (!ai) return;

      const setting = ai.setting;
      
      if (setting.standby || globalStandby) {
        await ai.context.addSystemUserMessage("事件", `${contentMachine} ${contentNatural}`, []);
      }
      
      if (isEventMatched(event, triggerRegexes)) {
        const fmtCondition = parseInt(seal.format(ctx, `{${triggerCondition}}`));
        if (fmtCondition === 1) {
          await ai.chat(ctx, msg, "事件触发");
        }
      }

      AIManager.saveAI(id);
    }
  } catch (e: any) {
    logger.error(`注册事件监听失败: ${e.message}`);
  }
}