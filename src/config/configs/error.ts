// 报错自动处理配置：分类错误的总开关/动作开关/自动切换参数
import Logger from "../../logger";
import { ApiErrorKind, isApiErrorKind } from "../../model/api_error";
import { ext } from "../config";

export interface ErrorAutoConfig {
    /** 启用报错自动处理总开关 */
    ENABLED: boolean;
    /** 上下文超长：观察归档删除后自动重发 */
    CONTEXT_ARCHIVE_RETRY: boolean;
    /** 余额不足等：自动切换备用模型 */
    AUTO_SWITCH_MODEL: boolean;
    /** 触发自动切换的错误类别（白名单），如 balance/permission */
    SWITCH_KINDS: ApiErrorKind[];
    /** 备用模型选择策略：cross=优先跨厂商；order=按配置顺序 */
    SWITCH_STRATEGY: 'cross' | 'order';
    /** 自动切换时是否用 ctx.notice 发送通知 */
    SWITCH_NOTIFY: boolean;
}

const DEFAULT_SWITCH_KINDS: ApiErrorKind[] = ['balance'];

/** 供测试清缓存使用（Config.cache 已在测试侧整体清空，无需额外缓存） */
export function normalizeSwitchKinds(lines: string[]): ApiErrorKind[] {
    const kinds: ApiErrorKind[] = [];
    for (const line of lines || []) {
        const k = String(line || '').trim() as ApiErrorKind;
        if (isApiErrorKind(k) && k !== 'unknown' && !kinds.includes(k)) kinds.push(k);
    }
    return kinds.length > 0 ? kinds : DEFAULT_SWITCH_KINDS;
}

export default class ErrorConfig {
    static register() {
        seal.ext.registerBoolConfig(ext, "启用报错自动处理", true, "模型请求报错时按语义类别自动处理（上下文超长归档重试 / 余额不足切模型 / 限速退避等），未覆盖或无法处理的错误仅记日志不回复", "错误处理");
        seal.ext.registerBoolConfig(ext, "上下文超长自动归档重试", true, "模型返回上下文超长时，把会话历史按「观察归档+删除」链路压到模型窗口内后自动重发一次；关闭则该场景仅记日志", "错误处理");
        seal.ext.registerBoolConfig(ext, "余额不足自动切换模型", true, "对话模型报余额不足/欠费/额度用尽时，自动把 chat 用途切换到备用模型（写入全局模型覆盖，管理员可 .ai model 改回）", "错误处理");
        seal.ext.registerTemplateConfig(ext, "自动切换触发错误", ['balance'], "每行一个触发自动切换模型的错误类别：balance（余额不足）/permission（权限不足）；其余类别仅退避重试或记日志", "错误处理");
        seal.ext.registerOptionConfig(ext, "自动切换策略", "跨厂商优先", ["跨厂商优先", "配置顺序"], "跨厂商优先=优先切到不同服务商的模型；配置顺序=按纯文本模型列表顺序取下一个不同模型", "错误处理");
        seal.ext.registerBoolConfig(ext, "切换后发送通知", true, "自动切换模型后用 ctx.notice 向当前会话发送一条切换通知", "错误处理");
    }

    static get(): ErrorAutoConfig {
        try {
            const strategyRaw = seal.ext.getOptionConfig(ext, "自动切换策略");
            const switchLines = seal.ext.getTemplateConfig(ext, "自动切换触发错误");
            return {
                ENABLED: seal.ext.getBoolConfig(ext, "启用报错自动处理"),
                CONTEXT_ARCHIVE_RETRY: seal.ext.getBoolConfig(ext, "上下文超长自动归档重试"),
                AUTO_SWITCH_MODEL: seal.ext.getBoolConfig(ext, "余额不足自动切换模型"),
                SWITCH_KINDS: normalizeSwitchKinds(switchLines),
                SWITCH_STRATEGY: strategyRaw === '配置顺序' ? 'order' : 'cross',
                SWITCH_NOTIFY: seal.ext.getBoolConfig(ext, "切换后发送通知")
            };
        } catch (e) {
            Logger.error(`读取错误处理配置失败: ${e instanceof Error ? e.message : String(e)}`);
            return {
                ENABLED: true,
                CONTEXT_ARCHIVE_RETRY: true,
                AUTO_SWITCH_MODEL: true,
                SWITCH_KINDS: DEFAULT_SWITCH_KINDS,
                SWITCH_STRATEGY: 'cross',
                SWITCH_NOTIFY: true
            };
        }
    }
}
