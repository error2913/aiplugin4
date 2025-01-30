import { ConfigManager } from "./configUtils";
import { parseBody } from "./utils";

export async function FetchData(url: string, apiKey: string, bodyObject: any): Promise<any> {
    // 打印请求发送前的上下文
    const s = JSON.stringify(bodyObject.messages, (key, value) => {
        if (key === "" && Array.isArray(value)) {
            return value.filter(item => {
                return item.role === "user" || item.role === "assistant";
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
        throw new Error(`HTTP错误! 状态码: ${response.status}`);
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

export async function sendRequest(messages: { role: string, content: string }[]): Promise<string> {
    const { url, apiKey, bodyTemplate } = ConfigManager.getRequestConfig();

    try {
        const bodyObject = parseBody(bodyTemplate, messages);
        const time = Date.now();

        const data = await FetchData(url, apiKey, bodyObject);

        if (data.choices && data.choices.length > 0) {
            const reply = data.choices[0].message.content;
            if (data.choices[0].message.hasOwnProperty('reasoning_content')) {
                ConfigManager.printLog(`思维链内容:`, data.choices[0].message.reasoning_content);
            }
            ConfigManager.printLog(`响应内容:`, reply, '\nlatency', Date.now() - time, 'ms');
            return reply;
        } else {
            throw new Error("服务器响应中没有choices或choices为空");
        }
    } catch (error) {
        console.error("在sendRequest中出错：", error);
        return '';
    }
}