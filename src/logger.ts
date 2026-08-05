// 日志模块：统一日志输出（级别控制 / 密钥脱敏 / 截断 / 异常堆栈）
import Config from "./config/config";
import { NAME } from "./config/static_config";

const MAX_ITEM_LENGTH = 2000; // 单个日志项最大长度
const MAX_MESSAGE_LENGTH = 300; // 请求上下文正文日志截断长度

const LEVEL_ORDER: { [key: string]: number } = {
    "从不": 0,
    "错误": 1,
    "警告": 2,
    "信息": 3,
    "调试": 4
};

export default class Logger {
    private static formatItem(item: any): string {
        if (item instanceof Error) {
            return `${item.name}: ${item.message}`;
        }
        if (typeof item === 'string') {
            return item.length > MAX_ITEM_LENGTH
                ? item.slice(0, MAX_ITEM_LENGTH) + `…(+${item.length - MAX_ITEM_LENGTH})`
                : item;
        }
        try {
            const s = JSON.stringify(item);
            if (!s) return `${item}`;
            return s.length > MAX_ITEM_LENGTH
                ? s.slice(0, MAX_ITEM_LENGTH) + `…(+${s.length - MAX_ITEM_LENGTH})`
                : s;
        } catch (_e) {
            return `${item}`;
        }
    }

    static handleLogData(...data: any[]): string {
        const { LOG_SHORT_PRINT } = Config.base;
        let s = data.map(item => this.formatItem(item)).join(" ");
        // 脱敏：掩盖常见密钥字段与 Bearer token
        s = s.replace(/(["']?(?:api[_-]?key|token|authorization|secret|password)["']?\s*[:=]\s*["']?)[^"'\s,}]{6,}/gi, '$1***');
        s = s.replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1***');
        if (LOG_SHORT_PRINT && s.length > 1000) {
            return s.substring(0, 500) + "\n...\n" + s.substring(s.length - 500);
        }
        return s;
    }

    private static emit(level: string, method: 'log' | 'info' | 'warn' | 'error', ...data: any[]) {
        const { LOG_LEVEL } = Config.base;
        const current = LEVEL_ORDER[LOG_LEVEL] ?? 3;
        const need = LEVEL_ORDER[level] ?? 3;
        if (current < need) return;
        const s = this.handleLogData(...data);
        if (!s) return;
        console[method](`【${NAME}】[${level}] ${s}`);
    }

    static debug(...data: any[]) { this.emit('调试', 'info', ...data); }
    static info(...data: any[]) { this.emit('信息', 'log', ...data); }
    static warning(...data: any[]) { this.emit('警告', 'warn', ...data); }
    static error(...data: any[]) { this.emit('错误', 'error', ...data); }

    /** 记录异常：消息进 error，堆栈进 debug（调试级别可见） */
    static exception(label: string, e: any) {
        const message = e && e.message ? e.message : `${e}`;
        this.error(`${label}: ${message}`);
        if (e && e.stack) this.debug(`${label} 堆栈:\n${e.stack}`);
    }

    /** 请求上下文日志：受“日志记录消息内容”开关控制，正文截断，默认不打印 system */
    static printRequestMessages(messages: any[]) {
        if (!messages) return;
        const { LOG_MESSAGE_CONTENT } = Config.base;
        const filtered = messages.filter(item => item.role !== "system");
        if (filtered.length === 0) return;

        const summary = filtered.map(m => {
            const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
            const toolCalls = (m.tool_calls && m.tool_calls.length) || 0;
            if (!LOG_MESSAGE_CONTENT) {
                return { role: m.role, length: content.length, toolCalls };
            }
            const truncated = content.length > MAX_MESSAGE_LENGTH
                ? content.slice(0, MAX_MESSAGE_LENGTH) + `…(+${content.length - MAX_MESSAGE_LENGTH})`
                : content;
            return { role: m.role, content: truncated, toolCalls };
        });
        this.info(`请求上下文:\n`, JSON.stringify(summary));
    }
}
export const logger = Logger;
