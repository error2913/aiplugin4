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
 *
 * 命令：
 *   .ai4chat <内容>   单轮对话（api.chat），把模型回复原样发回
 *   .ai4run <内容>    在当前会话触发完整编排（api.run），AI 走上下文/工具/分段发送
 *   .ai4agent <内容>  用 api.getAgent 拿 Agent 实例后调用实例的 chat
 *   .ai4status        打印 API 版本与可用方法
 */

const ext = seal.ext.new('示例：调用aiplugin4智能体', '错误、白鱼', '1.0.0');

function getApi() {
    return globalThis.aiplugin4 || null;
}

function apiMissing(ctx, msg) {
    seal.replyToSender(ctx, msg, '未找到 aiplugin4，请先加载 aiplugin4.js');
}

function registerCmd(name, solve) {
    const cmd = seal.ext.newCmdItemInfo();
    cmd.name = name;
    cmd.allowDelegate = true;
    cmd.solve = solve;
    ext.cmdMap[name] = cmd;
}

registerCmd('ai4status', (ctx, msg) => {
    const ret = seal.ext.newCmdExecuteResult(true);
    const api = getApi();
    if (!api) {
        apiMissing(ctx, msg);
        return ret;
    }
    const methods = ['getAgent', 'getSession', 'chat', 'run'].filter((m) => typeof api[m] === 'function');
    seal.replyToSender(ctx, msg, `aiplugin4 v${api.version}，可用方法：${methods.join('、')}`);
    return ret;
});

registerCmd('ai4chat', (ctx, msg, cmdArgs) => {
    const ret = seal.ext.newCmdExecuteResult(true);
    const api = getApi();
    if (!api) {
        apiMissing(ctx, msg);
        return ret;
    }
    const prompt = msg.message.replace(/^\.ai4chat\s*/i, '').trim() || '请用一句话介绍你自己';
    api.chat(prompt)
        .then((reply) => seal.replyToSender(ctx, msg, reply || '（模型未返回内容，请检查 aiplugin4 的模型配置）'))
        .catch((e) => seal.replyToSender(ctx, msg, `调用失败: ${e && e.message ? e.message : e}`));
    return ret;
});

registerCmd('ai4run', (ctx, msg) => {
    const ret = seal.ext.newCmdExecuteResult(true);
    const api = getApi();
    if (!api) {
        apiMissing(ctx, msg);
        return ret;
    }
    // 完整编排：AI 会在当前聊天中按 aiplugin4 的触发/回复逻辑输出
    api.run(ctx, msg, { agentName: '*', reason: '示例插件调用' })
        .catch((e) => seal.replyToSender(ctx, msg, `调用失败: ${e && e.message ? e.message : e}`));
    return ret;
});

registerCmd('ai4agent', (ctx, msg) => {
    const ret = seal.ext.newCmdExecuteResult(true);
    const api = getApi();
    if (!api) {
        apiMissing(ctx, msg);
        return ret;
    }
    const prompt = msg.message.replace(/^\.ai4agent\s*/i, '').trim() || '请用一句话介绍你自己';
    const agent = api.getAgent('*');
    agent.chat(prompt)
        .then((reply) => seal.replyToSender(ctx, msg, `[${agent.name}] ${reply || '（模型未返回内容）'}`))
        .catch((e) => seal.replyToSender(ctx, msg, `调用失败: ${e && e.message ? e.message : e}`));
    return ret;
});
