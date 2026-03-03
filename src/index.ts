import { AIManager } from "./AI/AI";
import { ToolManager } from "./tool/tool";
import { ConfigManager } from "./config/configManager";
import { triggerConditionMap } from "./tool/tool_trigger";
import { logger } from "./logger";
import { transformTextToArray } from "./utils/utils_string";
import { checkUpdate } from "./utils/utils_update";
import { TimerManager } from "./timer";
import { createMsg } from "./utils/utils_seal";
import { PrivilegeManager } from "./cmd/privilege";
import { knowledgeMM } from "./AI/memory";
import { CQTYPESALLOW } from "./config/config";
import { registerCmd } from "./cmd/root";

function main() {
  ConfigManager.registerConfig();
  checkUpdate();
  ToolManager.registerTool();
  TimerManager.init();
  knowledgeMM.init();

  const ext = ConfigManager.ext;

  registerCmd();
  PrivilegeManager.reviveCmdPriv();

  ext.onPoke = (ctx, event) => {
    const msg = createMsg(event.isPrivate ? 'private' : 'group', event.senderId, event.groupId);
    msg.message = `[CQ:poke,qq=${event.targetId.replace(/^.+:/, '')}]`;
    if (event.senderId === ctx.endPoint.userId) ext.onMessageSend(ctx, msg);
    else ext.onNotCommandReceived(ctx, msg);
  }

  //接受非指令消息
  ext.onNotCommandReceived = (ctx, msg): void | Promise<void> => {
    try {
      const { disabledInPrivate, globalStandby, triggerRegex, ignoreRegex, triggerCondition } = ConfigManager.received;
      if (ctx.isPrivate && disabledInPrivate) {
        return;
      }

      const uid = ctx.player.userId;
      const gid = ctx.group.groupId;
      const sid = ctx.isPrivate ? uid : gid;
      const ai = AIManager.getAI(sid);

      // 检查活跃时间定时器
      ai.checkActiveTimer(ctx);

      const message = msg.message;
      const messageArray = transformTextToArray(message);

      // 非指令消息忽略
      if (ignoreRegex.test(message)) {
        logger.info(`非指令消息忽略:${message}`);
        return;
      }

      // 检查CQ码
      const CQTypes = messageArray.filter(item => item.type !== 'text').map(item => item.type);
      if (CQTypes.length === 0 || CQTypes.every(item => CQTYPESALLOW.includes(item))) {
        clearTimeout(ai.context.timer);
        ai.context.timer = null;

        // 非指令消息触发
        if (triggerRegex.test(message)) {
          const fmtCondition = parseInt(seal.format(ctx, `{${triggerCondition}}`));
          if (fmtCondition === 1) {
            return ai.handleReceipt(ctx, msg, ai, messageArray)
              .then(() => ai.chat(ctx, msg, '非指令'));
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

            return ai.handleReceipt(ctx, msg, ai, messageArray)
              .then(() => ai.context.addSystemUserMessage('触发原因提示', condition.reason, []))
              .then(() => triggerConditionMap[sid].splice(i, 1))
              .then(() => ai.chat(ctx, msg, 'AI设定触发条件'));
          }
        }

        // 开启任一模式时
        const setting = ai.setting;
        if (setting.standby || globalStandby) {
          ai.handleReceipt(ctx, msg, ai, messageArray)
            .then((): void | Promise<void> => {
              if (setting.counter > -1) {
                ai.context.counter += 1;
                if (ai.context.counter >= setting.counter) {
                  ai.context.counter = 0;
                  return ai.chat(ctx, msg, '计数器');
                }
              }

              if (setting.prob > -1) {
                const ran = Math.random() * 100;
                if (ran <= setting.prob) {
                  return ai.chat(ctx, msg, '概率');
                }
              }

              if (setting.timer > -1) {
                ai.context.timer = setTimeout(() => {
                  ai.context.timer = null;
                  ai.chat(ctx, msg, '计时器');
                }, setting.timer * 1000 + Math.floor(Math.random() * 500));
              }
            });
        }
      }
    } catch (e) {
      logger.error(`非指令消息处理出错，错误信息:${e.message}`);
    }
  }

  //接受的指令
  ext.onCommandReceived = (ctx, msg, cmdArgs) => {
    try {
      if (ToolManager.cmdArgs === null) {
        ToolManager.cmdArgs = cmdArgs;
      }

      const { allcmd } = ConfigManager.received;
      if (allcmd) {
        const uid = ctx.player.userId;
        const gid = ctx.group.groupId;
        const sid = ctx.isPrivate ? uid : gid;
        const ai = AIManager.getAI(sid);

        // 检查活跃时间定时器
        ai.checkActiveTimer(ctx);

        const message = msg.message;
        const messageArray = transformTextToArray(message);

        const CQTypes = messageArray.filter(item => item.type !== 'text').map(item => item.type);
        if (CQTypes.length === 0 || CQTypes.every(item => CQTYPESALLOW.includes(item))) {
          const setting = ai.setting;
          if (setting.standby) {
            ai.handleReceipt(ctx, msg, ai, messageArray);
          }
        }
      }
    } catch (e) {
      logger.error(`指令消息处理出错，错误信息:${e.message}`);
    }
  }

  //骰子发送的消息
  ext.onMessageSend = (ctx, msg) => {
    try {
      const uid = ctx.player.userId;
      const gid = ctx.group.groupId;
      const sid = ctx.isPrivate ? uid : gid;
      const ai = AIManager.getAI(sid);

      // 检查活跃时间定时器
      ai.checkActiveTimer(ctx);

      const message = msg.message;
      const messageArray = transformTextToArray(message);

      ai.tool.listen.resolve?.(message); // 将消息传递给监听工具

      const { allmsg } = ConfigManager.received;
      if (allmsg) {
        if (message === ai.context.lastReply) {
          ai.context.lastReply = '';
          return;
        }

        const CQTypes = messageArray.filter(item => item.type !== 'text').map(item => item.type);
        if (CQTypes.length === 0 || CQTypes.every(item => CQTYPESALLOW.includes(item))) {
          const setting = ai.setting;
          if (setting.standby) {
            ai.handleReceipt(ctx, msg, ai, messageArray);
          }
        }
      }
    } catch (e) {
      logger.error(`获取发送消息处理出错，错误信息:${e.message}`);
    }
  }
}

main();
