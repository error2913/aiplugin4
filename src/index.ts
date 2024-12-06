import { AIManager } from "./AI/AIManager";
import { CommandManager } from "./utils/commandUtils";
import { Config } from "./utils/configUtils";
import { getCQTypes, getUrlsInCQCode } from "./utils/utils";

function main() {
  let ext = seal.ext.find('aiplugin4');
  if (!ext) {
    ext = seal.ext.new('aiplugin4', 'baiyu&错误', '4.0.2');
    seal.ext.register(ext);
  }

  Config.ext = ext;
  Config.register();
  const aim = new AIManager();

  const CQTypesAllow = ["at", "image", "reply", "face"];

  const cmdAI = seal.ext.newCmdItemInfo();
  cmdAI.name = 'ai'; // 指令名字，可用中文
  cmdAI.help = `帮助:
【.ai st】修改权限(仅骰主可用)
【.ai ck】检查权限(仅骰主可用)
【.ai pr】查看当前群聊权限
【.ai on】开启AI
【.ai sb】开启待机模式，此时AI将记忆聊天内容
【.ai off】关闭AI，此时仍能用关键词触发
【.ai fgt】遗忘上下文`;
  cmdAI.solve = (ctx, msg, cmdArgs) => {
    const val = cmdArgs.getArgN(1);
    const uid = ctx.player.userId;
    const gid = ctx.group.groupId;
    const id = ctx.isPrivate ? uid : gid;

    const ret = seal.ext.newCmdExecuteResult(true);
    const ai = aim.getAI(id);

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
        const ai2 = aim.getAI(id2);

        ai2.privilege.limit = limit;

        seal.replyToSender(ctx, msg, '权限修改完成');
        aim.saveAI(id2);
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
        const ai2 = aim.getAI(id2);

        const pr = ai2.privilege;
        
        const counter = pr.counter > -1 ? `${pr.counter}条` : '关闭';
        const timer = pr.timer > -1 ? `${pr.timer}秒` : '关闭';
        const prob = pr.prob > -1? `${pr.prob}%` : '关闭';
        const interrupt = pr.interrupt > -1? `${pr.interrupt}` : '关闭';
        const standby = pr.standby ? '开启' : '关闭';
        const s = `${id}\n权限限制:${pr.limit}\n计数器模式(c):${counter}\n计时器模式(t):${timer}\n概率模式(p):${prob}\n插嘴模式(i):${interrupt}\n待机模式:${standby}`;
        seal.replyToSender(ctx, msg, s);
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
        const prob = pr.prob > -1? `${pr.prob}%` : '关闭';
        const interrupt = pr.interrupt > -1? `${pr.interrupt}` : '关闭';
        const standby = pr.standby ? '开启' : '关闭';
        const s = `${id}\n权限限制:${pr.limit}\n计数器模式(c):${counter}\n计时器模式(t):${timer}\n概率模式(p):${prob}\n插嘴模式(i):${interrupt}\n待机模式:${standby}`;
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
【i】插嘴模式，插嘴活跃度超过时触发
取值0-10，默认8

【.ai on --i --p=42】使用示例`

          seal.replyToSender(ctx, msg, s);
          return ret;
        }

        let text = `AI已开启：`
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
            case 'i':
            case 'interrupt': {
              pr.interrupt = exist && !isNaN(value) ? value : 8;
              text += `\n插嘴模式:${pr.interrupt}`;
              break;
            }
          }
        });

        pr.standby = true;

        seal.replyToSender(ctx, msg, text);
        aim.saveAI(id);
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
        pr.interrupt = -1;
        pr.standby = true;

        ai.clearData();

        seal.replyToSender(ctx, msg, 'AI已开启待机模式');
        aim.saveAI(id);
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
          pr.interrupt = -1;
          pr.standby = false;

          ai.clearData();

          seal.replyToSender(ctx, msg, 'AI已关闭');
          aim.saveAI(id);
          return ret;
        }

        let text = `AI已关闭：`
        kwargs.forEach(kwarg => {
          const name = kwarg.name;

          switch (name) {
            case 'c':
            case 'counter': {
              pr.counter = -1;
              text += `\n计数器模式`
              break;
            }
            case 't':
            case 'timer': {
              pr.timer = -1;
              text += `\n计时器模式`
              break;
            }
            case 'p':
            case 'prob': {
              pr.prob = -1;
              text += `\n概率模式`
              break;
            }
            case 'i':
            case 'interrupt': {
              pr.interrupt = -1;
              text += `\n插嘴模式`
              break;
            }
          }
        });

        ai.clearData();

        seal.replyToSender(ctx, msg, text);
        aim.saveAI(id);
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
        const messages = ai.context.messages;

        switch (val2) {
          case 'ass':
          case 'assistant': {
            ai.context.messages = messages.filter(item => item.role !== 'assistant');
            seal.replyToSender(ctx, msg, 'ai上下文已清除');
            aim.saveAI(id);
            return ret;
          }
          case 'user': {
            ai.context.messages = messages.filter(item => item.role !== 'user');
            seal.replyToSender(ctx, msg, '用户上下文已清除');
            aim.saveAI(id);
            return ret;
          }
          default: {
            ai.context.messages = []
            seal.replyToSender(ctx, msg, '上下文已清除');
            aim.saveAI(id);
            return ret;
          }
        }
      }
      case 'help':
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
  cmdImage.solve = async (ctx, msg, cmdArgs) => {
    const val = cmdArgs.getArgN(1);
    const uid = ctx.player.userId;
    const gid = ctx.group.groupId;
    const id = ctx.isPrivate ? uid : gid;

    const ret = seal.ext.newCmdExecuteResult(true);
    const ai = aim.getAI(id);

    switch (val) {
      case 'draw': {
        const type = cmdArgs.getArgN(2);
        switch (type) {
          case 'lcl':
          case 'local': {
            const image = ai.image.drawLocalImage();
            if (!image) {
              return ret;
            }
            seal.replyToSender(ctx, msg, `[CQ:image,file=${image}]`);
            return ret;
          }
          case 'stl':
          case 'stolen': {
            const image = ai.image.drawStolenImage();
            if (!image) {
              return ret;
            }
            seal.replyToSender(ctx, msg, `[CQ:image,file=${image}]`);
            return ret;
          }
          case 'all': {
            const image = ai.image.drawImage();
            if (!image) {
              return ret;
            }
            seal.replyToSender(ctx, msg, `[CQ:image,file=${image}]`);
            return ret;
          }
          default: {
            seal.replyToSender(ctx, msg, cmdImage.help);
            return ret;
          }
        }
      }
      case 'stl':
      case 'steal': {
        const op = cmdArgs.getArgN(2)
        switch (op) {
          case 'on': {
            ai.image.stealStatus = true;
            seal.replyToSender(ctx, msg, `图片偷取已开启,当前偷取数量:${ai.image.images.length}`);
            ai.image.saveImage();
            return ret;
          }
          case 'off': {
            ai.image.stealStatus = false;
            seal.replyToSender(ctx, msg, `图片偷取已关闭,当前偷取数量:${ai.image.images.length}`);
            ai.image.saveImage();
            return ret;
          }
          default: {
            seal.replyToSender(ctx, msg, `图片偷取状态:${ai.image.stealStatus},当前偷取数量:${ai.image.images.length}`);
            return ret;
          }
        }
      }
      case 'f':
      case 'fgt':
      case 'forget': {
        ai.image.images = [];
        seal.replyToSender(ctx, msg, '图片已遗忘');
        ai.image.saveImage();
        return ret;
      }
      case 'itt': {
        const val2 = cmdArgs.getArgN(2);
        if (!val2) {
          seal.replyToSender(ctx, msg, '【img itt [图片/ran] (附加提示词)】图片转文字');
          return ret;
        }

        let url = '';
        if (val2 == 'ran') {
          url = await ai.image.drawStolenImage();
          if (!url) {
            seal.replyToSender(ctx, msg, '图片偷取为空');
            return ret;
          }
        } else {
          const urls = getUrlsInCQCode(val2);
          if (urls.length == 0) {
            seal.replyToSender(ctx, msg, '请附带图片');
            return ret;
          }

          url = urls[0];
        }

        const text = cmdArgs.getRestArgsFrom(3);
        const s = await ai.image.imageToText(ctx, url, text);
        seal.replyToSender(ctx, msg, `[CQ:image,file=${url}]\n` + s);
        return ret;
      }
      default: {
        seal.replyToSender(ctx, msg, cmdImage.help);
        return ret;
      }
    }
  }

  //接受非指令消息
  ext.onNotCommandReceived = async (ctx, msg) => {
    const { canPrivate } = Config.getPrivateConfig();
    if (ctx.isPrivate && !canPrivate) {
      return;
    }

    const userId = ctx.player.userId;
    const groupId = ctx.group.groupId;
    const id = ctx.isPrivate ? userId : groupId;

    const message = msg.message;
    const ai = aim.getAI(id);

    // 非指令清除上下文
    const { clearWords, clearReplys } = Config.getForgetConfig();
    if (clearWords.some(item => message === item)) {
      const pr = ai.privilege;
      if (ctx.privilegeLevel < pr.limit) {
        return;
      }

      ai.clearData();
      ai.context.messages = [];

      const s = clearReplys[Math.floor(Math.random() * clearReplys.length)];

      seal.replyToSender(ctx, msg, s);
      aim.saveAI(id);
      return;
    }

    // 检查CQ码
    const CQTypes = getCQTypes(message);
    if (CQTypes.includes('image')) {
      const { condition, trigger, maxImageNum } = Config.getImageTriggerConfig(message);

      // 非指令触发
      if (trigger) {
        const fmtCondition = parseInt(seal.format(ctx, `{${condition}}`));
        if (fmtCondition !== 0) {
          const image = await ai.image.drawImage();
          if (image !== '') {
            seal.replyToSender(ctx, msg, `[CQ:image,file=${image}]`);
            return;
          }
        }
      }

      //偷
      if (ai.image.stealStatus) {
        const urls = getUrlsInCQCode(message);
        if (urls.length !== 0) {
          ai.image.images = ai.image.images.concat(urls).slice(-maxImageNum);
          ai.image.saveImage();
        }
      }
    }

    if (CQTypes.length === 0 || CQTypes.every(item => CQTypesAllow.includes(item))) {
      const { trigger, condition } = Config.getTriggerConfig(message);

      clearTimeout(ai.data.timer);
      ai.data.timer = null;

      // 非指令触发
      if (trigger) {
        const fmtCondition = parseInt(seal.format(ctx, `{${condition}}`));
        if (fmtCondition == 0) {
          return;
        }

        await ai.iteration(ctx, message, 'user');

        Config.printLog('非指令触发回复');
        const result = await ai.chat(ctx, msg);
        for (let i = 0; i < result.length; i++) {
          seal.replyToSender(ctx, msg, result[i]);
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        return;
      }

      // 开启任一模式时
      else {
        const pr = ai.privilege;
        if (ctx.privilegeLevel < pr.limit) {
          return;
        }

        if (pr.standby) {
          await ai.iteration(ctx, message, 'user');
        }

        if (pr.counter > -1) {
          ai.data.counter += 1;

          if (ai.data.counter >= pr.counter) {
            Config.printLog('计数器触发回复');
            ai.data.counter = 0;

            const result = await ai.chat(ctx, msg);
            for (let i = 0; i < result.length; i++) {
              seal.replyToSender(ctx, msg, result[i]);
              await new Promise(resolve => setTimeout(resolve, 500));
            }
            return;
          }
        }

        if (pr.prob > -1) {
          const ran = Math.random() * 100;

          if (ran <= pr.prob) {
            Config.printLog('概率触发回复');

            const result = await ai.chat(ctx, msg);
            for (let i = 0; i < result.length; i++) {
              seal.replyToSender(ctx, msg, result[i]);
              await new Promise(resolve => setTimeout(resolve, 500));
            }
            return;
          }
        }

        if (pr.interrupt > -1) {
          const act = await ai.getAct();

          if (act >= pr.interrupt) {
            Config.printLog(`插嘴触发回复:${act}`);
            ai.data.interrupt.act = 0;

            const result = await ai.chat(ctx, msg);
            for (let i = 0; i < result.length; i++) {
              seal.replyToSender(ctx, msg, result[i]);
              await new Promise(resolve => setTimeout(resolve, 500));
            }
            return;
          }
        }

        if (pr.timer > -1) {
          ai.data.timer = setTimeout(async () => {
            Config.printLog('计时器触发回复');

            ai.data.timer = null;
            const result = await ai.chat(ctx, msg);
            for (let i = 0; i < result.length; i++) {
              seal.replyToSender(ctx, msg, result[i]);
              await new Promise(resolve => setTimeout(resolve, 500));
            }
          }, pr.timer * 1000 + Math.floor(Math.random() * 500));
          return;
        }
      }
    }
  }

  //接受的指令
  ext.onCommandReceived = async (ctx, msg, cmdArgs) => {
    if (CommandManager.cmdArgs === null) {
      CommandManager.cmdArgs = cmdArgs;
    }

    const { allcmd } = Config.getMonitorCommandConfig();
    if (allcmd) {
      const uid = ctx.player.userId;
      const gid = ctx.group.groupId;
      const id = ctx.isPrivate ? uid : gid;

      const ai = aim.getAI(id);

      const message = msg.message;

      const CQTypes = getCQTypes(message);
      if (CQTypes.length === 0 || CQTypes.every(item => CQTypesAllow.includes(item))) {
        const pr = ai.privilege;
        if (pr.standby) {
          await ai.iteration(ctx, message, 'user');
        }
      }
    }
  }

  //骰子发送的消息
  ext.onMessageSend = async (ctx, msg) => {
    const { allmsg } = Config.getMonitorAllMessageConfig();
    if (allmsg) {
      const uid = ctx.player.userId;
      const gid = ctx.group.groupId;
      const id = ctx.isPrivate ? uid : gid;

      const ai = aim.getAI(id);

      const message = msg.message;

      if (message === ai.context.lastReply) {
        ai.context.lastReply = '';
        return;
      }

      const CQTypes = getCQTypes(message);
      if (CQTypes.length === 0 || CQTypes.every(item => CQTypesAllow.includes(item))) {
        const pr = ai.privilege;
        if (pr.standby) {
          await ai.iteration(ctx, message, 'assistant');
          return;
        }
      }
    }
  }

  // 将命令注册到扩展中
  ext.cmdMap['AI'] = cmdAI;
  ext.cmdMap['ai'] = cmdAI;
  ext.cmdMap['img'] = cmdImage;
}

main();
