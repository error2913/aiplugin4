// 日志模块：统一日志输出（级别控制 / 密钥脱敏 / 截断 / 异常堆栈 / 分类标签）
import { NAME } from "./config/static_config";

const MAX_ITEM_LENGTH = 2000; // 单个日志项最大长度
const MAX_MESSAGE_LENGTH = 300; // 请求上下文正文日志截断长度

// 日志开关由 config 层注入 provider，而不是启动时快照：
// 面板改「日志级别/简短打印/记录消息内容」后，必须沿用 Config.base 的 60s TTL 语义在运行中生效。
// logger 不 import config，避免 config ↔ logger 循环依赖（provider 内部才读 Config）。
// 初始值与 configs/base.ts 的出厂默认一致。
const DEFAULT_LOG_CONFIG: Required<LoggerConfig> = {
    level: '信息',
    shortPrint: true,
    messageContent: true,
};

export interface LoggerConfig {
    level?: string;
    shortPrint?: boolean;
    messageContent?: boolean;
}

let logConfigProvider: (() => LoggerConfig) | null = null;
let providerErrorLogged = false;

/** 由 config 层调用：注入/清除日志开关来源（provider 应读取带 TTL 缓存的配置访问器） */
export function setLoggerConfigProvider(provider: (() => LoggerConfig) | null): void {
    logConfigProvider = provider;
}

/** 解析当前日志开关：provider 未注入（启动早期）或抛错时回退出厂默认值 */
function resolveLogConfig(): Required<LoggerConfig> {
    if (!logConfigProvider) return DEFAULT_LOG_CONFIG;
    try {
        return { ...DEFAULT_LOG_CONFIG, ...logConfigProvider() };
    } catch (e) {
        // 只报一次，避免日志风暴；同时不让配置读取异常变成静默降级（排障需要线索）
        if (!providerErrorLogged) {
            providerErrorLogged = true;
            console.error(`【${NAME}】[WARN] 读取日志配置失败，已回退出厂默认值:`, e);
        }
        return DEFAULT_LOG_CONFIG;
    }
}

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
        const { shortPrint: LOG_SHORT_PRINT } = resolveLogConfig();
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
        const { level: LOG_LEVEL } = resolveLogConfig();
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
        const { messageContent: LOG_MESSAGE_CONTENT } = resolveLogConfig();
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
