// 插件入口：注册配置、工具、命令与事件处理器，并启动各模块（含智能体初始化）
import { getSession } from "./session/session_service";
import Tool from "./tool/tool";
import Config from "./config/config";
import { triggerConditionMap } from "./tool/tools/tool_trigger";
import { logger } from "./logger";
import { fmtDate, transformTextToArray } from "./utils/string";
import { checkUpdate } from "./utils/update";
import { TimerManager } from "./timer";
import { createMsg } from "./utils/seal";
import { PrivilegeManager } from "./cmd/privilege";
import { knowledgeService } from "./memory/knowledge";
import { CQ_TYPES_ALLOW } from "./config/static_config";
import { registerCmd } from "./cmd/root_cmd";
import "./agent/agents";

function main() {
  Handlebars.registerHelper('index', (index: number) => index + 1);
  Handlebars.registerHelper('json_stringify', (obj: any) => JSON.stringify(obj, null, 2));
  Handlebars.registerHelper('time', (t: number) => fmtDate(t));

  Config.registerConfig();
  checkUpdate();
  Tool.registerTool();
  TimerManager.init();
  knowledgeService.init();

  const ext = Config.ext;

  registerCmd();
  PrivilegeManager.reviveCmdPriv();

  ext.onPoke = (ctx: seal.MsgContext, event: seal.PokeEvent) => {
    const msg = createMsg(event.isPrivate ? 'private' : 'group', event.senderId, event.groupId);
    msg.message = `[CQ:poke,qq=${event.targetId.replace(/^.+:/, '')}]`;
    if (event.senderId === ctx.endPoint.userId) ext.onMessageSend(ctx, msg);
    else ext.onNotCommandReceived(ctx, msg);
  }

  //接受非指令消息
  ext.onNotCommandReceived = (ctx: seal.MsgContext, msg: seal.Message): void | Promise<void> => {
    try {
      const { IGNORE_PRIVATE: disabledInPrivate, IGNORE_REGEX: ignoreRegex, IGNORE_CONDITION } = Config.received;
      const { TRIGGER_REGEX: triggerRegex, TRIGGER_CONDITION: triggerCondition } = Config.trigger;
      if (ctx.isPrivate && disabledInPrivate) {
        return;
      }

      const uid = ctx.player.userId;
      const gid = ctx.group.groupId;
      const sid = ctx.isPrivate ? uid : gid;
      const session = getSession(sid);

      // 检查活跃时间定时器
      session.checkActiveTimer(ctx);

      const message = msg.message;
      const messageArray = transformTextToArray(message);

      // 非指令消息忽略
      // 忽略条件（豹语表达式）命中时直接忽略
      if (parseInt(seal.format(ctx, `{${IGNORE_CONDITION}}`)) === 1) {
        logger.info('忽略消息条件命中，跳过');
        return;
      }

      if (ignoreRegex.test(message)) {
        logger.info(`非指令消息忽略:${message}`);
        return;
      }

      // 检查CQ码
      const CQTypes = messageArray.filter(item => item.type !== 'text').map(item => item.type);
      if (CQTypes.length === 0 || CQTypes.every(item => CQ_TYPES_ALLOW.includes(item))) {
        clearTimeout(session.context.timer);
        session.context.timer = null;

        // 非指令消息触发
        if (triggerRegex.test(message)) {
          const fmtCondition = parseInt(seal.format(ctx, `{${triggerCondition}}`));
          if (fmtCondition === 1) {
            return session.handleReceipt(ctx, msg, messageArray)
              .then(() => session.chat(ctx, msg, '非指令'));
          }
        }

        // AI自己设定的触发条件触发
        if (triggerConditionMap.hasOwnProperty(sid) && triggerConditionMap[sid].length !== 0) {
          for (let i = 0; i < triggerConditionMap[sid].length; i++) {
            const condition = triggerConditionMap[sid][i];
            if (condition.keyword && !new RegExp(condition.keyword).test(message)) {
              continue;
            }
            if (condition.uid && condition.uid !== uid) {
              continue;
            }

            return session.handleReceipt(ctx, msg, messageArray)
              .then(() => session.context.addSystemUserMessage(condition.reason, '触发原因提示'))
              .then(() => triggerConditionMap[sid].splice(i, 1))
              .then(() => session.chat(ctx, msg, 'AI设定触发条件'));
          }
        }

        // 开启任一模式时
        const setting = session.setting;
        if (setting.standby || Config.base.GLOBAL_STANDBY) {
          session.handleReceipt(ctx, msg, messageArray)
            .then((): void | Promise<void> => {
              if (setting.counter > -1) {
                session.context.counter += 1;
                if (session.context.counter >= setting.counter) {
                  session.context.counter = 0;
                  return session.chat(ctx, msg, '计数器');
                }
              }

              if (setting.prob > -1) {
                const ran = Math.random() * 100;
                if (ran <= setting.prob) {
                  return session.chat(ctx, msg, '概率');
                }
              }

              if (setting.timer > -1) {
                session.context.timer = setTimeout(() => {
                  session.context.timer = null;
                  session.chat(ctx, msg, '计时器');
                }, setting.timer * 1000 + Math.floor(Math.random() * 500));
              }
            })
            .then(() => session.save());
        }
      }
    } catch (e) {
      logger.error(`非指令消息处理出错，错误信息:${e.message}`);
    }
  }

  //接受的指令
  ext.onCommandReceived = (ctx: seal.MsgContext, msg: seal.Message, cmdArgs: seal.CmdArgs) => {
    try {
      if (Tool.cmdArgs === null) {
        Tool.cmdArgs = cmdArgs;
      }

      const { RECEIVE_CMD: allcmd } = Config.received;
      if (allcmd) {
        const uid = ctx.player.userId;
        const gid = ctx.group.groupId;
        const sid = ctx.isPrivate ? uid : gid;
        const session = getSession(sid);

        // 检查活跃时间定时器
        session.checkActiveTimer(ctx);

        const message = msg.message;
        const messageArray = transformTextToArray(message);

        const CQTypes = messageArray.filter(item => item.type !== 'text').map(item => item.type);
        if (CQTypes.length === 0 || CQTypes.every(item => CQ_TYPES_ALLOW.includes(item))) {
          const setting = session.setting;
          if (setting.standby) {
            session.handleReceipt(ctx, msg, messageArray).then(() => session.save());
          }
        }
      }
    } catch (e) {
      logger.error(`指令消息处理出错，错误信息:${e.message}`);
    }
  }

  //骰子发送的消息
  ext.onMessageSend = (ctx: seal.MsgContext, msg: seal.Message) => {
    try {
      const uid = ctx.player.userId;
      const gid = ctx.group.groupId;
      const sid = ctx.isPrivate ? uid : gid;
      const session = getSession(sid);

      // 检查活跃时间定时器
      session.checkActiveTimer(ctx);

      const message = msg.message;
      const messageArray = transformTextToArray(message);

      session.tool.listen.resolve?.(message); // 将消息传递给监听工具

      const { RECEIVE_MSG_BY_BOT: allmsg } = Config.received;
      if (allmsg) {
        if (message === session.context.lastReply) {
          session.context.lastReply = '';
          return;
        }

        const CQTypes = messageArray.filter(item => item.type !== 'text').map(item => item.type);
        if (CQTypes.length === 0 || CQTypes.every(item => CQ_TYPES_ALLOW.includes(item))) {
          const setting = session.setting;
          if (setting.standby) {
            session.handleReceipt(ctx, msg, messageArray).then(() => session.save());
          }
        }
      }
    } catch (e) {
      logger.error(`获取发送消息处理出错，错误信息:${e.message}`);
    }
  }
}

main();
