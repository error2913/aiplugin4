import { ConfigManager } from "./configUtils";
import { parseBody } from "./utils";

export async function getRespose(url: string, apiKey: string, bodyObject: any): Promise<Response> {
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

    return response;
}

export async function sendRequest(messages: { role: string, content: string }[]): Promise<string> {
    const { url, apiKey, bodyTemplate } = ConfigManager.getRequestConfig();

    try {
        const bodyObject = parseBody(bodyTemplate, messages);
        const time = Date.now();

        const response = await getRespose(url, apiKey, bodyObject);
        const data_response = await response.json();
        if (data_response.error) {
            throw new Error(`请求失败：${JSON.stringify(data_response.error)}`);
        }

        if (data_response.choices && data_response.choices.length > 0) {
            const reply = data_response.choices[0].message.content;
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