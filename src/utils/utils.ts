import { ConfigManager } from "../config/config";

export function log(...data: any[]) {
    const { isLog } = ConfigManager.log;

    if (isLog) {
        console.log(...data);
    }
}

export function generateId() {
    const timestamp = Date.now().toString(36); // 将时间戳转换为36进制字符串
    const random = Math.random().toString(36).substring(2, 6); // 随机数部分
    return (timestamp + random).slice(-6); // 截取最后6位
}