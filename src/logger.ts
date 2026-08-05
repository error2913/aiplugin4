// 日志模块：统一封装 seal 插件日志输出（debug/info/warning/error）
import Config from "./config/config";
import { NAME } from "./config/static_config";

export default class Logger {
    static handleLogData(...data: any[]): string {
        const { LOG_SHORT_PRINT } = Config.base;
        if (!LOG_SHORT_PRINT) return data.map(item => `${item}`).join(" ");
        const s = data.map(item => `${item}`).join(" ");
        if (s.length > 1000) return s.substring(0, 500) + "\n...\n" + s.substring(s.length - 500);
        return s;
    }

    static debug(...data: any[]) {
        const { LOG_LEVEL } = Config.base;
        if (LOG_LEVEL === "从不" || LOG_LEVEL === "错误" || LOG_LEVEL === "警告" || LOG_LEVEL === "信息") return;
        const s = this.handleLogData(...data);
        if (!s) return;
        console.info(`【${NAME}】 ${s}`);
    }

    static info(...data: any[]) {
        const { LOG_LEVEL } = Config.base;
        if (LOG_LEVEL === "从不" || LOG_LEVEL === "错误" || LOG_LEVEL === "警告") return;
        const s = this.handleLogData(...data);
        if (!s) return;
        console.log(`【${NAME}】 ${s}`);
    }

    static warning(...data: any[]) {
        const { LOG_LEVEL } = Config.base;
        if (LOG_LEVEL === "从不" || LOG_LEVEL === "错误") return;
        const s = this.handleLogData(...data);
        if (!s) return;
        console.warn(`【${NAME}】 ${s}`);
    }

    static error(...data: any[]) {
        const { LOG_LEVEL } = Config.base;
        if (LOG_LEVEL === "从不") return;
        const s = this.handleLogData(...data);
        if (!s) return;
        console.error(`【${NAME}】 ${s}`);
    }

    static printRequestMessages(messages: any[]) {
        if (!messages) return;
        const filteredMessages = messages.filter(item => item.role !== "system");
        if (filteredMessages.length === 0) return;
        this.info(`请求上下文:\n`, JSON.stringify(filteredMessages));
    }
}
export const logger = Logger;
