import { AI } from "../AI/AI";
import { ToolCall, ToolManager } from "../tools/tool";
import { ConfigManager } from "./configUtils";
import { parseBody } from "./utils";

export async function FetchData(url: string, apiKey: string, bodyObject: any): Promise<any> {
    // 打印请求发送前的上下文
    const s = JSON.stringify(bodyObject.messages, (key, value) => {
        if (key === "" && Array.isArray(value)) {
            return value.filter(item => {
                return item.role !== "system";
            });
        }
        return value;
    });
    ConfigManager.printLog(`请求发送前的上下文:\n`, s);

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "Accept": "application/json"
        },
        body: JSON.stringify(bodyObject),
    });

    if (!response.ok) {
        const data = await response.json();
        throw new Error(`HTTP错误! 状态码: ${response.status}，内容: ${response.statusText}，错误信息: ${data.error.message}`);
    }

    const text = await response.text();
    if (!text) {
        throw new Error(`响应体为空!`);
    }

    const data = await response.json();
    if (data.error) {
        throw new Error(`请求失败：${JSON.stringify(data.error)}`);
    }

    return data;
}

export async function sendRequest(ctx: seal.MsgContext, msg: seal.Message, ai: AI, messages: {
    role: string,
    content: string,
    tool_calls?: ToolCall[],
    tool_call_id?: string
}[], tool_choice: string): Promise<string> {
    const { url, apiKey, bodyTemplate } = ConfigManager.getRequestConfig();
    const { tools } = ConfigManager.getToolsConfig();

    try {
        const bodyObject = parseBody(bodyTemplate, messages, tools, tool_choice);
        const time = Date.now();

        const data = await FetchData(url, apiKey, bodyObject);

        if (data.choices && data.choices.length > 0) {
            const message = data.choices[0].message;
            const reply = message.content;
            if (message.hasOwnProperty('reasoning_content')) {
                ConfigManager.printLog(`思维链内容:`, message.reasoning_content);
            }
            ConfigManager.printLog(`响应内容:`, reply, '\nlatency', Date.now() - time, 'ms');
            if (message.hasOwnProperty('tool_calls')) {
                ConfigManager.printLog(`触发工具调用`);
                ai.context.toolCallsIteration(message.tool_calls);
                const tool_choice = await ToolManager.handleTools(ctx, msg, ai, message.tool_calls);
                const { messages } = ConfigManager.getProcessedMessagesConfig(ctx, ai);
                return await sendRequest(ctx, msg, ai, messages, tool_choice);
            }
            return reply;
        } else {
            throw new Error("服务器响应中没有choices或choices为空");
        }
    } catch (error) {
        console.error("在sendRequest中出错：", error);
        return '';
    }
}