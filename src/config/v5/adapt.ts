// v5 配置 → 插件内部运行时结构。
//
// 为什么需要这一层：v5 是**面向用户**的配置格式（id 引用、模型嵌套、显式 kind），
// 而下游 `Model.bootstrap` 沿用既有的 `ConnConfigLike[] + ModelRuleTemplate[]`。
// 适配层负责把前者翻成后者，好处是运行时改动面被限制在少数几个字段上。
//
// 规范见 docs/05 模型配置。

import { DeclarableModelTag } from "../../model/catalog";
import type { ConnConfigLike } from "../../model/model";
import type { ModelRuleTemplate } from "../../model/request_rules";
import { ModelUse } from "../../model/types";

import { normalizePurposeList, V5Config, V5Provider } from "./schema";
import { resolveVendor } from "./vendor";

export interface AdaptedV5 {
    conns: ConnConfigLike[];
    rules: ModelRuleTemplate[];
}

/** 模型名 → kind（v5 的 kind 直接对应 v4「api连接」[types] 的可声明值） */
function modelTypesOf(p: V5Provider): Record<string, DeclarableModelTag> {
    const out: Record<string, DeclarableModelTag> = {};
    for (const m of p.models ?? []) {
        if (m.kind) out[m.name] = m.kind as DeclarableModelTag;
    }
    return out;
}

/** 模型名 → 模型 id（供 ModelEntry.ref 用它取代 v4 的 [连接序号]:模型名） */
function modelIdsOf(p: V5Provider): Record<string, string> {
    const out: Record<string, string> = {};
    for (const m of p.models ?? []) out[m.name] = m.id;
    return out;
}

/** 模型名 → 视觉输入覆盖（不同 provider 的图片限制不同；缺省走全局「图片」配置） */
function imageLimitsOf(p: V5Provider): Record<string, { maxSide?: number; targetSide?: number }> {
    const out: Record<string, { maxSide?: number; targetSide?: number }> = {};
    for (const m of p.models ?? []) {
        if (!m.image) continue;
        const limits: { maxSide?: number; targetSide?: number } = {};
        if (typeof m.image.maxSide === 'number') limits.maxSide = m.image.maxSide;
        if (typeof m.image.targetSide === 'number') limits.targetSide = m.image.targetSide;
        if (Object.keys(limits).length > 0) out[m.name] = limits;
    }
    return out;
}

/** 把 v5 的 per-model request 段翻成一条 models 定向的规则 */
function modelRuleOf(modelId: string, req: Record<string, unknown>, bodyMode?: 'merge' | 'replace'): ModelRuleTemplate | null {
    const has = (k: string) => req[k] !== undefined && req[k] !== null && typeof req[k] === 'object';
    if (!has('body') && !has('request') && !has('response') && !has('params') && !has('prompt')) return null;
    const r: ModelRuleTemplate = {
        use: [],
        models: [modelId],
        body: (req.body as Record<string, unknown>) ?? {},
        params: (req.params as Record<string, unknown>) ?? {},
        prompt: (req.prompt as Record<string, unknown>) ?? {},
        request: (req.request as Record<string, unknown>) ?? {},
        response: (req.response as Record<string, unknown>) ?? {},
    };
    if (bodyMode) r.bodyMode = bodyMode;
    return r;
}

/**
 * 把一份合法的 v5 配置翻成运行时结构。
 * 调用前提：配置已通过 `validateV5Config`（本函数不做校验，不再重复报错）。
 */
export function adaptV5(cfg: V5Config): AdaptedV5 {
    const conns: ConnConfigLike[] = [];
    const rules: ModelRuleTemplate[] = [];

    cfg.providers.forEach((p, i) => {
        const models = p.models ?? [];
        conns.push({
            connIndex: i,
            // vendor 在这里定稿：显式声明优先，否则按 baseURL 反查（见 vendor.ts）
            provider: resolveVendor(p.baseURL, p.provider),
            api: p.api,
            apiKey: p.apiKey,
            baseUrl: p.baseURL,
            ignore: p.enabled === false,
            // 空数组/缺省 = 不钉住 → 启动时自动拉取（与 v4 不写 models 等价）
            models: models.length > 0 ? models.map(m => m.name) : null,
            modelTypes: modelTypesOf(p),
            modelIds: modelIdsOf(p),
            imageLimits: imageLimitsOf(p),
            request: (p.request as Record<string, unknown>) ?? {},
        });

        // per-model 覆盖 → models 定向规则（取代 v4 的 models 定向行）
        for (const m of models) {
            if (!m.request) continue;
            const r = modelRuleOf(m.id, m.request as Record<string, unknown>, m.bodyMode);
            if (r) rules.push(r);
        }
    });

    // 用途组默认请求体（v4 的 use 组规则）
    for (const g of cfg.groups ?? []) {
        const r: ModelRuleTemplate = {
            use: (g.purposes as ModelUse[]) ?? [],
            body: (g.body as Record<string, unknown>) ?? {},
            params: (g.params as Record<string, unknown>) ?? {},
            prompt: (g.prompt as Record<string, unknown>) ?? {},
            request: (g.request as Record<string, unknown>) ?? {},
            response: (g.response as Record<string, unknown>) ?? {},
        };
        rules.push(r);
    }

    return { conns, rules };
}

/**
 * 取某用途在 v5 配置里声明的**有序**绑定列表（无则空数组）。
 *
 * 单字符串（手写配置）等价于单元素数组 —— 归一逻辑复用 `normalizePurposeList`，
 * 不在这里再写一份，避免两侧规则漂移。
 */
export function purposeBindings(cfg: V5Config, use: ModelUse): string[] {
    return normalizePurposeList(cfg.purposes?.[use]);
}
