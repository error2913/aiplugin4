// ==UserScript==
// @name         示例：调用 aiplugin4 智能体 API
// @author       错误、白鱼
// @version      1.0.0
// @description  演示其他海豹插件通过 globalThis.aiplugin4 调用 aiplugin4 的智能体（依赖 aiplugin4，先加载 aiplugin4.js）
// @timestamp    2026-08-06
// @license      MIT
// @homepageURL  https://github.com/error2913/aiplugin4
// ==/UserScript==

/**
 * 示例插件：展示如何从其他海豹插件调用 aiplugin4 暴露的智能体 API。
 *
 * 依赖：先加载/安装 aiplugin4（本仓库），再加载本示例。
 * 只注册一个 .apitest 命令，子命令：
 *   .apitest status         打印 API 版本与可用方法
 *   .apitest chat <内容>    单轮对话（api.chat），把模型回复原样发回
 *   .apitest agent <内容>   用 api.getAgent 拿 Agent 实例后调用实例的 chat
 *   .apitest run            在当前会话触发完整编排（api.run），AI 走上下文/工具/分段发送
 *
 * 注意：
 * - 必须调用 seal.ext.register(ext) 注册扩展，命令才会进入海豹指令表；
 * - 海豹按「最长命令名前缀」匹配指令，注册后 .apitest 不会被 .a 快捷指令截胡。
 */

// 与 src/config/config.ts 一致：先 find 复用已注册扩展，不存在才 new + register，
// 避免 JS 重载时重复注册同名扩展
let ext = seal.ext.find('示例：调用aiplugin4智能体');
if (!ext) {
    ext = seal.ext.new('示例：调用aiplugin4智能体', '错误、白鱼', '1.0.0');
    seal.ext.register(ext);
}

const cmd = seal.ext.newCmdItemInfo();
cmd.name = 'apitest';
cmd.help = `帮助
【.apitest status】查看 aiplugin4 API 版本与可用方法
【.apitest chat <内容>】单轮对话，直接返回模型回复
【.apitest agent <内容>】通过 Agent 实例进行单轮对话
【.apitest run】在当前会话触发完整对话编排`;
cmd.solve = (ctx, msg, cmdArgs) => {
    const ret = seal.ext.newCmdExecuteResult(true);
    const api = globalThis.aiplugin4;
    if (!api) {
        seal.replyToSender(ctx, msg, '未找到 aiplugin4，请先加载 aiplugin4.js');
        return ret;
    }

    const sub = cmdArgs.getArgN(1);
    const content = cmdArgs.getRestArgsFrom(2).trim() || '请用一句话介绍你自己';

    switch (sub) {
        case 'status': {
            const methods = ['getAgent', 'getSession', 'chat', 'run'].filter((m) => typeof api[m] === 'function');
            seal.replyToSender(ctx, msg, `aiplugin4 v${api.version}，可用方法：${methods.join('、')}`);
            break;
        }
        case 'chat': {
            api.chat(content)
                .then((reply) => seal.replyToSender(ctx, msg, reply || '（模型未返回内容，请检查 aiplugin4 的模型配置）'))
                .catch((e) => seal.replyToSender(ctx, msg, `调用失败: ${e && e.message ? e.message : e}`));
            break;
        }
        case 'agent': {
            const agent = api.getAgent('*');
            agent.chat(content)
                .then((reply) => seal.replyToSender(ctx, msg, `[${agent.name}] ${reply || '（模型未返回内容）'}`))
                .catch((e) => seal.replyToSender(ctx, msg, `调用失败: ${e && e.message ? e.message : e}`));
            break;
        }
        case 'run': {
            // 完整编排：AI 会在当前聊天中按 aiplugin4 的触发/回复逻辑输出
            api.run(ctx, msg, { agentName: '*', reason: 'apitest' })
                .catch((e) => seal.replyToSender(ctx, msg, `调用失败: ${e && e.message ? e.message : e}`));
            break;
        }
        default:
            ret.showHelp = true;
    }
    return ret;
};

ext.cmdMap['apitest'] = cmd;
