// 模型规则：use 组模板（body/request）。按“用途组”给命中该用途的模型统一套用请求参数。
// 纯模块：不依赖 seal / Config（仅引用静态 body 默认常量），便于单元测试。
// 语义：bodyDefaultsFor(use) = 代码兜底默认 < 规则模板 body（多条命中按行序逐键覆盖）；
//       requestOverridesFor(use) = 规则模板 request 合并（多条命中按行序逐键覆盖）。
import {
    DEFAULT_CHAT_MODEL_BODY,
    DEFAULT_EMBEDDING_MODEL_BODY,
    DEFAULT_MULTIMODAL_MODEL_BODY,
} from "../config/static_config";

import { ModelBody, ModelUse } from "./types";

/** 一条模型规则：命中这些 use 的请求使用同一组 body/request */
export interface ModelRuleTemplate {
    use: ModelUse[];
    body: ModelBody;
    request: Record<string, any>;
}

let ruleRows: ModelRuleTemplate[] = [];

export function setRuleRows(rows: ModelRuleTemplate[]): void {
    ruleRows = rows;
}

export function getRuleRows(): ModelRuleTemplate[] {
    return ruleRows;
}

/** 用途 → 代码兜底默认请求体（模板未覆盖/用户删光规则行时仍然生效，与旧行为一致） */
function classDefaultBody(use: ModelUse): Record<string, any> {
    if (use === 'text-embedding') return { ...DEFAULT_EMBEDDING_MODEL_BODY };
    if (use === 'image-understanding') return { ...DEFAULT_MULTIMODAL_MODEL_BODY };
    // chat / compression / summarization / judge 共用对话默认
    return { ...DEFAULT_CHAT_MODEL_BODY };
}

function mergeInto(target: any, src: any): any {
    if (src && typeof src === 'object') {
        for (const k of Object.keys(src)) {
            const v = (src as any)[k];
            if (v === undefined) continue;
            target[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...(target[k] ?? {}), ...v } : v;
        }
    }
    return target;
}

/**
 * 某用途合并后的 body 默认值（不含调用方显式参数）。
 * 优先级：代码兜底默认 < 规则模板 body（行序，后覆盖先）
 */
export function bodyDefaultsFor(use: ModelUse): any {
    let out: any = classDefaultBody(use);
    for (const row of ruleRows) {
        if (row.use.includes(use)) out = mergeInto(out, row.body);
    }
    return out;
}

/**
 * 某用途合并后的 request 覆盖（headers/auth_header_name/content_type/timeout 等）。
 * 未命中任何规则行时返回 null（完全按 provider 默认行为请求）。
 */
export function requestOverridesFor(use: ModelUse): Record<string, any> | null {
    let merged: Record<string, any> | null = null;
    for (const row of ruleRows) {
        if (row.use.includes(use) && row.request && typeof row.request === 'object') {
            merged = merged ?? {};
            for (const k of Object.keys(row.request)) {
                if (k === 'headers' && row.request.headers && typeof row.request.headers === 'object') {
                    merged.headers = { ...(merged.headers ?? {}), ...row.request.headers };
                } else {
                    merged[k] = row.request[k];
                }
            }
        }
    }
    return merged;
}

export function resetRuleRowsForTest(): void {
    ruleRows = [];
}
