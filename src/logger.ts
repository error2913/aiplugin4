// 日志模块：统一日志输出（级别控制 / 密钥脱敏 / 截断 / 异常堆栈 / 分类标签）
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

/** 中文级别 -> 控制台方法（决定海豹面板颜色/筛选）与短标签（便于关键字过滤） */
const LEVEL_META: { [key: string]: { method: 'log' | 'info' | 'warn' | 'error' | 'debug', tag: string } } = {
    "错误": { method: 'error', tag: 'ERROR' },
    "警告": { method: 'warn', tag: 'WARN' },
    "信息": { method: 'info', tag: 'INFO' },
    "调试": { method: 'debug', tag: 'DEBUG' }
};

export interface TaggedLogger {
    debug(...data: any[]): void;
    info(...data: any[]): void;
    warning(...data: any[]): void;
    error(...data: any[]): void;
    exception(label: string, e: any): void;
    printRequestMessages(messages: any[], runId?: string): void;
}

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
        // 脱敏：掩盖常见密钥字段、URL query 参数、Bearer token 与 sk- 前缀密钥
        s = s.replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|authorization|signature|sig|secret|password|app[_-]?secret|appkey)["']?\s*[:=]\s*["']?)([^"'\s,}&]{6,})/gi, '$1***');
        s = s.replace(/([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|signature|sig|secret|password|authorization|appkey)=)[^&\s]{6,}/gi, '$1***');
        s = s.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1***');
        s = s.replace(/(sk-[A-Za-z0-9]{6,})/gi, 'sk-***');
        if (LOG_SHORT_PRINT && s.length > 1000) {
            return s.substring(0, 500) + "\n...\n" + s.substring(s.length - 500);
        }
        return s;
    }

    private static emit(level: string, ...data: any[]) {
        const { LOG_LEVEL } = Config.base;
        const current = LEVEL_ORDER[LOG_LEVEL] ?? 3;
        const need = LEVEL_ORDER[level] ?? 3;
        if (current < need) return;
        const s = this.handleLogData(...data);
        if (!s) return;
        const meta = LEVEL_META[level] || { method: 'info' as const, tag: 'INFO' };
        const fn = (console as any)[meta.method] || console.log;
        fn.call(console, `【${NAME}】[${meta.tag}] ${s}`);
    }

    static debug(...data: any[]) { this.emit('调试', ...data); }
    static info(...data: any[]) { this.emit('信息', ...data); }
    static warning(...data: any[]) { this.emit('警告', ...data); }
    static error(...data: any[]) { this.emit('错误', ...data); }

    /** 记录异常：消息进 error，堆栈进 debug（调试级别可见） */
    static exception(label: string, e: any) {
        const message = e && e.message ? e.message : `${e}`;
        this.error(`${label}: ${message}`);
        if (e && e.stack) this.debug(`${label} 堆栈:\n${e.stack}`);
    }

    /** 带分类标签的日志入口：logger.withTag('agent').info(...) → 【AI骰娘4】[INFO] [agent] ... */
    static withTag(tag: string): TaggedLogger {
        const prefix = `[${tag}]`;
        return {
            debug: (...data: any[]) => this.emit('调试', prefix, ...data),
            info: (...data: any[]) => this.emit('信息', prefix, ...data),
            warning: (...data: any[]) => this.emit('警告', prefix, ...data),
            error: (...data: any[]) => this.emit('错误', prefix, ...data),
            exception: (label: string, e: any) => this.exception(`${prefix} ${label}`, e),
            printRequestMessages: (messages: any[], runId?: string) => this.printRequestMessages(messages, runId),
        };
    }

    /** 请求上下文日志：受“日志记录消息内容”开关控制，正文截断，默认不打印 system */
    static printRequestMessages(messages: any[], runId: string = '') {
        if (!messages) return;
        const { LOG_MESSAGE_CONTENT } = Config.base;
        const filtered = messages.filter(item => item.role !== "system");
        if (filtered.length === 0) return;

        const entries = filtered.map(m => {
            const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
            const toolCalls = (m.tool_calls && m.tool_calls.length) || 0;
            return { role: m.role, content, toolCalls };
        });

        const run = runId ? ` run=${runId}` : '';
        this.info(`[请求上下文]${run} 共${entries.length}条`);
        entries.forEach((m, i) => {
            const base = `[req ${i + 1}/${entries.length}] role=${m.role} len=${m.content.length} toolCalls=${m.toolCalls}`;
            if (!LOG_MESSAGE_CONTENT) {
                this.debug(base);
                return;
            }
            const truncated = m.content.length > MAX_MESSAGE_LENGTH
                ? m.content.slice(0, MAX_MESSAGE_LENGTH) + `…(+${m.content.length - MAX_MESSAGE_LENGTH})`
                : m.content;
            this.debug(`${base} content=${truncated}`);
        });
    }

    /** 分段打印长文本，避免日志截断丢失内容；分片以 [第x段/总段数] 标注 */
    static logLong(label: string, text: string, chunkSize = 1500) {
        if (!text) return;
        const total = Math.max(1, Math.ceil(text.length / chunkSize));
        if (total === 1) {
            this.info(label, text);
            return;
        }
        for (let i = 0; i < text.length; i += chunkSize) {
            const part = Math.floor(i / chunkSize) + 1;
            this.info(`${label}[${part}/${total}]:`, text.slice(i, i + chunkSize));
        }
    }
}
export const logger = Logger;
