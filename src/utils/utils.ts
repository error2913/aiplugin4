import { ConfigManager } from "../config/config";
import { ToolInfo } from "../tool/tool";

export function log(...data: any[]) {
    const { logLevel } = ConfigManager.log;

    if (logLevel === "永不") {
        return;
    }

    if (logLevel === "简短") {
        const s = data.map(item => `${item}`).join(" ");
        if (s.length > 1000) {
            console.log(s.substring(0, 500), "\n...\n", s.substring(s.length - 500));
            return;
        }
    }

    console.log('【aiplugin4】: ', ...data);
}

export function generateId() {
    const timestamp = Date.now().toString(36); // 将时间戳转换为36进制字符串
    const random = Math.random().toString(36).substring(2, 6); // 随机数部分
    return (timestamp + random).slice(-6); // 截取最后6位
}

export function parseBody(template: string[], messages: any[], tools: ToolInfo[], tool_choice: string) {
    const { isTool, usePromptEngineering } = ConfigManager.tool;

    const bodyObject: any = {};

    for (let i = 0; i < template.length; i++) {
        const s = template[i];
        if (s.trim() === '') {
            continue;
        }

        try {
            const obj = JSON.parse(`{${s}}`);
            const key = Object.keys(obj)[0];
            bodyObject[key] = obj[key];
        } catch (err) {
            throw new Error(`解析body的【${s}】时出现错误:${err}`);
        }
    }

    if (!bodyObject.hasOwnProperty('messages')) {
        bodyObject.messages = messages;
    }

    if (!bodyObject.hasOwnProperty('model')) {
        throw new Error(`body中没有model`);
    }

    if (isTool && !usePromptEngineering) {
        if (!bodyObject.hasOwnProperty('tools')) {
            bodyObject.tools = tools;
        }

        if (!bodyObject.hasOwnProperty('tool_choice')) {
            bodyObject.tool_choice = tool_choice;
        }
    } else {
        delete bodyObject?.tools;
        delete bodyObject?.tool_choice;
    }

    return bodyObject;
}