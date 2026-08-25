// 插件入口：装配配置、模型、记忆、工具、命令与事件管线
import Handlebars from "handlebars";

import { initAgents } from "./agent/agents";
import { registerAgentApi } from "./agent/api";
import { BlockManager } from "./block";
import { PrivilegeManager } from "./cmd/privilege";
import { registerCmd } from "./cmd/root_cmd";
import { ext } from "./config/config";
import Config from "./config/config";
import { STORAGE_VERSION } from "./config/static_config";
import { logger } from "./logger";
import { knowledgeService } from "./memory/knowledge";
import { MessagePipeline } from "./pipeline";
import { TimerManager } from "./timer";
import Tool from "./tool/tool";
import { createMsg } from "./utils/seal";
import { fmtDate } from "./utils/string";
import { checkUpdate } from "./utils/update";

const log = logger.withTag('main');

function main() {
  Handlebars.registerHelper('index', (index: number) => index + 1);
  Handlebars.registerHelper('json_stringify', (obj: any) => JSON.stringify(obj, null, 2));
  Handlebars.registerHelper('time', (t: number) => fmtDate(t));

  Config.registerConfig();
  initAgents();
  registerAgentApi();
  checkUpdate();
  Tool.registerTool();
  TimerManager.init();
  knowledgeService.init();
  BlockManager.initBlockList();

  registerCmd();
  PrivilegeManager.reviveCmdPriv();
  // ob11 依赖存在时订阅其事件分发，接收核心原生 milky 路径过滤掉的卡片/视频/文件/合并转发等段
  MessagePipeline.subscribeOb11Receive();

  // 存储版本标记：结构变更时递增，供后续迁移使用
  const storedVersion = parseInt(ext.storageGet('storage_version') || '0');
  if (storedVersion < STORAGE_VERSION) {
    ext.storageSet('storage_version', String(STORAGE_VERSION));
    log.info(`存储版本升级: ${storedVersion} -> ${STORAGE_VERSION}`);
  }

  ext.onPoke = (ctx: seal.MsgContext, event: seal.PokeEvent) => {
    const uid = event.senderId;
    const blockReason = BlockManager.checkBlock(uid);
    if (blockReason) {
      log.info(`用户<${uid}>在黑名单中，原因: ${blockReason}，忽略戳一戳`);
      return;
    }

    if (!event.isPrivate) {
      const gid = event.groupId;
      const groupBlockReason = BlockManager.checkBlock(gid);
      if (groupBlockReason) {
        log.info(`群组<${gid}>在黑名单中，原因: ${groupBlockReason}，忽略戳一戳`);
        return;
      }
    }

    const msg = createMsg(event.isPrivate ? 'private' : 'group', event.senderId, event.groupId);
    msg.message = `[CQ:poke,qq=${event.targetId.replace(/^.+:/, '')}]`;
    if (event.senderId === ctx.endPoint.userId) ext.onMessageSend(ctx, msg, '');
    else ext.onNotCommandReceived(ctx, msg);
  }

  // 原生已覆盖的群/好友事件（成员加入/退出/撤回/加好友/入驻）：
  // 这些类型默认就在通知事件白名单中，事件仅作背景不触发 AI；
  // 与 ob11 依赖的通知事件双路径共用 3s 事件级去重，防止同一条事件被记录两次。
  ext.onGroupMemberJoined = (ctx: seal.MsgContext, msg: seal.Message) => {
    try {
      const prefix = ctx.endPoint.userId.includes(':') ? ctx.endPoint.userId.slice(0, ctx.endPoint.userId.indexOf(':')) : 'QQ';
      MessagePipeline.handleNativeNoticeEvent(ctx.endPoint.userId, `${prefix}-Group:${msg.groupId}`, {
        noticeType: 'group_increase',
        userId: msg.sender.userId,
      }).catch((e: any) => log.exception('群成员加入事件处理出错', e));
    } catch (e) {
      log.exception('群成员加入事件处理出错', e);
    }
  };

  ext.onGroupLeave = (ctx: seal.MsgContext, event: seal.GroupLeaveEvent) => {
    try {
      const prefix = ctx.endPoint.userId.includes(':') ? ctx.endPoint.userId.slice(0, ctx.endPoint.userId.indexOf(':')) : 'QQ';
      MessagePipeline.handleNativeNoticeEvent(ctx.endPoint.userId, `${prefix}-Group:${event.groupId}`, {
        noticeType: 'group_decrease',
        subType: event.operatorId ? 'kick' : 'leave',
        userId: `${prefix}:${event.userId}`,
        operatorId: event.operatorId ? `${prefix}:${event.operatorId}` : '',
      }).catch((e: any) => log.exception('群成员退出事件处理出错', e));
    } catch (e) {
      log.exception('群成员退出事件处理出错', e);
    }
  };

  ext.onMessageDeleted = (ctx: seal.MsgContext, msg: seal.Message) => {
    try {
      const prefix = ctx.endPoint.userId.includes(':') ? ctx.endPoint.userId.slice(0, ctx.endPoint.userId.indexOf(':')) : 'QQ';
      const messageId = msg.rawId !== undefined && msg.rawId !== null ? String(msg.rawId) : '';
      if (msg.messageType === 'group') {
        MessagePipeline.handleNativeNoticeEvent(ctx.endPoint.userId, `${prefix}-Group:${msg.groupId}`, {
          noticeType: 'group_recall',
          userId: msg.sender.userId,
          messageId,
        }).catch((e: any) => log.exception('消息撤回事件处理出错', e));
      } else {
        MessagePipeline.handleNativeNoticeEvent(ctx.endPoint.userId, msg.sender.userId, {
          noticeType: 'friend_recall',
          userId: msg.sender.userId,
          messageId,
        }).catch((e: any) => log.exception('消息撤回事件处理出错', e));
      }
    } catch (e) {
      log.exception('消息撤回事件处理出错', e);
    }
  };

  ext.onBecomeFriend = (ctx: seal.MsgContext, msg: seal.Message) => {
    try {
      MessagePipeline.handleNativeNoticeEvent(ctx.endPoint.userId, msg.sender.userId, {
        noticeType: 'friend_add',
        userId: msg.sender.userId,
      }).catch((e: any) => log.exception('成为好友事件处理出错', e));
    } catch (e) {
      log.exception('成为好友事件处理出错', e);
    }
  };

  ext.onGroupJoined = (ctx: seal.MsgContext, msg: seal.Message) => {
    try {
      const prefix = ctx.endPoint.userId.includes(':') ? ctx.endPoint.userId.slice(0, ctx.endPoint.userId.indexOf(':')) : 'QQ';
      MessagePipeline.handleNativeNoticeEvent(ctx.endPoint.userId, `${prefix}-Group:${msg.groupId}`, {
        noticeType: 'group_joined',
      }).catch((e: any) => log.exception('加入群聊事件处理出错', e));
    } catch (e) {
      log.exception('加入群聊事件处理出错', e);
    }
  };

  //接受非指令消息
  ext.onNotCommandReceived = (ctx: seal.MsgContext, msg: seal.Message): void | Promise<void> => {
    try {
      const p = MessagePipeline.handleNonCommand(ctx, msg);
      if (p && typeof (p as Promise<void>).catch === 'function') {
        (p as Promise<void>).catch((e: any) => {
          log.exception('非指令消息处理异步出错', e);
        });
      }
      return p;
    } catch (e) {
      log.exception('非指令消息处理出错', e);
    }
  }

  //接受的指令
  ext.onCommandReceived = (ctx: seal.MsgContext, msg: seal.Message) => {
    try {
      MessagePipeline.handleCommand(ctx, msg);
    } catch (e) {
      log.exception('指令消息处理出错', e);
    }
  }

  //骰子发送的消息
  ext.onMessageSend = (ctx: seal.MsgContext, msg: seal.Message) => {
    try {
      log.debug(`[onMessageSend] 收到机器人出站消息 session=${ctx.isPrivate ? ctx.player?.userId : ctx.group?.groupId} text=${String(msg.message || "").slice(0, 120)}`);
      MessagePipeline.handleBotMessage(ctx, msg);
    } catch (e) {
      log.exception('获取发送消息处理出错', e);
    }
  }
}

main();
