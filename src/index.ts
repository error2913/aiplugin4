import { AIManager } from "./AI/AI";
import { Image, ImageManager } from "./AI/image";
import { ToolManager } from "./tool/tool";
import { ConfigManager, CQTYPESALLOW, HELPMAP } from "./config/config";
import { buildSystemMessage } from "./utils/utils_message";
import { triggerConditionMap } from "./tool/tool_trigger";
import { logger } from "./logger";
import { fmtDate, transformTextToArray } from "./utils/utils_string";
import { checkUpdate } from "./utils/utils_update";
import { get_chart_url } from "./service";
import { TimerManager } from "./timer";
import { createMsg } from "./utils/utils_seal";
import { PrivilegeManager } from "./privilege";
import { aliasToCmd } from "./utils/utils";

function main() {
  ConfigManager.registerConfig();
  checkUpdate();
  AIManager.getUsageMap();
  ToolManager.registerTool();
  TimerManager.init();
  PrivilegeManager.reviveCmdPriv();

  const ext = ConfigManager.ext;

  const cmdAI = seal.ext.newCmdItemInfo();
  cmdAI.name = 'ai';
  cmdAI.help = `帮助:
【.ai priv】权限相关
【.ai prompt】查看system prompt
【.ai status】查看当前AI状态
【.ai ctxn】查看上下文里的名字
【.ai timer】定时器相关
【.ai on】开启AI
【.ai sb】开启待机模式，此时AI将记录聊天内容
【.ai off】关闭AI，此时仍能用正则匹配触发
【.ai fgt】遗忘上下文
【.ai role】角色设定相关
【.ai memo】AI的记忆相关
【.ai tool】AI的工具相关
【.ai ign】AI的忽略名单相关
【.ai tk】AI的token相关
【.ai shut】终止AI当前流式输出`;
  cmdAI.allowDelegate = true;
  cmdAI.solve = (ctx, msg, cmdArgs) => {
    try {
      const val = cmdArgs.getArgN(1);
      const uid = ctx.player.userId;
      const gid = ctx.group.groupId;
      const id = ctx.isPrivate ? uid : gid;

      const ret = seal.ext.newCmdExecuteResult(true);
      const ai = AIManager.getAI(id);
      const { success, exist } = PrivilegeManager.checkPriv(ctx, cmdArgs, ai);
      if (!success) {
        seal.replyToSender(ctx, msg, exist ? '权限不足' : '命令不存在');
        return ret;
      }

      switch (aliasToCmd(val)) {
        case 'privilege': {
          const val2 = cmdArgs.getArgN(2);
          switch (aliasToCmd(val2)) {
            case 'session': {
              const val3 = cmdArgs.getArgN(3);
              switch (aliasToCmd(val3)) {
                case 'set': {
                  const val4 = cmdArgs.getArgN(4);
                  if (!val4 || val4 == 'help') {
                    seal.replyToSender(ctx, msg, `帮助:
【.ai priv ses st <ID> <会话权限>】修改会话权限
${HELPMAP["ID"]}
${HELPMAP["会话权限"]}`);
                    return ret;
                  }

                  const val5 = cmdArgs.getArgN(5);
                  const limit = parseInt(val5);
                  if (isNaN(limit)) {
                    seal.replyToSender(ctx, msg, '权限值必须为数字');
                    return ret;
                  }

                  const id2 = val4 === 'now' ? id : val4;
                  const ai2 = AIManager.getAI(id2);

                  ai2.setting.priv = limit;

                  seal.replyToSender(ctx, msg, '权限修改完成');
                  AIManager.saveAI(id2);
                  return ret;
                }
                case 'check': {
                  const val4 = cmdArgs.getArgN(4);
                  if (!val4 || val4 == 'help') {
                    seal.replyToSender(ctx, msg, `帮助:
【.ai priv ses ck <ID>】检查会话权限
${HELPMAP["ID"]}`);
                    return ret;
                  }

                  const id2 = val4 === 'now' ? id : val4;
                  const ai2 = AIManager.getAI(id2);
                  seal.replyToSender(ctx, msg, `${id2}\n会话权限:${ai2.setting.priv}`);
                  return ret;
                }
                default: {
                  seal.replyToSender(ctx, msg, `帮助:
【.ai priv ses st <ID> <会话权限>】修改会话权限
【.ai priv ses ck <ID>】检查会话权限
${HELPMAP["ID"]}
${HELPMAP["会话权限"]}`);
                  return ret;
                }
              }
            }
            case 'set': {
              const val3 = cmdArgs.getArgN(3);
              if (!val3 || val3 == 'help') {
                seal.replyToSender(ctx, msg, `帮助:
【.ai priv st <指令> <权限限制>】修改指令权限
${HELPMAP["指令"]}
${HELPMAP["权限限制"]}`);
                return ret;
              }
              const cmdChain = val3.split('-').map(cmd => aliasToCmd(cmd));
              if (cmdChain?.[1] === 'privilege') {
                seal.replyToSender(ctx, msg, `你不能修改priv指令的权限`);
                return ret;
              }
              const cpi = PrivilegeManager.getCmdPrivInfo(cmdChain);
              if (!cpi) {
                seal.replyToSender(ctx, msg, `指令${val3}不存在`);
                return ret;
              }
              const val4 = cmdArgs.getArgN(4);
              const priv = val4.split('-').map(p => parseInt(p));
              if (priv.length !== 3) {
                seal.replyToSender(ctx, msg, '权限值必须为3个数字');
                return ret;
              }
              for (const p of priv) {
                if (isNaN(p)) {
                  seal.replyToSender(ctx, msg, '权限值必须为数字');
                  return ret;
                }
              }
              cpi.priv = priv as [number, number, number];
              PrivilegeManager.saveCmdPriv();
              seal.replyToSender(ctx, msg, '权限修改完成');
              return ret;
            }
            case 'show': {
              const val3 = cmdArgs.getArgN(3);
              if (!val3 || val3 == 'help') {
                seal.replyToSender(ctx, msg, `帮助:
【.ai priv show <指令>】检查指令权限
${HELPMAP["指令"]}`);
                return ret;
              }
              const cmdChain = val3.split('-');
              const cpi = PrivilegeManager.getCmdPrivInfo(cmdChain);
              if (!cpi) {
                seal.replyToSender(ctx, msg, `指令${val3}不存在`);
                return ret;
              }
              seal.replyToSender(ctx, msg, `指令${val3}权限限制:${cpi.priv.join('-')}`);
              return ret;
            }
            case 'reset': {
              PrivilegeManager.resetCmdPriv();
              seal.replyToSender(ctx, msg, '指令权限重置完成');
              return ret;
            }
            default: {
              seal.replyToSender(ctx, msg, `帮助:
【.ai priv ses st <ID> <会话权限>】修改会话权限
【.ai priv ses ck <ID>】检查会话权限
【.ai priv st <指令> <权限限制>】修改指令权限
【.ai priv show <指令>】检查指令权限
【.ai priv reset】重置指令权限
${HELPMAP["ID"]}
${HELPMAP["会话权限"]}
${HELPMAP["指令"]}
${HELPMAP["权限限制"]}`);
              return ret;
            }
          }
        }
        case 'prompt': {
          const systemMessage = buildSystemMessage(ctx, ai);
          logger.info(`system prompt:\n`, systemMessage.msgArray[0].content);
          seal.replyToSender(ctx, msg, systemMessage.msgArray[0].content);
          return ret;
        }
        case 'status': {
          const setting = ai.setting;
          const { start, end, segs } = setting.activeTimeInfo;

          seal.replyToSender(ctx, msg, `${id}
权限: ${setting.priv}
上下文轮数: ${ai.context.messages.filter(m => m.role === 'user').length}
计数器模式(c): ${setting.counter > -1 ? `${setting.counter}条` : '关闭'}
计时器模式(t): ${setting.timer > -1 ? `${setting.timer}秒` : '关闭'}
概率模式(p): ${setting.prob > -1 ? `${setting.prob}%` : '关闭'}
活跃时间段: ${(start !== 0 || end !== 0) ? `${Math.floor(start / 60).toString().padStart(2, '0')}:${(start % 60).toString().padStart(2, '0')}至${Math.floor(end / 60).toString().padStart(2, '0')}:${(end % 60).toString().padStart(2, '0')}` : '未设置'}
活跃次数: ${segs > 0 ? segs : '未设置'}
待机模式: ${setting.standby ? '开启' : '关闭'}`);
          return ret;
        }
        case 'ctxn': {
          const names = ai.context.getNames();
          const s = `上下文里的名字有：\n<${names.join('>\n<')}>`;
          seal.replyToSender(ctx, msg, s);
          return ret;
        }
        case 'timer': {
          const val2 = cmdArgs.getArgN(2);
          switch (aliasToCmd(val2)) {
            case 'list': {
              const timers = TimerManager.getTimers(id, '', []);

              if (timers.length === 0) {
                seal.replyToSender(ctx, msg, '当前对话没有定时器');
                return ret;
              }

              const s = timers.map((t, i) => {
                switch (t.type) {
                  case 'target': {
                    return `${i + 1}. 定时器设定时间：${fmtDate(t.set)}
类型:${t.type}
目标时间：${fmtDate(t.target)}
内容：${t.content}`;
                  }
                  case 'interval': {
                    return `${i + 1}. 定时器设定时间：${fmtDate(t.set)}
类型:${t.type}
间隔时间：${t.interval}秒
剩余触发次数：${t.count === -1 ? '无限' : t.count - 1}
内容：${t.content}`;
                  }
                  case 'activeTime': {
                    return `${i + 1}. 定时器设定时间：${fmtDate(t.set)}
类型:${t.type}
目标时间：${fmtDate(t.target)}`;
                  }
                }
              }).join('\n');
              seal.replyToSender(ctx, msg, s);
              return ret;
            }
            case 'clear': {
              TimerManager.removeTimers(id, '', [], []);
              seal.replyToSender(ctx, msg, '所有定时器已清除');
              return ret;
            }
            default: {
              seal.replyToSender(ctx, msg, `帮助:
【.ai timer lst】查看当前聊天定时器
【.ai timer clr】清除当前聊天定时器`);
              return ret;
            }
          }
        }
        case 'on': {
          const setting = ai.setting;

          const kwargs = cmdArgs.kwargs;
          if (kwargs.length == 0) {
            seal.replyToSender(ctx, msg, `帮助:
【.ai on --<参数>=<数字>】

<参数>:
【c】计数器模式，接收消息数达到后触发
单位/条，默认10条
【t】计时器模式，最后一条消息后达到时限触发
单位/秒，默认60秒
【p】概率模式，每条消息按概率触发
单位/%，默认10%
【a】活跃时间段和活跃次数
格式为"开始时间-结束时间-活跃次数"(如"09:00-18:00-5")

【.ai on --t --p=42】使用示例`);
            return ret;
          }

          let text = `AI已开启：`;
          for (const kwarg of kwargs) {
            const name = kwarg.name;
            const exist = kwarg.valueExists;
            const valInt = parseInt(kwarg.value);
            const valFloat = parseFloat(kwarg.value);
            const valStr = kwarg.value.trim();

            switch (name) {
              case 'c':
              case 'counter': {
                ai.context.counter = 0;
                setting.counter = exist && !isNaN(valInt) ? valInt : 10;
                text += `\n计数器模式:${setting.counter}条`;
                break;
              }
              case 't':
              case 'timer': {
                clearTimeout(ai.context.timer);
                ai.context.timer = null;
                setting.timer = exist && !isNaN(valFloat) ? valFloat : 60;
                text += `\n计时器模式:${setting.timer}秒`;
                break;
              }
              case 'p':
              case 'prob': {
                setting.prob = exist && !isNaN(valFloat) ? valFloat : 10;
                text += `\n概率模式:${setting.prob}%`;
                break;
              }
              case 'a':
              case 'active': {
                if (!exist) {
                  seal.replyToSender(ctx, msg, '请输入活跃时间段');
                  return ret;
                }

                const arr = valStr.split('-').map((item, index) => {
                  const parts = item.split(/[:：,，]+/).map(Number).map(i => isNaN(i) ? 0 : i);
                  if (index < 2) {
                    return Math.ceil((parts[0] * 60 + (parts[1] || 0)) % (24 * 60));
                  } else {
                    return parts[0];
                  }
                })

                const [start = 0, end = 0, segs = 1] = arr;

                if (start === end) {
                  seal.replyToSender(ctx, msg, '活跃时间段开始时间和结束时间不能相同');
                  return ret;
                }

                if (!Number.isInteger(segs)) {
                  seal.replyToSender(ctx, msg, '活跃次数必须为整数');
                  return ret;
                }

                const endReal = end >= start ? end : end + 24 * 60;
                if (segs > endReal - start) {
                  seal.replyToSender(ctx, msg, '活跃次数不能大于活跃时间段分钟数');
                  return ret;
                }

                TimerManager.removeTimers(id, '', ['activeTime'], []);
                setting.activeTimeInfo = {
                  start,
                  end,
                  segs,
                }

                text += `\n活跃时间段:${Math.floor(start / 60).toString().padStart(2, '0')}:${(start % 60).toString().padStart(2, '0')}至${Math.floor(end / 60).toString().padStart(2, '0')}:${(end % 60).toString().padStart(2, '0')}`;
                text += `\n活跃次数:${segs}`;

                const curSegIndex = ai.getCurSegIndex();
                const nextTimePoint = ai.getNextTimePoint(curSegIndex);
                if (nextTimePoint !== -1) {
                  TimerManager.addActiveTimeTimer(ctx, msg, ai, nextTimePoint);
                }
                break;
              }
            }
          };

          setting.standby = true;

          seal.replyToSender(ctx, msg, text);
          AIManager.saveAI(id);
          return ret;
        }
        case 'standby': {
          const setting = ai.setting;

          ai.resetState();
          TimerManager.removeTimers(id, '', ['activeTime'], []);

          setting.counter = -1;
          setting.timer = -1;
          setting.prob = -1;
          setting.standby = true;
          setting.activeTimeInfo = {
            start: 0,
            end: 0,
            segs: 0,
          }

          seal.replyToSender(ctx, msg, 'AI已开启待机模式');
          AIManager.saveAI(id);
          return ret;
        }
        case 'off': {
          const setting = ai.setting;

          const kwargs = cmdArgs.kwargs;
          if (kwargs.length == 0) {
            ai.resetState();
            TimerManager.removeTimers(id, '', ['activeTime'], []);

            setting.counter = -1;
            setting.timer = -1;
            setting.prob = -1;
            setting.standby = false;
            setting.activeTimeInfo = {
              start: 0,
              end: 0,
              segs: 0,
            }

            seal.replyToSender(ctx, msg, 'AI已关闭');
            AIManager.saveAI(id);
            return ret;
          }

          let text = `AI已关闭：`;
          kwargs.forEach(kwarg => {
            const name = kwarg.name;

            switch (name) {
              case 'c':
              case 'counter': {
                ai.context.counter = 0;
                setting.counter = -1;
                text += `\n计数器模式`;
                break;
              }
              case 't':
              case 'timer': {
                clearTimeout(ai.context.timer);
                ai.context.timer = null;
                setting.timer = -1;
                text += `\n计时器模式`;
                break;
              }
              case 'p':
              case 'prob': {
                setting.prob = -1;
                text += `\n概率模式`;
                break;
              }
              case 'a':
              case 'active': {
                TimerManager.removeTimers(id, '', ['activeTime'], []);
                setting.activeTimeInfo = {
                  start: 0,
                  end: 0,
                  segs: 0,
                }
                text += `\n活跃时间段`;
                break;
              }
            }
          });

          seal.replyToSender(ctx, msg, text);
          AIManager.saveAI(id);
          return ret;
        }
        case 'forget': {
          ai.resetState();

          const val2 = cmdArgs.getArgN(2);
          switch (aliasToCmd(val2)) {
            case 'assistant': {
              ai.context.clearMessages('assistant', 'tool');
              seal.replyToSender(ctx, msg, 'ai上下文已清除');
              AIManager.saveAI(id);
              return ret;
            }
            case 'user': {
              ai.context.clearMessages('user');
              seal.replyToSender(ctx, msg, '用户上下文已清除');
              AIManager.saveAI(id);
              return ret;
            }
            default: {
              ai.context.clearMessages();
              seal.replyToSender(ctx, msg, '上下文已清除');
              AIManager.saveAI(id);
              return ret;
            }
          }
        }
        case 'role': {
          const { roleSettingNames, roleSettingTemplate } = ConfigManager.message;

          const val2 = cmdArgs.getArgN(2);
          switch (aliasToCmd(val2)) {
            case 'show': {
              let name = roleSettingNames[0];;
              const [roleName, exists] = seal.vars.strGet(ctx, "$gSYSPROMPT");
              if (exists && roleName !== '' && roleSettingNames.includes(roleName)) {
                const roleIndex = roleSettingNames.indexOf(roleName);
                if (roleIndex >= 0 && roleIndex < roleSettingTemplate.length) {
                  name = roleName;
                }
              } else {
                const [roleIndex2, exists2] = seal.vars.intGet(ctx, "$gSYSPROMPT");
                if (exists2 && roleIndex2 >= 0 && roleIndex2 < roleSettingTemplate.length) {
                  name = String(roleIndex2);
                }
              }
              seal.replyToSender(ctx, msg, `当前角色设定名称为[${name}]，名称有:\n${roleSettingNames.join('、')}`);
              return ret;
            }
            default: {
              if (!roleSettingNames.includes(val2)) {
                seal.replyToSender(ctx, msg, `【.ai role <名称>】切换角色设定\n角色设定名称错误，名称有:\n${roleSettingNames.join('、')}`);
                return ret;
              }
              const roleSettingIndex = roleSettingNames.indexOf(val2);
              if (roleSettingIndex < 0 || roleSettingIndex >= roleSettingTemplate.length) {
                seal.replyToSender(ctx, msg, `角色设定名称[${val2}]没有对应的角色设定`);
              }
              seal.vars.strSet(ctx, "$gSYSPROMPT", val2);
              seal.replyToSender(ctx, msg, `角色设定已切换到[${val2}]`);
              return ret;
            }
          }
        }
        case 'memory': {
          const mctx = seal.getCtxProxyFirst(ctx, cmdArgs);
          const muid = mctx.player.userId;

          const ai2 = AIManager.getAI(muid);
          const val2 = cmdArgs.getArgN(2);
          switch (aliasToCmd(val2)) {
            case 'status': {
              let ai3 = ai;
              if (cmdArgs.at.length > 0 && (cmdArgs.at.length !== 1 || cmdArgs.at[0].userId !== ctx.endPoint.userId)) {
                ai3 = ai2;
              }

              const { isMemory, isShortMemory } = ConfigManager.memory;

              const keywords = new Set<string>();
              for (const key in ai3.memory.memoryMap) {
                ai3.memory.memoryMap[key].keywords.forEach(kw => keywords.add(kw));
              }

              seal.replyToSender(ctx, msg, `${ai3.id}
长期记忆开启状态: ${isMemory ? '是' : '否'}
长期记忆条数: ${Object.keys(ai3.memory.memoryMap).length}
关键词库: ${Array.from(keywords).join('、') || '无'}
短期记忆开启状态: ${(isShortMemory && ai3.memory.useShortMemory) ? '是' : '否'}
短期记忆条数: ${ai3.memory.shortMemoryList.length}`);
              return ret;
            }
            case 'private': {
              const val3 = cmdArgs.getArgN(3);
              switch (aliasToCmd(val3)) {
                case 'set': {
                  const s = cmdArgs.getRestArgsFrom(4);
                  switch (aliasToCmd(s)) {
                    case '': {
                      seal.replyToSender(ctx, msg, '参数缺失，【.ai memo p st <内容>】设置个人设定，【.ai memo p st clr】清除个人设定');
                      return ret;
                    }
                    case 'clear': {
                      ai2.memory.persona = '无';
                      seal.replyToSender(ctx, msg, '设定已清除');
                      AIManager.saveAI(muid);
                      return ret;
                    }
                    default: {
                      if (s.length > 20) {
                        seal.replyToSender(ctx, msg, '设定过长，请控制在20字以内');
                        return ret;
                      }
                      ai2.memory.persona = s;
                      seal.replyToSender(ctx, msg, '设定已修改');
                      AIManager.saveAI(muid);
                      return ret;
                    }
                  }
                }
                case 'delete': {
                  const idList = cmdArgs.args.slice(3);
                  const kw = cmdArgs.kwargs.map(item => item.name);
                  if (idList.length === 0 && kw.length === 0) {
                    seal.replyToSender(ctx, msg, '参数缺失，【.ai memo p del <ID1> <ID2> --关键词1 --关键词2】删除个人记忆');
                    return ret;
                  }
                  ai2.memory.delMemory(idList, kw);
                  const s = ai2.memory.buildMemory(true, mctx.player.name, mctx.player.userId, '', '');
                  seal.replyToSender(ctx, msg, s || '无');
                  AIManager.saveAI(muid);
                  return ret;
                }
                case 'show': {
                  const s = ai2.memory.buildMemory(true, mctx.player.name, mctx.player.userId, '', '');
                  seal.replyToSender(ctx, msg, s || '无');
                  return ret;
                }
                case 'clear': {
                  ai2.memory.clearMemory();
                  seal.replyToSender(ctx, msg, '个人记忆已清除');
                  AIManager.saveAI(muid);
                  return ret;
                }
                default: {
                  seal.replyToSender(ctx, msg, `参数缺失:
【.ai memo p st <内容>】设置个人设定
【.ai memo p st clr】清除个人设定
【.ai memo p del <ID1> <ID2> --关键词1 --关键词2】删除个人记忆
【.ai memo p show】展示个人记忆
【.ai memo p clr】清除个人记忆`);
                  return ret;
                }
              }
            }
            case 'group': {
              if (ctx.isPrivate) {
                seal.replyToSender(ctx, msg, '群聊记忆仅在群聊可用');
                return ret;
              }

              const val3 = cmdArgs.getArgN(3);
              switch (aliasToCmd(val3)) {
                case 'set': {
                  const s = cmdArgs.getRestArgsFrom(4);
                  switch (aliasToCmd(s)) {
                    case '': {
                      seal.replyToSender(ctx, msg, '参数缺失，【.ai memo g st <内容>】设置群聊设定，【.ai memo g st clr】清除群聊设定');
                      return ret;
                    }
                    case 'clear': {
                      ai.memory.persona = '无';
                      seal.replyToSender(ctx, msg, '设定已清除');
                      AIManager.saveAI(id);
                      return ret;
                    }
                    default: {
                      if (s.length > 30) {
                        seal.replyToSender(ctx, msg, '设定过长，请控制在30字以内');
                        return ret;
                      }
                      ai.memory.persona = s;
                      seal.replyToSender(ctx, msg, '设定已修改');
                      AIManager.saveAI(id);
                      return ret;
                    }
                  }
                }
                case 'delete': {
                  const idList = cmdArgs.args.slice(3);
                  const kw = cmdArgs.kwargs.map(item => item.name);
                  if (idList.length === 0 && kw.length === 0) {
                    seal.replyToSender(ctx, msg, '参数缺失，【.ai memo g del <ID1> <ID2>】删除群聊记忆');
                    return ret;
                  }
                  ai.memory.delMemory(idList, kw);
                  const s = ai.memory.buildMemory(false, '', '', ctx.group.groupName, ctx.group.groupId);
                  seal.replyToSender(ctx, msg, s || '无');
                  AIManager.saveAI(id);
                  return ret;
                }
                case 'show': {
                  const s = ai.memory.buildMemory(false, '', '', ctx.group.groupName, ctx.group.groupId);
                  seal.replyToSender(ctx, msg, s || '无');
                  return ret;
                }
                case 'clear': {
                  ai.memory.clearMemory();
                  seal.replyToSender(ctx, msg, '群聊记忆已清除');
                  AIManager.saveAI(id);
                  return ret;
                }
                default: {
                  seal.replyToSender(ctx, msg, `参数缺失:
【.ai memo g st <内容>】设置群聊设定
【.ai memo g st clr】清除群聊设定
【.ai memo g del <ID1> <ID2> --关键词1 --关键词2】删除群聊记忆
【.ai memo g show】展示群聊记忆
【.ai memo g clr】清除群聊记忆`);
                  return ret;
                }
              }
            }
            case 'short': {
              const val3 = cmdArgs.getArgN(3);
              switch (aliasToCmd(val3)) {
                case 'on': {
                  ai.memory.useShortMemory = true;
                  seal.replyToSender(ctx, msg, '短期记忆已开启');
                  AIManager.saveAI(id);
                  return ret;
                }
                case 'off': {
                  ai.memory.useShortMemory = false;
                  seal.replyToSender(ctx, msg, '短期记忆已关闭');
                  AIManager.saveAI(id);
                  return ret;
                }
                case 'show': {
                  const s = ai.memory.shortMemoryList.map((item, index) => `${index + 1}. ${item}`).join('\n');
                  seal.replyToSender(ctx, msg, s || '无');
                  return ret;
                }
                case 'clear': {
                  ai.memory.clearShortMemory();
                  seal.replyToSender(ctx, msg, '短期记忆已清除');
                  AIManager.saveAI(id);
                  return ret;
                }
                default: {
                  seal.replyToSender(ctx, msg, `参数缺失
【.ai memo short show】展示短期记忆
【.ai memo short clr】清除短期记忆
【.ai memo short [on/off]】开启/关闭短期记忆`);
                  return ret;
                }
              }
            }
            case 'sum': {
              ai.context.summaryCounter = 0;
              ai.memory.updateShortMemory(ctx, msg, ai)
                .then(() => {
                  const s = ai.memory.shortMemoryList.map((item, index) => `${index + 1}. ${item}`).join('\n');
                  seal.replyToSender(ctx, msg, s || '无');
                });
              return ret;
            }
            default: {
              seal.replyToSender(ctx, msg, `帮助:
【.ai memo status (@xxx)】查看记忆状态，@为查看个人记忆状态
【.ai memo [p/g] st <内容>】设置个人/群聊设定
【.ai memo [p/g] st clr】清除个人/群聊设定
【.ai memo [p/g] del <ID1> <ID2> --关键词1 --关键词2】删除个人/群聊记忆
【.ai memo [p/g/short] show】展示个人/群聊/短期记忆
【.ai memo [p/g/short] clr】清除个人/群聊/短期记忆
【.ai memo short [on/off]】开启/关闭短期记忆
【.ai memo sum】立即总结一次短期记忆`);
              return ret;
            }
          }
        }
        case 'tool': {
          const val2 = cmdArgs.getArgN(2);
          switch (aliasToCmd(val2)) {
            case 'on': {
              const val3 = cmdArgs.getArgN(3);
              if (val3) {
                const toolsNotAllow = ConfigManager.tool.toolsNotAllow;
                if (toolsNotAllow.includes(val3)) {
                  seal.replyToSender(ctx, msg, `工具函数 ${val3} 不被允许开启`);
                  return ret;
                }

                ai.tool.toolStatus[val3] = true;
                seal.replyToSender(ctx, msg, `已开启工具函数 ${val3}`);
                AIManager.saveAI(id);
                return ret;
              }
              const toolsNotAllow = ConfigManager.tool.toolsNotAllow;
              for (const key in ai.tool.toolStatus) {
                ai.tool.toolStatus[key] = toolsNotAllow.includes(key) ? false : true;
              }
              seal.replyToSender(ctx, msg, '已开启全部工具函数');
              AIManager.saveAI(id);
              return ret;
            }
            case 'off': {
              const val3 = cmdArgs.getArgN(3);
              if (val3) {
                ai.tool.toolStatus[val3] = false;
                seal.replyToSender(ctx, msg, `已关闭工具函数 ${val3}`);
                AIManager.saveAI(id);
                return ret;
              }
              for (const key in ai.tool.toolStatus) {
                ai.tool.toolStatus[key] = false;
              }
              seal.replyToSender(ctx, msg, '已关闭全部工具函数');
              AIManager.saveAI(id);
              return ret;
            }
            case 'help': {
              const val3 = cmdArgs.getArgN(3);
              if (!val3) {
                seal.replyToSender(ctx, msg, `帮助:
【.ai tool】列出所有工具
【.ai tool [on/off] <函数名>】开启或关闭工具函数
【.ai tool help <函数名>】查看工具详情
【.ai tool call <函数名> --参数名=具体参数】试用工具函数`);
                return ret;
              }

              if (!ToolManager.toolMap.hasOwnProperty(val3)) {
                seal.replyToSender(ctx, msg, '没有这个工具函数');
                return ret;
              }

              const tool = ToolManager.toolMap[val3];
              const s = `${tool.info.function.name}
描述:${tool.info.function.description}

参数信息:
${JSON.stringify(tool.info.function.parameters.properties, null, 2)}

必需参数:${tool.info.function.parameters.required.join(',')}`;

              seal.replyToSender(ctx, msg, s);
              return ret;
            }
            case 'call': {
              if (ToolManager.cmdArgs == null) {
                seal.replyToSender(ctx, msg, `暂时无法调用函数，请先使用 .r 指令`);
                return ret;
              }

              const val3 = cmdArgs.getArgN(3);
              if (!val3) {
                seal.replyToSender(ctx, msg, `调用函数缺少工具函数名`);
                return ret;
              }
              const tool = ToolManager.toolMap[val3];

              try {
                const args = cmdArgs.kwargs.reduce((acc, kwarg) => {
                  const valueString = kwarg.value;
                  try {
                    acc[kwarg.name] = JSON.parse(`[${valueString}]`)[0];
                  } catch (e) {
                    acc[kwarg.name] = valueString;
                  }
                  return acc;
                }, {});

                for (const key of tool.info.function.parameters.required) {
                  if (!args.hasOwnProperty(key)) {
                    logger.warning(`调用函数失败:缺少必需参数 ${key}`);
                    seal.replyToSender(ctx, msg, `调用函数失败:缺少必需参数 ${key}`);
                    return ret;
                  }
                }

                tool.solve(ctx, msg, ai, args)
                  .then(({ content, images }) => seal.replyToSender(ctx, msg, `返回内容:
${content}
返回图片:
${images.map(img => ImageManager.getImageCQCode(img)).join('\n')}`));
                return ret;
              } catch (e) {
                const s = `调用函数 (${val3}) 失败:${e.message}`;
                seal.replyToSender(ctx, msg, s);
                return ret;
              }
            }
            default: {
              const toolStatus = ai.tool.toolStatus;

              let i = 1;
              let s = '工具函数如下:';
              Object.keys(toolStatus).forEach(key => {
                const status = toolStatus[key] ? '开' : '关';
                s += `\n${i++}. ${key}[${status}]`;
              });

              seal.replyToSender(ctx, msg, s);
              return ret;
            }
          }
        }
        case 'ignore': {
          if (ctx.isPrivate) {
            seal.replyToSender(ctx, msg, '忽略名单仅在群聊可用');
            return ret;
          }

          const epId = ctx.endPoint.userId;
          const mctx = seal.getCtxProxyFirst(ctx, cmdArgs);
          const muid = cmdArgs.amIBeMentionedFirst ? epId : mctx.player.userId;

          const val2 = cmdArgs.getArgN(2);
          switch (aliasToCmd(val2)) {
            case 'add': {
              if (cmdArgs.at.length === 0) {
                seal.replyToSender(ctx, msg, '参数缺失，【.ai ign add @xxx】添加忽略名单');
                return ret;
              }
              if (ai.context.ignoreList.includes(muid)) {
                seal.replyToSender(ctx, msg, '已经在忽略名单中');
                return ret;
              }
              ai.context.ignoreList.push(muid);
              seal.replyToSender(ctx, msg, '已添加到忽略名单');
              AIManager.saveAI(id);
              return ret;
            }
            case 'remove': {
              if (cmdArgs.at.length === 0) {
                seal.replyToSender(ctx, msg, '参数缺失，【.ai ign rm @xxx】移除忽略名单');
                return ret;
              }
              if (!ai.context.ignoreList.includes(muid)) {
                seal.replyToSender(ctx, msg, '不在忽略名单中');
                return ret;
              }
              ai.context.ignoreList = ai.context.ignoreList.filter(item => item !== muid);
              seal.replyToSender(ctx, msg, '已从忽略名单中移除');
              AIManager.saveAI(id);
              return ret;
            }
            case 'list': {
              const s = ai.context.ignoreList.length === 0 ? '忽略名单为空' : `忽略名单如下:\n${ai.context.ignoreList.join('\n')}`;
              seal.replyToSender(ctx, msg, s);
              return ret;
            }
            default: {
              seal.replyToSender(ctx, msg, `帮助:
【.ai ign add @xxx】添加忽略名单
【.ai ign rm @xxx】移除忽略名单
【.ai ign lst】列出忽略名单

忽略名单中的对象仍能正常对话，但无法被选中QQ号`);
              return ret;
            }
          }
        }
        case 'token': {
          const val2 = cmdArgs.getArgN(2);
          switch (aliasToCmd(val2)) {
            case 'list': {
              const s = Object.keys(AIManager.usageMap).join('\n');
              seal.replyToSender(ctx, msg, `有使用记录的模型:\n${s}`);
              return ret;
            }
            case 'sum': {
              const usage = {
                prompt_tokens: 0,
                completion_tokens: 0
              };

              for (const model in AIManager.usageMap) {
                const modelUsage = AIManager.getModelUsage(model);
                usage.prompt_tokens += modelUsage.prompt_tokens;
                usage.completion_tokens += modelUsage.completion_tokens;
              }

              if (usage.prompt_tokens === 0 && usage.completion_tokens === 0) {
                seal.replyToSender(ctx, msg, `没有使用记录`);
                return ret;
              }

              const s = `输入token:${usage.prompt_tokens}
输出token:${usage.completion_tokens}
总token:${usage.prompt_tokens + usage.completion_tokens}`;
              seal.replyToSender(ctx, msg, s);
              return ret;
            }
            case 'all': {
              const s = Object.keys(AIManager.usageMap).map((model, index) => {
                const usage = AIManager.getModelUsage(model);

                if (usage.prompt_tokens === 0 && usage.completion_tokens === 0) {
                  return `${index + 1}. ${model}: 没有使用记录`;
                }

                return `${index + 1}. ${model}:
  输入token:${usage.prompt_tokens}
  输出token:${usage.completion_tokens}
  总token:${usage.prompt_tokens + usage.completion_tokens}`;
              }).join('\n');

              if (!s) {
                seal.replyToSender(ctx, msg, `没有使用记录`);
                return ret;
              }

              seal.replyToSender(ctx, msg, `全部使用记录如下:\n${s}`);
              return ret;
            }
            case 'year': {
              const obj: {
                [key: string]: {
                  prompt_tokens: number;
                  completion_tokens: number;
                }
              } = {};
              const now = new Date();
              const currentYear = now.getFullYear();
              const currentMonth = now.getMonth() + 1;
              const currentYM = currentYear * 12 + currentMonth;
              for (const model in AIManager.usageMap) {
                const modelUsage = AIManager.usageMap[model];
                for (const key in modelUsage) {
                  const usage = modelUsage[key];
                  const [year, month, _] = key.split('-').map(v => parseInt(v));
                  const ym = year * 12 + month;

                  if (ym >= currentYM - 11 && ym <= currentYM) {
                    const key = `${year}-${month}`;
                    if (!obj.hasOwnProperty(key)) {
                      obj[key] = {
                        prompt_tokens: 0,
                        completion_tokens: 0
                      };
                    }

                    obj[key].prompt_tokens += usage.prompt_tokens;
                    obj[key].completion_tokens += usage.completion_tokens;
                  }
                }
              }

              const val3 = cmdArgs.getArgN(3);
              if (val3 === 'chart') {
                get_chart_url('year', obj)
                  .then(url => seal.replyToSender(ctx, msg, url ? `[CQ:image,file=${url}]` : '图表生成失败'));
                return ret;
              }

              const keys = Object.keys(obj).sort((a, b) => {
                const [yearA, monthA] = a.split('-').map(v => parseInt(v));
                const [yearB, monthB] = b.split('-').map(v => parseInt(v));
                return (yearA * 12 + monthA) - (yearB * 12 + monthB);
              });

              const s = keys.map(key => {
                const usage = obj[key];
                if (usage.prompt_tokens === 0 && usage.completion_tokens === 0) {
                  return ``;
                }

                return `${key}:
  输入token:${usage.prompt_tokens}
  输出token:${usage.completion_tokens}
  总token:${usage.prompt_tokens + usage.completion_tokens}`;
              }).join('\n');

              if (!s) {
                seal.replyToSender(ctx, msg, `没有使用记录`);
                return ret;
              }

              seal.replyToSender(ctx, msg, `最近12个月使用记录如下:\n${s}`);
              return ret;
            }
            case 'month': {
              const obj: {
                [key: string]: {
                  prompt_tokens: number;
                  completion_tokens: number;
                }
              } = {};
              const now = new Date();
              const currentYear = now.getFullYear();
              const currentMonth = now.getMonth() + 1;
              const currentDay = now.getDate();
              const currentYMD = currentYear * 12 * 31 + currentMonth * 31 + currentDay;
              for (const model in AIManager.usageMap) {
                const modelUsage = AIManager.usageMap[model];
                for (const key in modelUsage) {
                  const usage = modelUsage[key];
                  const [year, month, day] = key.split('-').map(v => parseInt(v));
                  const ymd = year * 12 * 31 + month * 31 + day;

                  if (ymd >= currentYMD - 30 && ymd <= currentYMD) {
                    const key = `${year}-${month}-${day}`;
                    if (!obj.hasOwnProperty(key)) {
                      obj[key] = {
                        prompt_tokens: 0,
                        completion_tokens: 0
                      };
                    }

                    obj[key].prompt_tokens += usage.prompt_tokens;
                    obj[key].completion_tokens += usage.completion_tokens;
                  }
                }
              }

              const val3 = cmdArgs.getArgN(3);
              if (val3 === 'chart') {
                get_chart_url('month', obj)
                  .then(url => seal.replyToSender(ctx, msg, url ? `[CQ:image,file=${url}]` : '图表生成失败'));
                return ret;
              }

              const keys = Object.keys(obj).sort((a, b) => {
                const [yearA, monthA, dayA] = a.split('-').map(v => parseInt(v));
                const [yearB, monthB, dayB] = b.split('-').map(v => parseInt(v));
                return (yearA * 12 * 31 + monthA * 31 + dayA) - (yearB * 12 * 31 + monthB * 31 + dayB);
              });

              const s = keys.map(key => {
                const usage = obj[key];
                if (usage.prompt_tokens === 0 && usage.completion_tokens === 0) {
                  return ``;
                }

                return `${key}:
  输入token:${usage.prompt_tokens}
  输出token:${usage.completion_tokens}
  总token:${usage.prompt_tokens + usage.completion_tokens}`;
              }).join('\n');

              seal.replyToSender(ctx, msg, `最近31天使用记录如下:\n${s}`);
              return ret;
            }
            case 'clear': {
              const val3 = cmdArgs.getArgN(3);
              if (!val3) {
                AIManager.clearUsageMap();
                seal.replyToSender(ctx, msg, '已清除token使用记录');
                AIManager.saveUsageMap();
                return ret;
              }

              if (!AIManager.usageMap.hasOwnProperty(val3)) {
                seal.replyToSender(ctx, msg, '没有这个模型，请使用【.ai tk lst】查看所有模型');
                return ret;
              }

              delete AIManager.usageMap[val3];
              seal.replyToSender(ctx, msg, `已清除 ${val3} 的token使用记录`);
              AIManager.saveUsageMap();
              return ret;
            }
            case '':
            case 'help': {
              seal.replyToSender(ctx, msg, `帮助:
【.ai tk lst】查看所有模型
【.ai tk sum】查看所有模型的token使用记录总和
【.ai tk all】查看所有模型的token使用记录
【.ai tk [y/m] (chart)】查看所有模型今年/这个月的token使用记录
【.ai tk <模型名称>】查看模型的token使用记录
【.ai tk <模型名称> [y/m] (chart)】查看模型今年/这个月的token使用记录
【.ai tk clr】清除token使用记录
【.ai tk clr <模型名称>】清除token使用记录`);
              return ret;
            }
            default: {
              if (!AIManager.usageMap.hasOwnProperty(val2)) {
                seal.replyToSender(ctx, msg, '没有这个模型，请使用【.ai tk lst】查看所有模型');
                return ret;
              }

              const val3 = cmdArgs.getArgN(3);
              switch (aliasToCmd(val3)) {
                case 'year': {
                  const obj: {
                    [key: string]: {
                      prompt_tokens: number;
                      completion_tokens: number;
                    }
                  } = {};
                  const now = new Date();
                  const currentYear = now.getFullYear();
                  const currentMonth = now.getMonth() + 1;
                  const currentYM = currentYear * 12 + currentMonth;
                  const model = val2;

                  const modelUsage = AIManager.usageMap[model];
                  for (const key in modelUsage) {
                    const usage = modelUsage[key];
                    const [year, month, _] = key.split('-').map(v => parseInt(v));
                    const ym = year * 12 + month;

                    if (ym >= currentYM - 11 && ym <= currentYM) {
                      const key = `${year}-${month}`;
                      if (!obj.hasOwnProperty(key)) {
                        obj[key] = {
                          prompt_tokens: 0,
                          completion_tokens: 0
                        };
                      }

                      obj[key].prompt_tokens += usage.prompt_tokens;
                      obj[key].completion_tokens += usage.completion_tokens;
                    }
                  }

                  const val4 = cmdArgs.getArgN(4);
                  if (val4 === 'chart') {
                    get_chart_url('year', obj)
                      .then(url => seal.replyToSender(ctx, msg, url ? `[CQ:image,file=${url}]` : '图表生成失败'));
                    return ret;
                  }

                  const keys = Object.keys(obj).sort((a, b) => {
                    const [yearA, monthA] = a.split('-').map(v => parseInt(v));
                    const [yearB, monthB] = b.split('-').map(v => parseInt(v));
                    return (yearA * 12 + monthA) - (yearB * 12 + monthB);
                  });

                  const s = keys.map(key => {
                    const usage = obj[key];
                    if (usage.prompt_tokens === 0 && usage.completion_tokens === 0) {
                      return ``;
                    }

                    return `${key}:
      输入token:${usage.prompt_tokens}
      输出token:${usage.completion_tokens}
      总token:${usage.prompt_tokens + usage.completion_tokens}`;
                  }).join('\n');

                  if (!s) {
                    seal.replyToSender(ctx, msg, `没有使用记录`);
                    return ret;
                  }

                  seal.replyToSender(ctx, msg, `最近12个月使用记录如下:\n${s}`);
                  return ret;
                }
                case 'month': {
                  const obj: {
                    [key: string]: {
                      prompt_tokens: number;
                      completion_tokens: number;
                    }
                  } = {};
                  const now = new Date();
                  const currentYear = now.getFullYear();
                  const currentMonth = now.getMonth() + 1;
                  const currentDay = now.getDate();
                  const currentYMD = currentYear * 12 * 31 + currentMonth * 31 + currentDay;
                  const model = val2;

                  const modelUsage = AIManager.usageMap[model];
                  for (const key in modelUsage) {
                    const usage = modelUsage[key];
                    const [year, month, day] = key.split('-').map(v => parseInt(v));
                    const ymd = year * 12 * 31 + month * 31 + day;

                    if (ymd >= currentYMD - 30 && ymd <= currentYMD) {
                      const key = `${year}-${month}-${day}`;
                      if (!obj.hasOwnProperty(key)) {
                        obj[key] = {
                          prompt_tokens: 0,
                          completion_tokens: 0
                        };
                      }

                      obj[key].prompt_tokens += usage.prompt_tokens;
                      obj[key].completion_tokens += usage.completion_tokens;
                    }
                  }

                  const val4 = cmdArgs.getArgN(4);
                  if (val4 === 'chart') {
                    get_chart_url('month', obj)
                      .then(url => seal.replyToSender(ctx, msg, url ? `[CQ:image,file=${url}]` : '图表生成失败'));
                    return ret;
                  }

                  const keys = Object.keys(obj).sort((a, b) => {
                    const [yearA, monthA, dayA] = a.split('-').map(v => parseInt(v));
                    const [yearB, monthB, dayB] = b.split('-').map(v => parseInt(v));
                    return (yearA * 12 * 31 + monthA * 31 + dayA) - (yearB * 12 * 31 + monthB * 31 + dayB);
                  });

                  const s = keys.map(key => {
                    const usage = obj[key];
                    if (usage.prompt_tokens === 0 && usage.completion_tokens === 0) {
                      return ``;
                    }

                    return `${key}:
      输入token:${usage.prompt_tokens}
      输出token:${usage.completion_tokens}
      总token:${usage.prompt_tokens + usage.completion_tokens}`;
                  }).join('\n');

                  seal.replyToSender(ctx, msg, `最近31天使用记录如下:\n${s}`);
                  return ret;
                }
                default: {
                  const usage = AIManager.getModelUsage(val2);

                  if (usage.prompt_tokens === 0 && usage.completion_tokens === 0) {
                    seal.replyToSender(ctx, msg, `没有使用记录`);
                    return ret;
                  }

                  const s = `输入token:${usage.prompt_tokens}
输出token:${usage.completion_tokens}
总token:${usage.prompt_tokens + usage.completion_tokens}`;
                  seal.replyToSender(ctx, msg, s);
                  return ret;
                }
              }
            }
          }
        }
        case 'shut': {
          if (ai.stream.id === '') {
            seal.replyToSender(ctx, msg, '当前没有正在进行的对话');
            return ret;
          }

          ai.stopCurrentChatStream()
            .then(() => seal.replyToSender(ctx, msg, '已停止当前对话'));
          return ret;
        }
        default: {
          ret.showHelp = true;
          return ret;
        }
      }
    } catch (e) {
      logger.error(`指令.ai执行失败:${e.message}`);
      seal.replyToSender(ctx, msg, `指令.ai执行失败:${e.message}`);
      return seal.ext.newCmdExecuteResult(true);
    }
  }

  const cmdImage = seal.ext.newCmdItemInfo();
  cmdImage.name = 'img'; // 指令名字，可用中文
  cmdImage.help = `盗图指南:
【.img draw [stl/lcl/save/all]】随机抽取偷的图片/本地图片/保存的图片/全部
【.img stl [on/off]】偷图 开启/关闭
【.img f [stl/save/all]】遗忘偷的图片/保存的图片/全部
【.img itt [图片/ran] (附加提示词)】图片转文字
【.img save 名称 场景1,场景2,... 图片】保存图片
【.img save [show/clr]】展示保存的图片列表/展示并发送所有保存的图片
【.img save del <图片名称1> <图片名称2> ...】删除指定名称的保存图片`;
  cmdImage.solve = (ctx, msg, cmdArgs) => {
    try {
      const val = cmdArgs.getArgN(1);
      const uid = ctx.player.userId;
      const gid = ctx.group.groupId;
      const id = ctx.isPrivate ? uid : gid;

      const ret = seal.ext.newCmdExecuteResult(true);
      const ai = AIManager.getAI(id);
      const { success, exist } = PrivilegeManager.checkPriv(ctx, cmdArgs, ai);
      if (!success) {
        seal.replyToSender(ctx, msg, exist ? '权限不足' : '命令不存在');
        return ret;
      }

      switch (aliasToCmd(val)) {
        case 'draw': {
          const type = cmdArgs.getArgN(2);
          switch (aliasToCmd(type)) {
            case 'local': {
              const file = ai.imageManager.drawLocalImageFile();
              if (!file) {
                seal.replyToSender(ctx, msg, '暂无本地图片');
                return ret;
              }
              seal.replyToSender(ctx, msg, `[CQ:image,file=${file}]`);
              return ret;
            }
            case 'steal': {
              ai.imageManager.drawStolenImageFile()
                .then(file => seal.replyToSender(ctx, msg, file ? `[CQ:image,file=${file}]` : '暂无偷取图片'));
              return ret;
            }
            case 'save': {
              const file = ai.imageManager.drawSavedImageFile();
              if (!file) {
                seal.replyToSender(ctx, msg, '暂无保存的表情包图片');
              }
              seal.replyToSender(ctx, msg, `[CQ:image,file=${file}]`);
              return ret;
            }
            case 'all': {
              ai.imageManager.drawImageFile()
                .then(file => seal.replyToSender(ctx, msg, file ? `[CQ:image,file=${file}]` : '暂无图片'));
              return ret;
            }
            default: {
              ret.showHelp = true;
              return ret;
            }
          }
        }
        case 'steal': {
          const op = cmdArgs.getArgN(2);
          switch (aliasToCmd(op)) {
            case 'on': {
              ai.imageManager.stealStatus = true;
              seal.replyToSender(ctx, msg, `图片偷取已开启,当前偷取数量:${ai.imageManager.stolenImages.filter(img => img.isUrl).length}`);
              AIManager.saveAI(id);
              return ret;
            }
            case 'off': {
              ai.imageManager.stealStatus = false;
              seal.replyToSender(ctx, msg, `图片偷取已关闭,当前偷取数量:${ai.imageManager.stolenImages.filter(img => img.isUrl).length}`);
              AIManager.saveAI(id);
              return ret;
            }
            default: {
              seal.replyToSender(ctx, msg, `图片偷取状态:${ai.imageManager.stealStatus},当前偷取数量:${ai.imageManager.stolenImages.filter(img => img.isUrl).length}`);
              return ret;
            }
          }
        }
        case 'forget': {
          const type = cmdArgs.getArgN(2);
          switch (aliasToCmd(type)) {
            case 'steal': {
              ai.imageManager.stolenImages = [];
              seal.replyToSender(ctx, msg, '偷取图片已遗忘');
              AIManager.saveAI(id);
              return ret;
            }
            case 'save': {
              ai.imageManager.savedImages = [];
              seal.replyToSender(ctx, msg, '保存图片已遗忘');
              AIManager.saveAI(id);
              return ret;
            }
            case 'all': {
              ai.imageManager.stolenImages = [];
              ai.imageManager.savedImages = [];
              seal.replyToSender(ctx, msg, '所有图片已遗忘');
              AIManager.saveAI(id);
              return ret;
            }
            default: {
              ret.showHelp = true;
              return ret;
            }
          }
        }
        case 'itt': {
          const val2 = cmdArgs.getArgN(2);
          if (!val2) {
            seal.replyToSender(ctx, msg, '【.img itt [图片/ran] (附加提示词)】图片转文字');
            return ret;
          }

          switch (aliasToCmd(val2)) {
            case 'random': {
              ai.imageManager.drawStolenImageFile()
                .then(url => {
                  if (!url) {
                    seal.replyToSender(ctx, msg, '图片偷取为空');
                    return;
                  }
                  const text = cmdArgs.getRestArgsFrom(3);
                  ImageManager.imageToText(url, text)
                    .then(s => seal.replyToSender(ctx, msg, `[CQ:image,file=${url}]\n` + s));
                });
              return ret;
            }
            default: {
              const messageItem0 = transformTextToArray(val2)?.[0];
              const url = messageItem0?.data?.url || messageItem0?.data?.file;
              if (messageItem0?.type !== 'image' || !url) {
                seal.replyToSender(ctx, msg, '请附带图片');
                return ret;
              }
              const text = cmdArgs.getRestArgsFrom(3);
              ImageManager.imageToText(url, text)
                .then(s => seal.replyToSender(ctx, msg, `[CQ:image,file=${url}]\n` + s));
            }
              return ret;
          }
        }
        case 'save': {
          const val2 = cmdArgs.getArgN(2);
          switch (aliasToCmd(val2)) {
            case '': {
              seal.replyToSender(ctx, msg, '参数缺失，【.img save 名称 场景1,场景2,... 图片】保存图片，【.img save show】展示保存的图片，【.img save clr】清除所有保存的图片，【.img save del <图片名称1> <图片名称2> ...】删除指定名称的保存图片');
              return ret;
            }
            case 'show': {
              if (ai.imageManager.savedImages.length === 0) {
                seal.replyToSender(ctx, msg, '暂无保存的图片');
                return ret;
              }

              const imageList = ai.imageManager.savedImages.map((img, index) => `${index + 1}. 名称: ${img.id}
应用场景: ${img.scenes.join('、') || '无'}
权重: ${img.weight}
${ImageManager.getImageCQCode(img)}`).join('\n\n');

              seal.replyToSender(ctx, msg, `保存的图片列表:\n${imageList}`);
              return ret;
            }
            case 'clear': {
              ai.imageManager.clearSavedImages();
              seal.replyToSender(ctx, msg, '已清除所有保存的图片');
              AIManager.saveAI(id);
              return ret;
            }
            case 'delete': {
              const nameList = cmdArgs.args.slice(2);
              if (nameList.length === 0) {
                seal.replyToSender(ctx, msg, '参数缺失，【.img del <图片名称1> <图片名称2> ...】删除指定名称的保存图片');
                return ret;
              }

              ai.imageManager.delSavedImage(nameList);
              seal.replyToSender(ctx, msg, `已删除图片`);
              return ret;
            }
            default: {
              const name = val2;
              const scenes = cmdArgs.getArgN(3).split(/[，,]/);
              if (scenes.length === 0) {
                seal.replyToSender(ctx, msg, '参数缺失，【.img save 名称 场景1,场景2,... 图片】保存图片');
                return ret;
              }

              const val4 = cmdArgs.getArgN(4);
              const messageItem0 = transformTextToArray(val4)?.[0];
              const url = messageItem0?.data?.url || messageItem0?.data?.file;
              if (messageItem0?.type !== 'image' || !url) {
                seal.replyToSender(ctx, msg, '参数缺失，【.img save 名称 场景1,场景2,... 图片】保存图片');
                return ret;
              }

              ImageManager.imageUrlToBase64(url)
                .then((value) => {
                  if (!value.base64) {
                    throw new Error(`图片转换为base64失败`);
                  }

                  const image = new Image(url);
                  image.id = ImageManager.generateImageId(ai, name);
                  image.isUrl = false;
                  image.scenes = scenes;
                  image.base64 = value.base64;
                  return image;
                })
                .then((image) => {
                  ai.imageManager.saveImages([image]);
                  seal.replyToSender(ctx, msg, `已保存图片 ${image.id}`);
                })
                .catch((e) => {
                  seal.replyToSender(ctx, msg, `图片保存失败:${e.message}`);
                });
              return ret;
            }
          }
        }
        default: {
          ret.showHelp = true;
          return ret;
        }
      }
    } catch (e) {
      logger.error(`指令.img执行失败:${e.message}`);
      seal.replyToSender(ctx, msg, `指令.img执行失败:${e.message}`);
      return seal.ext.newCmdExecuteResult(true);
    }
  }

  // 将命令注册到扩展中
  ext.cmdMap['AI'] = cmdAI;
  ext.cmdMap['ai'] = cmdAI;
  ext.cmdMap['img'] = cmdImage;

  ext.onPoke = (ctx, event) => {
    const msg = createMsg(event.isPrivate ? 'private' : 'group', event.senderId, event.groupId);
    msg.message = `[CQ:poke,qq=${event.targetId.replace(/\D/g, '')}]`;
    if (event.senderId === ctx.endPoint.userId) {
      ext.onMessageSend(ctx, msg);
    } else {
      ext.onNotCommandReceived(ctx, msg);
    }
  }

  //接受非指令消息
  ext.onNotCommandReceived = (ctx, msg): void | Promise<void> => {
    try {
      const { disabledInPrivate, globalStandby, triggerRegexes, ignoreRegexes, triggerCondition } = ConfigManager.received;
      if (ctx.isPrivate && disabledInPrivate) {
        return;
      }

      const uid = ctx.player.userId;
      const gid = ctx.group.groupId;
      const id = ctx.isPrivate ? uid : gid;
      const ai = AIManager.getAI(id);

      // 检查活跃时间定时器
      ai.checkActiveTimer(ctx, msg);

      const message = msg.message;
      const messageArray = transformTextToArray(message);

      // 非指令消息忽略
      const ignoreRegex = ignoreRegexes.join('|');
      if (ignoreRegex) {
        let pattern: RegExp;
        try {
          pattern = new RegExp(ignoreRegex);
        } catch (e) {
          logger.error(`正则表达式错误，内容:${ignoreRegex}，错误信息:${e.message}`);
        }

        if (pattern && pattern.test(message)) {
          logger.info(`非指令消息忽略:${message}`);
          return;
        }
      }

      // 检查CQ码
      const CQTypes = messageArray.filter(item => item.type !== 'text').map(item => item.type);
      if (CQTypes.length === 0 || CQTypes.every(item => CQTYPESALLOW.includes(item))) {
        clearTimeout(ai.context.timer);
        ai.context.timer = null;

        // 非指令消息触发
        const triggerRegex = triggerRegexes.join('|');
        if (triggerRegex) {
          let pattern: RegExp;
          try {
            pattern = new RegExp(triggerRegex);
          } catch (e) {
            logger.error(`正则表达式错误，内容:${triggerRegex}，错误信息:${e.message}`);
          }

          if (pattern && pattern.test(message)) {
            const fmtCondition = parseInt(seal.format(ctx, `{${triggerCondition}}`));
            if (fmtCondition === 1) {
              return ai.handleReceipt(ctx, msg, ai, messageArray)
                .then(() => ai.chat(ctx, msg, '非指令'));
            }
          }
        }

        // AI自己设定的触发条件触发
        if (triggerConditionMap.hasOwnProperty(id) && triggerConditionMap[id].length !== 0) {
          for (let i = 0; i < triggerConditionMap[id].length; i++) {
            const condition = triggerConditionMap[id][i];
            if (condition.keyword && !new RegExp(condition.keyword).test(message)) {
              continue;
            }
            if (condition.uid && condition.uid !== uid) {
              continue;
            }

            return ai.handleReceipt(ctx, msg, ai, messageArray)
              .then(() => ai.context.addSystemUserMessage('触发原因提示', condition.reason, []))
              .then(() => triggerConditionMap[id].splice(i, 1))
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
        const id = ctx.isPrivate ? uid : gid;
        const ai = AIManager.getAI(id);

        // 检查活跃时间定时器
        ai.checkActiveTimer(ctx, msg);

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
      const id = ctx.isPrivate ? uid : gid;
      const ai = AIManager.getAI(id);

      // 检查活跃时间定时器
      ai.checkActiveTimer(ctx, msg);

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
