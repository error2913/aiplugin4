import { ConfigManager } from "../config/config";

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

    console.log(...data);
}

export function generateId() {
    const timestamp = Date.now().toString(36); // 将时间戳转换为36进制字符串
    const random = Math.random().toString(36).substring(2, 6); // 随机数部分
    return (timestamp + random).slice(-6); // 截取最后6位
}