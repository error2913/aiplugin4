import { NAME } from "./config/static_config";
import Config from "./config/config";

export default class Logger {
    static handleLog(...data: any[]): string {
        const { LOG_LEVEL: logLevel } = Config.base;
        if (logLevel === "永不") {
            return '';
        } else if (logLevel === "简短") {
            const s = data.map(item => `${item}`).join(" ");
            if (s.length > 1000) {
                return s.substring(0, 500) + "\n...\n" + s.substring(s.length - 500);
            } else {
                return s;
            }
        } else if (logLevel === "详细" || logLevel === "调试") {
            return data.map(item => `${item}`).join(" ");
        } else {
            return '';
        }
    }

    static info(...data: any[]) {
        const s = this.handleLog(...data);
        if (!s) {
            return;
        }
        console.log(`【${NAME}】: ${s}`);
    }

    static warning(...data: any[]) {
        const s = this.handleLog(...data);
        if (!s) {
            return;
        }
        console.warn(`【${NAME}】: ${s}`);
    }

    static error(...data: any[]) {
        const s = this.handleLog(...data);
        if (!s) {
            return;
        }
        console.error(`【${NAME}】: ${s}`);
    }

    static debug(...data: any[]) {
        const { LOG_LEVEL: logLevel } = Config.base;
        if (logLevel !== "调试") return;
        const s = this.handleLog(...data);
        if (!s) {
            return;
        }
        console.info(`【${NAME}】: ${s}`);
    }

    static logMessages(body: any) {
        if (body.hasOwnProperty('messages')) {
            const messages = body.messages.filter(item => item.role !== "system");
            if (messages.length === 0) return;
            this.info(`请求发送前的上下文:\n`, JSON.stringify(messages));
        }
    }
}