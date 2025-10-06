import { AIManager } from "./AI/AI";
import { ImageManager } from "./AI/image";
import { ToolManager } from "./tool/tool";
import { ConfigManager, CQTYPESALLOW } from "./config/config";
import { buildSystemMessage } from "./utils/utils_message";
import { triggerConditionMap } from "./tool/tool_trigger";
import { logger } from "./logger";
import { transformTextToArray } from "./utils/utils_string";
import { checkUpdate } from "./utils/utils_update";
import { get_chart_url } from "./service";
import { TimerManager } from "./timer";
import { registerEventHandlers } from "./events";

function main() {
  ConfigManager.registerConfig();
  checkUpdate();
  AIManager.getUsageMap();
  ToolManager.registerTool();
  TimerManager.init();
  registerEventHandlers();

  const ext = ConfigManager.ext;

  const cmdAI = seal.ext.newCmdItemInfo();
  cmdAI.name = 'ai'; // 指令名字，可用中文
  cmdAI.help = `帮助:
【.ai st】修改权限(仅骰主可用)
【.ai ck】检查权限(仅骰主可用)
【.ai prompt】检查当前prompt(仅骰主可用)
【.ai status】查看当前AI状态
【.ai ctxn】查看上下文里的名字
【.ai on】开启AI
【.ai sb】开启待机模式，此时AI将记忆聊天内容
【.ai off】关闭AI，此时仍能用关键词触发
【.ai fgt】遗忘上下文
【.ai role】选择角色设定
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

      switch (val) {
        case 'st': {
          if (ctx.privilegeLevel < 100) {
            seal.replyToSender(ctx, msg, seal.formatTmpl(ctx, "核心:提示_无权限"));
            return ret;
          }

          const val2 = cmdArgs.getArgN(2);
          if (!val2 || val2 == 'help') {
            seal.replyToSender(ctx, msg, `帮助:
【.ai st <ID> <权限限制>】

<ID>:
【QQ:1234567890】 私聊窗口
【QQ-Group:1234】 群聊窗口
【now】当前窗口

<权限限制>:
【0】普通用户
【40】邀请者
【50】群管理员
【60】群主
【100】骰主
不填写时默认为100`);
            return ret;
          }

          const limit = parseInt(cmdArgs.getArgN(3));
          if (isNaN(limit)) {
            seal.replyToSender(ctx, msg, '权限值必须为数字');
            return ret;
          }

          const id2 = val2 === 'now' ? id : val2;
          const ai2 = AIManager.getAI(id2);

          ai2.privilege.limit = limit;

          seal.replyToSender(ctx, msg, '权限修改完成');
          AIManager.saveAI(id2);
          return ret;
        }
        case 'ck': {
          if (ctx.privilegeLevel < 100) {
            seal.replyToSender(ctx, msg, seal.formatTmpl(ctx, "核心:提示_无权限"));
            return ret;
          }

          const val2 = cmdArgs.getArgN(2);
          if (!val2 || val2 == 'help') {
            seal.replyToSender(ctx, msg, `帮助:
【.ai ck <ID>】

<ID>:
【QQ:1234567890】 私聊窗口
【QQ-Group:1234】 群聊窗口
【now】当前窗口`);
            return ret;
          }

          const id2 = val2 === 'now' ? id : val2;
          const ai2 = AIManager.getAI(id2);

          const pr = ai2.privilege;

          const counter = pr.counter > -1 ? `${pr.counter}条` : '关闭';
          const timer = pr.timer > -1 ? `${pr.timer}秒` : '关闭';
          const prob = pr.prob > -1 ? `${pr.prob}%` : '关闭';
          const standby = pr.standby ? '开启' : '关闭';
          const s = `${id2}\n权限限制:${pr.limit}\n计数器模式(c):${counter}\n计时器模式(t):${timer}\n概率模式(p):${prob}\n待机模式:${standby}`;
          seal.replyToSender(ctx, msg, s);
          return ret;
        }
        case 'prompt': {
          if (ctx.privilegeLevel < 100) {
            seal.replyToSender(ctx, msg, seal.formatTmpl(ctx, "核心:提示_无权限"));
            return ret;
          }

          const systemMessage = buildSystemMessage(ctx, ai);

          seal.replyToSender(ctx, msg, systemMessage.contentArray[0]);
          return ret;
        }
        case 'status': {
          const pr = ai.privilege;
          if (ctx.privilegeLevel < pr.limit) {
            seal.replyToSender(ctx, msg, seal.formatTmpl(ctx, "核心:提示_无权限"));
            return ret;
          }

          seal.replyToSender(ctx, msg, `${id}
权限限制: ${pr.limit}
上下文轮数: ${ai.context.messages.filter(m => m.role === 'user').length}
计数器模式(c): ${pr.counter > -1 ? `${pr.counter}条` : '关闭'}
计时器模式(t): ${pr.timer > -1 ? `${pr.timer}秒` : '关闭'}
概率模式(p): ${pr.prob > -1 ? `${pr.prob}%` : '关闭'}
待机模式: ${pr.standby ? '开启' : '关闭'}
活跃时间段: ${pr.activeTimeRange ? `${pr.activeTimeRange.start}至${pr.activeTimeRange.end}` : '未设置'}`);
          return ret;
        }
        case 'ctxn': {
          const pr = ai.privilege;
          if (ctx.privilegeLevel < pr.limit) {
            seal.replyToSender(ctx, msg, seal.formatTmpl(ctx, "核心:提示_无权限"));
            return ret;
          }

          const names = ai.context.getNames();
          const s = `上下文里的名字有：\n<${names.join('>\n<')}>`;
          seal.replyToSender(ctx, msg, s);
          return ret;
        }
        case 'on': {
          const pr = ai.privilege;
          if (ctx.privilegeLevel < pr.limit) {
            seal.replyToSender(ctx, msg, seal.formatTmpl(ctx, "核心:提示_无权限"));
            return ret;
          }

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
【s】活跃时间段或时间段分割数量
格式为"开始时间-结束时间"(如"09:00-18:00")或数字(如"5"表示分割5个时间段)

【.ai on --t --p=42】使用示例`);
            return ret;
          }

          let text = `AI已开启：`;
          kwargs.forEach(kwarg => {
            const name = kwarg.name;
            const exist = kwarg.valueExists;
            const value = parseFloat(kwarg.value);

            switch (name) {
              case 'c':
              case 'counter': {
                pr.counter = exist && !isNaN(value) ? value : 10;
                text += `\n计数器模式:${pr.counter}条`;
                break;
              }
              case 't':
              case 'timer': {
                pr.timer = exist && !isNaN(value) ? value : 60;
                text += `\n计时器模式:${pr.timer}秒`;
                break;
              }
              case 'p':
              case 'prob': {
                pr.prob = exist && !isNaN(value) ? value : 10;
                text += `\n概率模式:${pr.prob}%`;
                break;
              }
              case 's':
              case 'schedule':
                if (exist && kwarg.value) {
                  const timeRange = kwarg.value.trim();
                  const timePattern = /^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/;
                  const match = timeRange.match(timePattern);
                  
                  if (match) {
                    const [startTime, endTime] = match.slice(1);
                    const validateTime = (timeStr: string): boolean => {
                      const [hours, minutes] = timeStr.split(':').map(Number);
                      return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
                    };
                    
                    if (validateTime(startTime) && validateTime(endTime)) {
                      const [startH, startM] = startTime.split(':').map(Number);
                      const [endH, endM] = endTime.split(':').map(Number);
                      pr.activeTimeRange = { 
                        start: startH + ':' + startM, 
                        end: endH + ':' + endM,
                      };
                      TimerManager.addSegmentTimer(ctx, msg, ai);
                      text += `\n活跃时间段:${startTime}至${endTime}`;
                    } else {
                      text += `\n活跃时间段格式错误，应为HH:MM格式`;
                    }
                  } else if (!isNaN(parseInt(timeRange))) {
                    const segments = parseInt(timeRange);
                    if (segments > 0 && segments <= 10) {
                      pr.segments = segments;
                      text += `\n时间段分割数量:${segments}个`;
                    } else {
                      text += `\n时间段分割数量必须在1-10之间`;
                    }
                  } else {
                    text += `\n活跃时间段格式错误，应为"开始时间-结束时间"或数字`;
                  }
                } else {
                  pr.activeTimeRange = null;
                  text += `\n已清除活跃时间段限制`;
                }
                break;
            }
          });

          pr.standby = true;

          if (pr.activeTimeRange) {
            TimerManager.addSegmentTimer(ctx, msg, ai);
          }

          seal.replyToSender(ctx, msg, text);
          AIManager.saveAI(id);
          return ret;
        }
        case 'sb': {
          const pr = ai.privilege;
          if (ctx.privilegeLevel < pr.limit) {
            seal.replyToSender(ctx, msg, seal.formatTmpl(ctx, "核心:提示_无权限"));
            return ret;
          }

          pr.counter = -1;
          pr.timer = -1;
          pr.prob = -1;
          pr.standby = true;

          ai.resetState();

          seal.replyToSender(ctx, msg, 'AI已开启待机模式');
          AIManager.saveAI(id);
          return ret;
        }
        case 'off': {
          const pr = ai.privilege;
          if (ctx.privilegeLevel < pr.limit) {
            seal.replyToSender(ctx, msg, seal.formatTmpl(ctx, "核心:提示_无权限"));
            return ret;
          }

          const kwargs = cmdArgs.kwargs;
          if (kwargs.length == 0) {
            pr.counter = -1;
            pr.timer = -1;
            pr.prob = -1;
            pr.standby = false;

            TimerManager.removeSegmentTimer(id);

            ai.resetState();

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
                pr.counter = -1;
                text += `\n计数器模式`;
                break;
              }
              case 't':
              case 'timer': {
                pr.timer = -1;
                text += `\n计时器模式`;
                break;
              }
              case 'p':
              case 'prob': {
                pr.prob = -1;
                text += `\n概率模式`;
                break;
              }
              case 's':
              case 'schedule': {
                pr.activeTimeRange = null;
                pr.segments = 3;
                TimerManager.removeSegmentTimer(id);
                text += `\n活跃时间段`;
                break;
              }
            }
          });

          ai.resetState();

          seal.replyToSender(ctx, msg, text);
          AIManager.saveAI(id);
          return ret;
        }
        case 'f':
        case 'fgt': {
          const pr = ai.privilege;
          if (ctx.privilegeLevel < pr.limit) {
            seal.replyToSender(ctx, msg, seal.formatTmpl(ctx, "核心:提示_无权限"));
            return ret;
          }

          ai.resetState();

          const val2 = cmdArgs.getArgN(2);
          switch (val2) {
            case 'ass':
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
          const pr = ai.privilege;
          if (ctx.privilegeLevel < pr.limit) {
            seal.replyToSender(ctx, msg, seal.formatTmpl(ctx, "核心:提示_无权限"));
            return ret;
          }

          const { roleSettingTemplate } = ConfigManager.message;

          const val2 = cmdArgs.getArgN(2);
          switch (val2) {
            case 'show': {
              const [roleSettingIndex, _] = seal.vars.intGet(ctx, "$gSYSPROMPT");
              seal.replyToSender(ctx, msg, `当前角色设定序号为${roleSettingIndex}，序号范围为0-${roleSettingTemplate.length - 1}`);
              return ret;
            }
            case '':
            case 'help': {
              seal.replyToSender(ctx, msg, `帮助:
【.ai role show】查看当前角色设定序号
【.ai role <序号>】切换角色设定，序号范围为0-${roleSettingTemplate.length - 1}`);
              return ret;
            }
            default: {
              const index = parseInt(val2);
              if (isNaN(index) || index < 0 || index >= roleSettingTemplate.length) {
                seal.replyToSender(ctx, msg, `角色设定序号错误，序号范围为0-${roleSettingTemplate.length - 1}`);
                return ret;
              }

              seal.vars.intSet(ctx, "$gSYSPROMPT", index);
              seal.replyToSender(ctx, msg, `角色设定已切换到${index}`);
              return ret;
            }
          }
        }
        case 'memo': {
          const mctx = seal.getCtxProxyFirst(ctx, cmdArgs);
          const muid = mctx.player.userId;

          if (ctx.privilegeLevel < 100 && muid !== uid) {
            seal.replyToSender(ctx, msg, seal.formatTmpl(ctx, "核心:提示_无权限"));
            return ret;
          }

          const ai2 = AIManager.getAI(muid);
          const val2 = cmdArgs.getArgN(2);
          switch (val2) {
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
            case 'p':
            case 'private': {
              const val3 = cmdArgs.getArgN(3);
              switch (val3) {
                case 'st': {
                  const s = cmdArgs.getRestArgsFrom(4);
                  switch (s) {
                    case '': {
                      seal.replyToSender(ctx, msg, '参数缺失，【.ai memo p st <内容>】设置个人设定，【.ai memo p st clr】清除个人设定');
                      return ret;
                    }
                    case 'clr': {
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
                case 'del': {
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
                case 'clr': {
                  ai2.memory.clearMemory();
                  seal.replyToSender(ctx, msg, '个人记忆已清除');
                  AIManager.saveAI(muid);
                  return ret;
                }
                default: {
                  seal.replyToSender(ctx, msg, '参数缺失，【.ai memo p show】展示个人记忆，【.ai memo p clr】清除个人记忆');
                  return ret;
                }
              }
            }
            case 'g':
            case 'group': {
              if (ctx.isPrivate) {
                seal.replyToSender(ctx, msg, '群聊记忆仅在群聊可用');
                return ret;
              }
              const pr = ai.privilege;
              if (ctx.privilegeLevel < pr.limit) {
                seal.replyToSender(ctx, msg, seal.formatTmpl(ctx, "核心:提示_无权限"));
                return ret;
              }
              const val3 = cmdArgs.getArgN(3);
              switch (val3) {
                case 'st': {
                  const s = cmdArgs.getRestArgsFrom(4);
                  switch (s) {
                    case '': {
                      seal.replyToSender(ctx, msg, '参数缺失，【.ai memo g st <内容>】设置群聊设定，【.ai memo g st clr】清除群聊设定');
                      return ret;
                    }
                    case 'clr': {
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
                case 'del': {
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
                case 'clr': {
                  ai.memory.clearMemory();
                  seal.replyToSender(ctx, msg, '群聊记忆已清除');
                  AIManager.saveAI(id);
                  return ret;
                }
                default: {
                  seal.replyToSender(ctx, msg, '参数缺失，【.ai memo g show】展示群聊记忆，【.ai memo g clr】清除群聊记忆');
                  return ret;
                }
              }
            }
            case 's':
            case 'short': {
              const val3 = cmdArgs.getArgN(3);
              switch (val3) {
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
                case 'clr': {
                  ai.memory.clearShortMemory();
                  seal.replyToSender(ctx, msg, '短期记忆已清除');
                  AIManager.saveAI(id);
                  return ret;
                }
                default: {
                  seal.replyToSender(ctx, msg, '参数缺失，【.ai memo s show】展示短期记忆，【.ai memo s clr】清除短期记忆');
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
【.ai memo [p/g/s] show】展示个人/群聊/短期记忆
【.ai memo [p/g/s] clr】清除个人/群聊/短期记忆
【.ai memo s [on/off]】开启/关闭短期记忆
【.ai memo sum】立即总结一次短期记忆`);
              return ret;
            }
          }
        }
        case 'tool': {
          const val2 = cmdArgs.getArgN(2);
          switch (val2) {
            case '': {
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
            case 'help': {
              const val3 = cmdArgs.getArgN(3);
              if (!val3) {
                seal.replyToSender(ctx, msg, `帮助:
【.ai tool】列出所有工具
【.ai tool help <函数名>】查看工具详情
【.ai tool [on/off]】开启或关闭全部工具函数
【.ai tool <函数名> [on/off]】开启或关闭工具函数
【.ai tool <函数名> --参数名=具体参数】试用工具函数`);
                return ret;
              }

              if (!ToolManager.toolMap.hasOwnProperty(val3)) {
                seal.replyToSender(ctx, msg, '没有这个工具函数');
                return ret;
              }

              const tool = ToolManager.toolMap[val3];
              const s = `${tool.info.function.name}
描述:${tool.info.function.description}

参数:
${Object.keys(tool.info.function.parameters.properties).map(key => {
                const property = tool.info.function.parameters.properties[key];
                return `【${key}】${property.description}`;
              }).join('\n')}

必需参数:${tool.info.function.parameters.required.join(',')}`;

              seal.replyToSender(ctx, msg, s);
              return ret;
            }
            case 'on': {
              const toolsNotAllow = ConfigManager.tool.toolsNotAllow;
              for (const key in ai.tool.toolStatus) {
                ai.tool.toolStatus[key] = toolsNotAllow.includes(key) ? false : true;
              }
              seal.replyToSender(ctx, msg, '已开启全部工具函数');
              AIManager.saveAI(id);
              return ret;
            }
            case 'off': {
              for (const key in ai.tool.toolStatus) {
                ai.tool.toolStatus[key] = false;
              }
              seal.replyToSender(ctx, msg, '已关闭全部工具函数');
              AIManager.saveAI(id);
              return ret;
            }
            default: {
              if (!ToolManager.toolMap.hasOwnProperty(val2)) {
                seal.replyToSender(ctx, msg, '没有这个工具函数');
                return ret;
              }

              // 开启或关闭工具函数
              const val3 = cmdArgs.getArgN(3);
              if (val3 === 'on') {
                const toolsNotAllow = ConfigManager.tool.toolsNotAllow;
                if (toolsNotAllow.includes(val2)) {
                  seal.replyToSender(ctx, msg, `工具函数 ${val2} 不被允许开启`);
                  return ret;
                }

                ai.tool.toolStatus[val2] = true;
                seal.replyToSender(ctx, msg, `已开启工具函数 ${val2}`);
                AIManager.saveAI(id);
                return ret;
              } else if (val3 === 'off') {
                ai.tool.toolStatus[val2] = false;
                seal.replyToSender(ctx, msg, `已关闭工具函数 ${val2}`);
                AIManager.saveAI(id);
                return ret;
              }

              // 调用工具函数
              if (ctx.privilegeLevel < 100) {
                seal.replyToSender(ctx, msg, seal.formatTmpl(ctx, "核心:提示_无权限"));
                return ret;
              }

              if (ToolManager.cmdArgs == null) {
                seal.replyToSender(ctx, msg, `暂时无法调用函数，请先使用 .r 指令`);
                return ret;
              }

              const tool = ToolManager.toolMap[val2];

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
                  .then(s => seal.replyToSender(ctx, msg, s));
                return ret;
              } catch (e) {
                const s = `调用函数 (${val2}) 失败:${e.message}`;
                seal.replyToSender(ctx, msg, s);
                return ret;
              }
            }
          }
        }
        case 'ign': {
          if (ctx.isPrivate) {
            seal.replyToSender(ctx, msg, '忽略名单仅在群聊可用');
            return ret;
          }

          const pr = ai.privilege;
          if (ctx.privilegeLevel < pr.limit) {
            seal.replyToSender(ctx, msg, seal.formatTmpl(ctx, "核心:提示_无权限"));
            return ret;
          }

          const epId = ctx.endPoint.userId;
          const mctx = seal.getCtxProxyFirst(ctx, cmdArgs);
          const muid = cmdArgs.amIBeMentionedFirst ? epId : mctx.player.userId;

          const val2 = cmdArgs.getArgN(2);
          switch (val2) {
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
            case 'rm': {
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
【.ai ign list】列出忽略名单

忽略名单中的对象仍能正常对话，但无法被选中QQ号`);
              return ret;
            }
          }
        }
        case 'tk': {
          if (ctx.privilegeLevel < 100) {
            seal.replyToSender(ctx, msg, seal.formatTmpl(ctx, "核心:提示_无权限"));
            return ret;
          }

          const val2 = cmdArgs.getArgN(2);
          switch (val2) {
            case 'lst': {
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
            case 'y': {
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
            case 'm': {
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
            case 'clr': {
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
              switch (val3) {
                case 'y': {
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
                case 'm': {
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
          const pr = ai.privilege;
          if (ctx.privilegeLevel < pr.limit) {
            seal.replyToSender(ctx, msg, seal.formatTmpl(ctx, "核心:提示_无权限"));
            return ret;
          }

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
【.img list [show/send]】展示保存的图片列表/展示并发送所有保存的图片
【.img del <图片名称1> <图片名称2> ...】删除指定名称的保存图片`;
  cmdImage.solve = (ctx, msg, cmdArgs) => {
    try {
      const val = cmdArgs.getArgN(1);
      const uid = ctx.player.userId;
      const gid = ctx.group.groupId;
      const id = ctx.isPrivate ? uid : gid;

      const ret = seal.ext.newCmdExecuteResult(true);
      const ai = AIManager.getAI(id);

      switch (val) {
        case 'draw': {
          const type = cmdArgs.getArgN(2);
          switch (type) {
            case 'lcl':
            case 'local': {
              const file = ai.imageManager.drawLocalImageFile();
              if (!file) {
                seal.replyToSender(ctx, msg, '暂无本地图片');
                return ret;
              }
              seal.replyToSender(ctx, msg, `[CQ:image,file=${file}]`);
              return ret;
            }
            case 'stl':
            case 'stolen': {
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
        case 'stl':
        case 'steal': {
          const op = cmdArgs.getArgN(2);
          switch (op) {
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
        case 'f':
        case 'fgt':
        case 'forget': {
          const type = cmdArgs.getArgN(2);
          switch (type) {
            case 'stl':
            case 'stolen': {
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

          if (val2 == 'ran') {
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
          } else {
            const match = val2.match(/\[CQ:image,file=(.*?)\]/);
            if (!match) {
              seal.replyToSender(ctx, msg, '请附带图片');
              return ret;
            }
            const url = match[1];
            const text = cmdArgs.getRestArgsFrom(3);
            ImageManager.imageToText(url, text)
              .then(s => seal.replyToSender(ctx, msg, `[CQ:image,file=${url}]\n` + s));
          }
          return ret;
        }
        case 'list': {
          const type = cmdArgs.getArgN(2);
          switch (type) {
            case 'show': {
              if (ai.imageManager.savedImages.length === 0) {
                seal.replyToSender(ctx, msg, '暂无保存的图片');
                return ret;
              }

              const imageList = ai.imageManager.savedImages.map((img, index) => `${index + 1}. 名称: ${img.id}
应用场景: ${img.scenes.join('、') || '无'}
权重: ${img.weight}`).join('\n');

              seal.replyToSender(ctx, msg, `保存的图片列表:\n${imageList}`);
              return ret;
            }
            case 'send': {
              if (ai.imageManager.savedImages.length === 0) {
                seal.replyToSender(ctx, msg, '暂无保存的图片');
                return ret;
              }

              const imageList = ai.imageManager.savedImages.map((img, index) => {
                return `${index + 1}. 名称: ${img.id}
应用场景: ${img.scenes.join('、') || '无'}
权重: ${img.weight}
[CQ:image,file=${seal.base64ToImage(img.base64)}]`;
              }).join('\n\n');

              seal.replyToSender(ctx, msg, `保存的图片列表:\n${imageList}`);
              return ret;
            }
            default: {
              seal.replyToSender(ctx, msg, '参数缺失，【.img list show】展示保存的图片列表，【.img list send】展示并发送所有保存的图片');
              return ret;
            }
          }
        }
        case 'del': {
          const nameList = cmdArgs.args.slice(1);
          if (nameList.length === 0) {
            seal.replyToSender(ctx, msg, '参数缺失，【.img del <图片名称1> <图片名称2> ...】删除指定名称的保存图片');
            return ret;
          }

          ai.imageManager.delSavedImage(nameList);
          seal.replyToSender(ctx, msg, `已删除图片`);
          return ret;
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

  //接受非指令消息
  ext.onNotCommandReceived = (ctx, msg): void | Promise<void> => {
    try {
      const { disabledInPrivate, globalStandby, triggerRegexes, ignoreRegexes, triggerCondition } = ConfigManager.received;
      if (ctx.isPrivate && disabledInPrivate) {
        return;
      }

      const userId = ctx.player.userId;
      const groupId = ctx.group.groupId;
      const id = ctx.isPrivate ? userId : groupId;

      let message = msg.message;
      const ai = AIManager.getAI(id);

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
      const CQTypes = transformTextToArray(message).filter(item => item.type !== 'text').map(item => item.type);
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
              if (!ai.isInActiveTimeRange()) {
                ai.context.addSystemUserMessage("睡眠中", "当前是你的睡眠时间，但触发了关键词", []);
              }
              return ai.handleReceipt(ctx, msg, ai, message, CQTypes)
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
            if (condition.uid && condition.uid !== userId) {
              continue;
            }

            return ai.handleReceipt(ctx, msg, ai, message, CQTypes)
              .then(() => ai.context.addSystemUserMessage('触发原因提示', condition.reason, []))
              .then(() => triggerConditionMap[id].splice(i, 1))
              .then(() => ai.chat(ctx, msg, 'AI设定触发条件'));
          }
        }

        // 开启任一模式时
        const pr = ai.privilege;
        if (pr.standby || globalStandby) {
          ai.handleReceipt(ctx, msg, ai, message, CQTypes)
            .then((): void | Promise<void> => {
              if (pr.counter > -1) {
                ai.context.counter += 1;
                if (ai.context.counter >= pr.counter) {
                  ai.context.counter = 0;
                  return ai.chat(ctx, msg, '计数器');
                }
              }

              if (pr.prob > -1) {
                const ran = Math.random() * 100;
                if (ran <= pr.prob) {
                  return ai.chat(ctx, msg, '概率');
                }
              }

              if (pr.timer > -1) {
                ai.context.timer = setTimeout(() => {
                  ai.context.timer = null;
                  ai.chat(ctx, msg, '计时器');
                }, pr.timer * 1000 + Math.floor(Math.random() * 500));
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

        let message = msg.message;

        const CQTypes = transformTextToArray(message).filter(item => item.type !== 'text').map(item => item.type);
        if (CQTypes.length === 0 || CQTypes.every(item => CQTYPESALLOW.includes(item))) {
          const pr = ai.privilege;
          if (pr.standby) {
            ai.handleReceipt(ctx, msg, ai, message, CQTypes);
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

      let message = msg.message;

      ai.tool.listen.resolve?.(message); // 将消息传递给监听工具

      const { allmsg } = ConfigManager.received;
      if (allmsg) {
        if (message === ai.context.lastReply) {
          ai.context.lastReply = '';
          return;
        }

        const CQTypes = transformTextToArray(message).filter(item => item.type !== 'text').map(item => item.type);
        if (CQTypes.length === 0 || CQTypes.every(item => CQTYPESALLOW.includes(item))) {
          const pr = ai.privilege;
          if (pr.standby) {
            ai.handleReceipt(ctx, msg, ai, message, CQTypes);
          }
        }
      }
    } catch (e) {
      logger.error(`获取发送消息处理出错，错误信息:${e.message}`);
    }
  }
}

main();
