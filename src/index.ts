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
    logger.info(`存储版本升级: ${storedVersion} -> ${STORAGE_VERSION}`);
  }

  ext.onPoke = (ctx: seal.MsgContext, event: seal.PokeEvent) => {
    const uid = event.senderId;
    const blockReason = BlockManager.checkBlock(uid);
    if (blockReason) {
      logger.info(`用户<${uid}>在黑名单中，原因: ${blockReason}，忽略戳一戳`);
      return;
    }

    if (!event.isPrivate) {
      const gid = event.groupId;
      const groupBlockReason = BlockManager.checkBlock(gid);
      if (groupBlockReason) {
        logger.info(`群组<${gid}>在黑名单中，原因: ${groupBlockReason}，忽略戳一戳`);
        return;
      }
    }

    const msg = createMsg(event.isPrivate ? 'private' : 'group', event.senderId, event.groupId);
    msg.message = `[CQ:poke,qq=${event.targetId.replace(/^.+:/, '')}]`;
    if (event.senderId === ctx.endPoint.userId) ext.onMessageSend(ctx, msg, '');
    else ext.onNotCommandReceived(ctx, msg);
  }

  //接受非指令消息
  ext.onNotCommandReceived = (ctx: seal.MsgContext, msg: seal.Message): void | Promise<void> => {
    try {
      const p = MessagePipeline.handleNonCommand(ctx, msg);
      if (p && typeof (p as Promise<void>).catch === 'function') {
        (p as Promise<void>).catch((e: any) => {
          logger.error(`非指令消息处理异步出错:${e instanceof Error ? e.message : String(e)}`);
        });
      }
      return p;
    } catch (e) {
      logger.error(`非指令消息处理出错，错误信息:${e instanceof Error ? e.message : String(e)}`);
    }
  }

  //接受的指令
  ext.onCommandReceived = (ctx: seal.MsgContext, msg: seal.Message) => {
    try {
      MessagePipeline.handleCommand(ctx, msg);
    } catch (e) {
      logger.error(`指令消息处理出错，错误信息:${e instanceof Error ? e.message : String(e)}`);
    }
  }

  //骰子发送的消息
  ext.onMessageSend = (ctx: seal.MsgContext, msg: seal.Message) => {
    try {
      logger.debug(`[onMessageSend] 收到机器人出站消息 session=${ctx.isPrivate ? ctx.player?.userId : ctx.group?.groupId} text=${String(msg.message || "").slice(0, 120)}`);
      MessagePipeline.handleBotMessage(ctx, msg);
    } catch (e) {
      logger.error(`获取发送消息处理出错，错误信息:${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

main();
