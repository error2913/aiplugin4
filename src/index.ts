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
import { getPlatform, normalizeGroupId, normalizeUserId } from "./utils/target_id";
import { checkUpdate } from "./utils/update";
import { normalizeMsgId } from "./utils/utils";

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
  // 注意：seal 原生回调给出的 ID 已是 UNI-ID（QQ:xxx / QQ-Group:xxx），这里统一再经
  // normalizeGroupId/normalizeUserId 归一（兼容个别仍给裸数字的旧适配器），保证与 ob11
  // 依赖路径（统一单前缀）拼出的去重 key 完全一致；无法归一时跳过，避免污染会话/黑名单判定。
  ext.onGroupMemberJoined = (ctx: seal.MsgContext, msg: seal.Message) => {
    try {
      const platform = getPlatform(ctx.endPoint.userId);
      const sid = normalizeGroupId(msg.groupId, platform);
      const userId = normalizeUserId(msg.sender.userId, platform);
      if (!sid || !userId) {
        log.debug(`群成员加入事件 ID 无法归一化，跳过: group=${msg.groupId} sender=${msg.sender.userId}`);
        return;
      }
      MessagePipeline.handleNativeNoticeEvent(ctx.endPoint.userId, sid, {
        noticeType: 'group_increase',
        userId,
      }).catch((e: any) => log.exception('群成员加入事件处理出错', e));
    } catch (e) {
      log.exception('群成员加入事件处理出错', e);
    }
  };

  ext.onGroupLeave = (ctx: seal.MsgContext, event: seal.GroupLeaveEvent) => {
    try {
      const platform = getPlatform(ctx.endPoint.userId);
      const sid = normalizeGroupId(event.groupId, platform);
      const userId = normalizeUserId(event.userId, platform);
      const operatorId = event.operatorId ? (normalizeUserId(event.operatorId, platform) ?? '') : '';
      if (!sid || !userId) {
        log.debug(`群成员退出事件 ID 无法归一化，跳过: group=${event.groupId} user=${event.userId}`);
        return;
      }
      // 被移出的是机器人自身（归一后等于端点）→ kick_me；其余按是否有操作者区分踢出/退群
      const isSelf = userId === ctx.endPoint.userId;
      const subType = isSelf && !!event.operatorId ? 'kick_me' : event.operatorId ? 'kick' : 'leave';
      MessagePipeline.handleNativeNoticeEvent(ctx.endPoint.userId, sid, {
        noticeType: 'group_decrease',
        subType,
        userId,
        operatorId,
      }).catch((e: any) => log.exception('群成员退出事件处理出错', e));
    } catch (e) {
      log.exception('群成员退出事件处理出错', e);
    }
  };

  ext.onMessageDeleted = (ctx: seal.MsgContext, msg: seal.Message) => {
    try {
      const platform = getPlatform(ctx.endPoint.userId);
      const messageId = normalizeMsgId(msg.rawId);
      if (msg.messageType === 'group') {
        const sid = normalizeGroupId(msg.groupId, platform);
        const userId = normalizeUserId(msg.sender.userId, platform) || '';
        if (!sid) {
          log.debug(`消息撤回事件群 ID 无法归一化，跳过: group=${msg.groupId}`);
          return;
        }
        MessagePipeline.handleNativeNoticeEvent(ctx.endPoint.userId, sid, {
          noticeType: 'group_recall',
          userId,
          messageId,
        }).catch((e: any) => log.exception('消息撤回事件处理出错', e));
      } else {
        const sid = normalizeUserId(msg.sender.userId, platform);
        if (!sid) {
          log.debug(`消息撤回事件用户 ID 无法归一化，跳过: sender=${msg.sender.userId}`);
          return;
        }
        MessagePipeline.handleNativeNoticeEvent(ctx.endPoint.userId, sid, {
          noticeType: 'friend_recall',
          userId: sid,
          messageId,
        }).catch((e: any) => log.exception('消息撤回事件处理出错', e));
      }
    } catch (e) {
      log.exception('消息撤回事件处理出错', e);
    }
  };

  ext.onBecomeFriend = (ctx: seal.MsgContext, msg: seal.Message) => {
    try {
      const platform = getPlatform(ctx.endPoint.userId);
      const sid = normalizeUserId(msg.sender.userId, platform);
      if (!sid) {
        log.debug(`成为好友事件用户 ID 无法归一化，跳过: sender=${msg.sender.userId}`);
        return;
      }
      MessagePipeline.handleNativeNoticeEvent(ctx.endPoint.userId, sid, {
        noticeType: 'friend_add',
        userId: sid,
      }).catch((e: any) => log.exception('成为好友事件处理出错', e));
    } catch (e) {
      log.exception('成为好友事件处理出错', e);
    }
  };

  ext.onGroupJoined = (ctx: seal.MsgContext, msg: seal.Message) => {
    try {
      const platform = getPlatform(ctx.endPoint.userId);
      const sid = normalizeGroupId(msg.groupId, platform);
      if (!sid) {
        log.debug(`加入群聊事件群 ID 无法归一化，跳过: group=${msg.groupId}`);
        return;
      }
      MessagePipeline.handleNativeNoticeEvent(ctx.endPoint.userId, sid, {
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
