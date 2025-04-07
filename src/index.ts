import { AIManager } from "./AI/AI";
import { Image, ImageManager } from "./AI/image";
import { ToolManager } from "./tool/tool";
import { timerQueue } from "./tool/tool_time";
import { ConfigManager } from "./config/config";
import { transformMsgId } from "./utils/utils";
import { createMsg, createCtx } from "./utils/utils_seal";
import { buildSystemMessage } from "./utils/utils_message";
import { triggerConditionMap } from "./tool/tool_trigger";
import { logger } from "./AI/logger";
import { parseText } from "./utils/utils_string";

function main() {
  let ext = seal.ext.find('aiplugin4');
  if (!ext) {
    ext = seal.ext.new('aiplugin4', 'baiyu&错误', '4.7.3');
    seal.ext.register(ext);
  }

  try {
    JSON.parse(ext.storageGet(`timerQueue`) || '[]')
      .forEach((item: any) => {
        timerQueue.push(item);
      });
  } catch (e) {
    logger.error('在获取timerQueue时出错', e);
  }

  ConfigManager.ext = ext;
  ConfigManager.registerConfig();
  AIManager.getUsageMap();
  ToolManager.registerTool();

  const CQTypesAllow = ["at", "image", "reply", "face"];

  const cmdAI = seal.ext.newCmdItemInfo();
  cmdAI.name = 'ai'; // 指令名字，可用中文
  cmdAI.help = `帮助:
【.ai st】修改权限(仅骰主可用)
【.ai ck】检查权限(仅骰主可用)
【.ai prompt】检查当前prompt(仅骰主可用)
【.ai pr】查看当前群聊权限
【.ai ctxn】查看上下文里的名字
【.ai on】开启AI
【.ai sb】开启待机模式，此时AI将记忆聊天内容
【.ai off】关闭AI，此时仍能用关键词触发
【.ai fgt】遗忘上下文
【.ai memo】AI的记忆相关
【.ai tool】AI的工具相关
【.ai tk】AI的token相关
【.ai shut】终止AI当前流式输出`;
  cmdAI.allowDelegate = true;
  cmdAI.solve = (ctx, msg, cmdArgs) => {
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
          const s = `帮助:
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
不填写时默认为0`;

          seal.replyToSender(ctx, msg, s);
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
          const s = `帮助:
【.ai ck <ID>】

<ID>:
【QQ:1234567890】 私聊窗口
【QQ-Group:1234】 群聊窗口
【now】当前窗口`;

          seal.replyToSender(ctx, msg, s);
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

        seal.replyToSender(ctx, msg, systemMessage.content);
        return ret;
      }
      case 'pr': {
        const pr = ai.privilege;
        if (ctx.privilegeLevel < pr.limit) {
          seal.replyToSender(ctx, msg, seal.formatTmpl(ctx, "核心:提示_无权限"));
          return ret;
        }

        const counter = pr.counter > -1 ? `${pr.counter}条` : '关闭';
        const timer = pr.timer > -1 ? `${pr.timer}秒` : '关闭';
        const prob = pr.prob > -1 ? `${pr.prob}%` : '关闭';
        const standby = pr.standby ? '开启' : '关闭';
        const s = `${id}\n权限限制:${pr.limit}\n计数器模式(c):${counter}\n计时器模式(t):${timer}\n概率模式(p):${prob}\n待机模式:${standby}`;
        seal.replyToSender(ctx, msg, s);
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
          const s = `帮助:
【.ai on --<参数>=<数字>】

<参数>:
【c】计数器模式，接收消息数达到后触发。
单位/条，默认10条
【t】计时器模式，最后一条消息后达到时限触发
单位/秒，默认60秒
【p】概率模式，每条消息按概率触发
单位/%，默认10%

【.ai on --t --p=42】使用示例`;

          seal.replyToSender(ctx, msg, s);
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
          }
        });

        pr.standby = true;

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

        ai.clearData();

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

          ai.clearData();

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
          }
        });

        ai.clearData();

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

        ai.clearData();

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
          case 'st': {
            const s = cmdArgs.getRestArgsFrom(3);
            if (s.length > 20) {
              seal.replyToSender(ctx, msg, '记忆过长，请控制在20字以内');
              return ret;
            }
            ai2.memory.setSystemMemory(s);
            seal.replyToSender(ctx, msg, '记忆已添加');
            AIManager.saveAI(muid);
            return ret;
          }
          case 'clr': {
            const val3 = cmdArgs.getArgN(3);
            if (val3 === 'group') {
              if (ctx.isPrivate) {
                seal.replyToSender(ctx, msg, '群聊记忆仅在群聊可用');
                return ret;
              }
              ai.memory.clearMemory();
              seal.replyToSender(ctx, msg, '群聊记忆已清除');
              AIManager.saveAI(id);
              return ret;
            }
            ai2.memory.clearMemory();
            seal.replyToSender(ctx, msg, '记忆已清除');
            AIManager.saveAI(muid);
            return ret;
          }
          case 'show': {
            const val3 = cmdArgs.getArgN(3);
            if (val3 === 'group') {
              if (ctx.isPrivate) {
                seal.replyToSender(ctx, msg, '群聊记忆仅在群聊可用');
                return ret;
              }
              if (ai.memory.memoryList.length === 0) {
                seal.replyToSender(ctx, msg, '暂无群聊记忆');
                return ret;
              }
              const s = ai.memory.buildGroupMemoryPrompt();
              seal.replyToSender(ctx, msg, s);
              return ret;
            }

            const s = ai2.memory.buildPersonMemoryPrompt();
            seal.replyToSender(ctx, msg, s);
            return ret;
          }
          default: {
            const s = `帮助:
【.ai memo st <内容>】设置记忆
【.ai memo clr】清除记忆
【.ai memo clr group】清除群聊记忆
【.ai memo show】展示个人记忆
【.ai memo show group】展示群聊记忆`;

            seal.replyToSender(ctx, msg, s);
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
              const s = `帮助:
【.ai tool】列出所有工具
【.ai tool help <函数名>】查看工具详情
【.ai tool [on/off]】开启或关闭全部工具函数
【.ai tool <函数名> [on/off]】开启或关闭工具函数
【.ai tool <函数名> --参数名=具体参数】试用工具函数
`;
              seal.replyToSender(ctx, msg, s);
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
              seal.replyToSender(ctx, msg, `暂时无法调用函数，请先使用任意海豹指令`);
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
                .then(s => {
                  seal.replyToSender(ctx, msg, s);
                });
              return ret;
            } catch (e) {
              const s = `调用函数 (${val2}) 失败:${e.message}`;
              seal.replyToSender(ctx, msg, s);
              return ret;
            }
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
              get_chart_url('year', obj).then(url => {
                if (!url) {
                  seal.replyToSender(ctx, msg, `图表生成失败`);
                  return;
                }
                seal.replyToSender(ctx, msg, `[CQ:image,file=${url}]`);
              });
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
              get_chart_url('month', obj).then(url => {
                if (!url) {
                  seal.replyToSender(ctx, msg, `图表生成失败`);
                  return;
                }
                seal.replyToSender(ctx, msg, `[CQ:image,file=${url}]`);
              });
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
            const s = `帮助:
【.ai tk lst】查看所有模型
【.ai tk sum】查看所有模型的token使用记录总和
【.ai tk all】查看所有模型的token使用记录
【.ai tk [y/m] (chart)】查看所有模型今年/这个月的token使用记录
【.ai tk <模型名称>】查看模型的token使用记录
【.ai tk <模型名称> [y/m] (chart)】查看模型今年/这个月的token使用记录
【.ai tk clr】清除token使用记录
【.ai tk clr <模型名称>】清除token使用记录`;
            seal.replyToSender(ctx, msg, s);
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
                  get_chart_url('year', obj).then(url => {
                    if (!url) {
                      seal.replyToSender(ctx, msg, `图表生成失败`);
                      return;
                    }
                    seal.replyToSender(ctx, msg, `[CQ:image,file=${url}]`);
                  });
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
                  get_chart_url('month', obj).then(url => {
                    if (!url) {
                      seal.replyToSender(ctx, msg, `图表生成失败`);
                      return;
                    }
                    seal.replyToSender(ctx, msg, `[CQ:image,file=${url}]`);
                  });
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

        ai.stopCurrentChatStream().then(() => {
          seal.replyToSender(ctx, msg, '已停止当前对话');
        });
        return ret;
      }
      default: {
        ret.showHelp = true;
        return ret;
      }
    }
  }

  const cmdImage = seal.ext.newCmdItemInfo();
  cmdImage.name = 'img'; // 指令名字，可用中文
  cmdImage.help = `盗图指南:
【img draw [stl/lcl/all]】随机抽取偷的图片/本地图片/全部
【img stl (on/off)】偷图 开启/关闭
【img f】遗忘
【img itt [图片/ran] (附加提示词)】图片转文字`;
  cmdImage.solve = (ctx, msg, cmdArgs) => {
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
            const image = ai.image.drawLocalImageFile();
            if (!image) {
              seal.replyToSender(ctx, msg, '暂无本地图片');
              return ret;
            }
            seal.replyToSender(ctx, msg, `[CQ:image,file=${image}]`);
            return ret;
          }
          case 'stl':
          case 'stolen': {
            ai.image.drawStolenImageFile()
              .then(image => {
                if (!image) {
                  seal.replyToSender(ctx, msg, '暂无偷取图片');
                } else {
                  seal.replyToSender(ctx, msg, `[CQ:image,file=${image}]`);
                }
              });
            return ret;
          }
          case 'all': {
            ai.image.drawImageFile()
              .then(image => {
                if (!image) {
                  seal.replyToSender(ctx, msg, '暂无图片');
                } else {
                  seal.replyToSender(ctx, msg, `[CQ:image,file=${image}]`);
                }
              });
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
            ai.image.stealStatus = true;
            seal.replyToSender(ctx, msg, `图片偷取已开启,当前偷取数量:${ai.image.imageList.length}`);
            AIManager.saveAI(id);
            return ret;
          }
          case 'off': {
            ai.image.stealStatus = false;
            seal.replyToSender(ctx, msg, `图片偷取已关闭,当前偷取数量:${ai.image.imageList.length}`);
            AIManager.saveAI(id);
            return ret;
          }
          default: {
            seal.replyToSender(ctx, msg, `图片偷取状态:${ai.image.stealStatus},当前偷取数量:${ai.image.imageList.length}`);
            return ret;
          }
        }
      }
      case 'f':
      case 'fgt':
      case 'forget': {
        ai.image.imageList = [];
        seal.replyToSender(ctx, msg, '图片已遗忘');
        AIManager.saveAI(id);
        return ret;
      }
      case 'itt': {
        const val2 = cmdArgs.getArgN(2);
        if (!val2) {
          seal.replyToSender(ctx, msg, '【img itt [图片/ran] (附加提示词)】图片转文字');
          return ret;
        }

        if (val2 == 'ran') {
          ai.image.drawStolenImageFile()
            .then(url => {
              if (!url) {
                seal.replyToSender(ctx, msg, '图片偷取为空');
              } else {
                const text = cmdArgs.getRestArgsFrom(3);
                ImageManager.imageToText(url, text)
                  .then(s => {
                    seal.replyToSender(ctx, msg, `[CQ:image,file=${url}]\n` + s);
                  });
              }
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
            .then(s => {
              seal.replyToSender(ctx, msg, `[CQ:image,file=${url}]\n` + s);
            });
        }
        return ret;
      }
      default: {
        ret.showHelp = true;
        return ret;
      }
    }
  }

  // 将命令注册到扩展中
  ext.cmdMap['AI'] = cmdAI;
  ext.cmdMap['ai'] = cmdAI;
  ext.cmdMap['img'] = cmdImage;

  //接受非指令消息
  ext.onNotCommandReceived = async (ctx, msg) => {
    const { disabledInPrivate, keyWords, condition } = ConfigManager.received;
    if (ctx.isPrivate && disabledInPrivate) {
      return;
    }

    const userId = ctx.player.userId;
    const groupId = ctx.group.groupId;
    const id = ctx.isPrivate ? userId : groupId;

    let message = msg.message;
    let images: Image[] = [];
    const ai = AIManager.getAI(id);

    // 检查CQ码
    const CQTypes = parseText(message).filter(item => item.type !== 'text').map(item => item.type);
    if (CQTypes.length === 0 || CQTypes.every(item => CQTypesAllow.includes(item))) {
      clearTimeout(ai.context.timer);
      ai.context.timer = null;

      // 非指令触发
      for (const keyword of keyWords) {
        if (!keyword) {
          continue;
        }
        try {
          const pattern = new RegExp(keyword);
          if (!pattern.test(message)) {
            continue;
          }
        } catch (error) {
          logger.error(`正则表达式错误，内容:${keyword}，错误信息:${error}`);
          continue;
        }

        const fmtCondition = parseInt(seal.format(ctx, `{${condition}}`));
        if (fmtCondition === 1) {
          // 图片偷取，以及图片转文字
          if (CQTypes.includes('image')) {
            const result = await ImageManager.handleImageMessage(ctx, message);
            message = result.message;
            images = result.images;
            if (ai.image.stealStatus) {
              ai.image.updateImageList(images);
            }
          }

          await ai.context.addMessage(ctx, message, images, 'user', transformMsgId(msg.rawId));

          logger.info('非指令触发回复');
          await ai.chat(ctx, msg);
          AIManager.saveAI(id);
          return;
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

          // 图片偷取，以及图片转文字
          if (CQTypes.includes('image')) {
            const result = await ImageManager.handleImageMessage(ctx, message);
            message = result.message;
            images = result.images;
            if (ai.image.stealStatus) {
              ai.image.updateImageList(images);
            }
          }

          await ai.context.addMessage(ctx, message, images, 'user', transformMsgId(msg.rawId));
          await ai.context.addSystemUserMessage('触发原因提示', condition.reason, []);
          triggerConditionMap[id].splice(i, 1);

          logger.info('AI设定触发条件触发回复');
          await ai.chat(ctx, msg);
          AIManager.saveAI(id);
          return;
        }
      }

      // 开启任一模式时
      const pr = ai.privilege;
      if (pr.standby) {
        // 图片偷取，以及图片转文字
        if (CQTypes.includes('image')) {
          const result = await ImageManager.handleImageMessage(ctx, message);
          message = result.message;
          images = result.images;
          if (ai.image.stealStatus) {
            ai.image.updateImageList(images);
          }
        }

        await ai.context.addMessage(ctx, message, images, 'user', transformMsgId(msg.rawId));
      }

      if (pr.counter > -1) {
        ai.context.counter += 1;

        if (ai.context.counter >= pr.counter) {
          logger.info('计数器触发回复');
          ai.context.counter = 0;

          await ai.chat(ctx, msg);
          AIManager.saveAI(id);
          return;
        }
      }

      if (pr.prob > -1) {
        const ran = Math.random() * 100;

        if (ran <= pr.prob) {
          logger.info('概率触发回复');

          await ai.chat(ctx, msg);
          AIManager.saveAI(id);
          return;
        }
      }

      if (pr.timer > -1) {
        ai.context.timer = setTimeout(async () => {
          logger.info('计时器触发回复');

          ai.context.timer = null;
          await ai.chat(ctx, msg);
          AIManager.saveAI(id);
        }, pr.timer * 1000 + Math.floor(Math.random() * 500));
      }
    }
  }

  //接受的指令
  ext.onCommandReceived = async (ctx, msg, cmdArgs) => {
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
      let images: Image[] = [];

      const CQTypes = parseText(message).filter(item => item.type !== 'text').map(item => item.type);
      if (CQTypes.length === 0 || CQTypes.every(item => CQTypesAllow.includes(item))) {
        const pr = ai.privilege;
        if (pr.standby) {
          // 图片偷取，以及图片转文字
          if (CQTypes.includes('image')) {
            const result = await ImageManager.handleImageMessage(ctx, message);
            message = result.message;
            images = result.images;
            if (ai.image.stealStatus) {
              ai.image.updateImageList(images);
            }
          }

          await ai.context.addMessage(ctx, message, images, 'user', transformMsgId(msg.rawId));
        }
      }
    }
  }

  //骰子发送的消息
  ext.onMessageSend = async (ctx, msg) => {
    const uid = ctx.player.userId;
    const gid = ctx.group.groupId;
    const id = ctx.isPrivate ? uid : gid;

    const ai = AIManager.getAI(id);

    let message = msg.message;
    let images: Image[] = [];

    ai.tool.listen.resolve?.(message); // 将消息传递给监听工具

    const { allmsg } = ConfigManager.received;
    if (allmsg) {
      if (message === ai.context.lastReply) {
        ai.context.lastReply = '';
        return;
      }

      const CQTypes = parseText(message).filter(item => item.type !== 'text').map(item => item.type);
      if (CQTypes.length === 0 || CQTypes.every(item => CQTypesAllow.includes(item))) {
        const pr = ai.privilege;
        if (pr.standby) {
          // 图片偷取，以及图片转文字
          if (CQTypes.includes('image')) {
            const result = await ImageManager.handleImageMessage(ctx, message);
            message = result.message;
            images = result.images;
            if (ai.image.stealStatus) {
              ai.image.updateImageList(images);
            }
          }

          await ai.context.addMessage(ctx, message, images, 'assistant', transformMsgId(msg.rawId));
          return;
        }
      }
    }
  }

  let isTaskRunning = false;
  seal.ext.registerTask(ext, "cron", "* * * * *", async () => {
    if (timerQueue.length === 0) {
      return;
    }

    if (isTaskRunning) {
      logger.info('定时器任务正在运行，跳过');
      return;
    }

    isTaskRunning = true;

    let changed = false;
    for (let i = 0; i < timerQueue.length && i >= 0; i++) {
      const timestamp = timerQueue[i].timestamp;
      if (timestamp > Math.floor(Date.now() / 1000)) {
        continue;
      }

      const setTime = timerQueue[i].setTime;
      const content = timerQueue[i].content;
      const id = timerQueue[i].id;
      const messageType = timerQueue[i].messageType;
      const uid = timerQueue[i].uid;
      const gid = timerQueue[i].gid;
      const epId = timerQueue[i].epId;
      const msg = createMsg(messageType, uid, gid);
      const ctx = createCtx(epId, msg);
      const ai = AIManager.getAI(id);

      const s = `你设置的定时器触发了，请按照以下内容发送回复：
定时器设定时间：${setTime}
当前触发时间：${new Date().toLocaleString()}
提示内容：${content}`;

      await ai.context.addSystemUserMessage("定时器触发提示", s, []);

      logger.info('定时任务触发回复');
      await ai.chat(ctx, msg);
      AIManager.saveAI(id);

      timerQueue.splice(i, 1);
      i--;
      changed = true;

      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    if (changed) {
      ext.storageSet(`timerQueue`, JSON.stringify(timerQueue));
    }

    isTaskRunning = false;
  })
}

async function get_chart_url(chart_type: string, usage_data: {
  [key: string]: {
    prompt_tokens: number;
    completion_tokens: number;
  }
}) {
  const { usageChartUrl } = ConfigManager.backend;
  try {
    const response = await fetch(`${usageChartUrl}/chart`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        chart_type: chart_type,
        data: usage_data
      })
    })

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`请求失败! 状态码: ${response.status}\n响应体: ${text}`);
    }
    if (!text) {
      throw new Error("响应体为空");
    }

    try {
      const data = JSON.parse(text);
      if (data.error) {
        throw new Error(`请求失败! 错误信息: ${data.error.message}`);
      }
      return data.image_url;
    } catch (e) {
      throw new Error(`解析响应体时出错:${e}\n响应体:${text}`);
    }
  } catch (error) {
    logger.error("在get_chart_url中请求出错：", error);
    return '';
  }
}

main();
