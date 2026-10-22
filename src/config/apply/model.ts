// 模型配置的应用层：把「解析结果」落到模型注册表（Model.bootstrap / 用途绑定 / 运行时覆盖）。
// 从 configs/model.ts 拆出，使配置段保持纯解析、不 import 模型实现（拆掉 config → model → config 环）。
import { getHost } from "../../core/host";
import Logger from "../../logger";
import { fetchModelList } from "../../model/list";
import type { ListFetchFn } from "../../model/list";
import Model from "../../model/model";
import { resetRuleRowsForTest } from "../../model/request_rules";
import type { ModelUse } from "../../model/types";
import { clearModelConfigCacheForTest, MODEL_PURPOSE_OVERRIDES_KEY } from "../configs/model";
import type { ModelConfigData } from "../configs/model";

// 单测可注入的拉取实现（默认走真实网络）
let testFetch: ListFetchFn | null = null;

/** 读取运行时覆盖（.ai model 写入的「当前用哪个」），持久化在宿主存储里 */
export function loadPurposeModelOverrides(): Partial<Record<ModelUse, string>> {
    try {
        const raw = getHost().storage.get(MODEL_PURPOSE_OVERRIDES_KEY);
        if (!raw) return {};
        const data = JSON.parse(raw);
        return data && typeof data === 'object' ? data : {};
    } catch (e) {
        Logger.error(`读取全局模型覆盖失败: ${e instanceof Error ? e.message : String(e)}`);
        return {};
    }
}

export function savePurposeModelOverrides(): void {
    getHost().storage.set(MODEL_PURPOSE_OVERRIDES_KEY, JSON.stringify(Model.purposeModelOverrides));
}

// 已应用过的解析结果（按对象引用判断）：Config 的 60s TTL 会让 getCache 再次执行钩子，
// 但 configs/model 的解析缓存未清时数据还是同一个对象——此时不应重复 Model.bootstrap
// （否则会重置连接状态并周期性重新拉取模型列表）。
let appliedConfig: ModelConfigData | null = null;

/** 配置读取钩子：把解析好的模型配置应用到 Model 注册表；返回原数据供 Config.model 使用 */
export function applyModelConfig(data: ModelConfigData): ModelConfigData {
    if (appliedConfig === data) return data;
    appliedConfig = data;
    // 运行时覆盖优先于配置里的持久默认
    Model.purposeModelOverrides = loadPurposeModelOverrides();
    Model.configPurposes = { ...data.purposes };
    Model.bootstrap(data.conns, data.rules, { fetch: testFetch ?? fetchModelList });
    return data;
}

/** 仅供单元测试：清空配置缓存 + 规则表 + 模型注册表；下次读 Config.model 会重新解析并应用 */
export function resetModelConfigCacheForTest(): void {
    appliedConfig = null;
    clearModelConfigCacheForTest();
    testFetch = null;
    resetRuleRowsForTest();
    Model.reset();
}

/** 供单元测试注入列表拉取桩 */
export function setModelListDepsForTest(opts?: { fetch?: ListFetchFn }): void {
    testFetch = opts?.fetch ?? null;
}
