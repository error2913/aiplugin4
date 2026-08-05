// 插件入口：装配配置、模型、记忆、工具、命令与事件管线
import Handlebars from "handlebars";

import { initAgents } from "./agent/agents";
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
  checkUpdate();
  Tool.registerTool();
  TimerManager.init();
  knowledgeService.init();

  registerCmd();
  PrivilegeManager.reviveCmdPriv();

  // 存储版本标记：结构变更时递增，供后续迁移使用
  const storedVersion = parseInt(ext.storageGet('storage_version') || '0');
  if (storedVersion < STORAGE_VERSION) {
    ext.storageSet('storage_version', String(STORAGE_VERSION));
    logger.info(`存储版本升级: ${storedVersion} -> ${STORAGE_VERSION}`);
  }

  ext.onPoke = (ctx: seal.MsgContext, event: seal.PokeEvent) => {
    const msg = createMsg(event.isPrivate ? 'private' : 'group', event.senderId, event.groupId);
    msg.message = `[CQ:poke,qq=${event.targetId.replace(/^.+:/, '')}]`;
    if (event.senderId === ctx.endPoint.userId) ext.onMessageSend(ctx, msg);
    else ext.onNotCommandReceived(ctx, msg);
  }

  //接受非指令消息
  ext.onNotCommandReceived = (ctx: seal.MsgContext, msg: seal.Message): void | Promise<void> => {
    try {
      return MessagePipeline.handleNonCommand(ctx, msg);
    } catch (e) {
      logger.error(`非指令消息处理出错，错误信息:${e instanceof Error ? e.message : String(e)}`);
    }
  }

  //接受的指令
  ext.onCommandReceived = (ctx: seal.MsgContext, msg: seal.Message, cmdArgs: seal.CmdArgs) => {
    try {
      MessagePipeline.handleCommand(ctx, msg, cmdArgs);
    } catch (e) {
      logger.error(`指令消息处理出错，错误信息:${e instanceof Error ? e.message : String(e)}`);
    }
  }

  //骰子发送的消息
  ext.onMessageSend = (ctx: seal.MsgContext, msg: seal.Message) => {
    try {
      MessagePipeline.handleBotMessage(ctx, msg);
    } catch (e) {
      logger.error(`获取发送消息处理出错，错误信息:${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

main();
