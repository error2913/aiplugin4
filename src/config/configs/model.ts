// 模型配置（v5）：单个 JSON 框承载全部模型配置。
//
// 规范见 docs/05 模型配置。**取代**（而非兼容）v4 的「api连接」+「模型规则」两个 TOML 框：
// 旧的两项已注销，不读取、不迁移、不兼容 —— 理由见 buildModelConfig 的注释。
//
// 解析流程（方案 3.1）：
//   1. 读「模型配置」→ parseV5Config（JSON 语法 + 结构校验，带 $.a.b[0].c 路径报错）
//   2. 配置为空 → 出厂最小示例（并提示老用户用配置生成器重建）
// 校验失败一律**整体拒绝**（不做"部分生效"），并给出全部问题。
import Logger from "../../logger";
import { DeclarableModelTag } from "../../model/catalog";
import { fetchModelList, ListFetchFn } from "../../model/list";
import Model, { ConnConfigLike } from "../../model/model";
import { ModelRuleTemplate, resetRuleRowsForTest } from "../../model/request_rules";
import { ModelUse } from "../../model/types";
import { ext } from "../ext";
import { adaptV5 } from "../v5/adapt";
import { DEFAULT_V5_CONFIG } from "../v5/default";
import { formatIssues, normalizePurposeList, parseV5Config, V5Config, V5Issue } from "../v5/schema";

import { GENERATOR_CONFIG_HINT } from "./generator_hint";

export const MODEL_PURPOSE_OVERRIDES_KEY = 'modelPurposeOverrides';

/** v5 配置项名 */
const MODEL_CONFIG_KEY = '模型配置';
/** v4 遗留配置项名（仅用于**注销**，不再读取） */
const LEGACY_CONN_KEY = 'api连接';
const LEGACY_RULE_KEY = '模型规则';
const CONFIG_GROUP = '模型';

// 出厂默认见 ../v5/default.ts（纯数据，单独成文件以便集成联测直接引用）
export { DEFAULT_V5_CONFIG };



// 模型配置属于启动解析一次、重载 JS 才生效的复杂配置：模块级缓存
export interface ModelConfigData {
    conns: ConnConfigLike[];
    rules: ModelRuleTemplate[];
    /**
     * v5 配置里的用途绑定，**有序数组**（下标越小越优先）。
     *
     * 语义是"优先用这些，按此顺序"，不是"只允许这些"：未列出的同类型模型仍在候选池里，
     * 排在列出的之后。插件按这个顺序取用 —— 首选正常用，失败时顺着顺序往后切
     * （见 agent.ts 的 pickFallbackModel）。
     *
     * 这是**持久默认层**；storage 的 `.ai model` 覆盖优先级更高（那个仍是单个 = "当前用哪个"）。
     */
    purposes: Partial<Record<ModelUse, string[]>>;
    /** 校验问题（非空表示配置被拒绝，conns/rules 为空） */
    issues: V5Issue[];
}

let modelConfigCache: ModelConfigData | null = null;

// 单测可注入的拉取实现（默认走真实网络）
let testFetch: ListFetchFn | null = null;

/** 仅供单元测试使用：清空模块级缓存与规则/注册表 */
export function resetModelConfigCacheForTest(): void {
    modelConfigCache = null;
    testFetch = null;
    resetRuleRowsForTest();
    Model.reset();
}

/** 供单元测试注入列表拉取桩 */
export function setModelListDepsForTest(opts?: { fetch?: ListFetchFn }): void {
    testFetch = opts?.fetch ?? null;
}

export function loadPurposeModelOverrides(): Partial<Record<ModelUse, string>> {
    try {
        const raw = ext.storageGet(MODEL_PURPOSE_OVERRIDES_KEY);
        if (!raw) return {};
        const data = JSON.parse(raw);
        return data && typeof data === 'object' ? data : {};
    } catch (e) {
        Logger.error(`读取全局模型覆盖失败: ${e instanceof Error ? e.message : String(e)}`);
        return {};
    }
}

export function savePurposeModelOverrides(): void {
    ext.storageSet(MODEL_PURPOSE_OVERRIDES_KEY, JSON.stringify(Model.purposeModelOverrides));
}

/** 安全读字符串配置：未注册/类型不符时返回 ''，不让插件启动崩掉 */
function readStringConfig(key: string): string {
    try {
        return seal.ext.getStringConfig(ext, key) ?? '';
    } catch (e) {
        Logger.error(`读取配置项「${key}」失败: ${e instanceof Error ? e.message : String(e)}`);
        return '';
    }
}

const nonEmpty = (s: string) => String(s ?? '').trim() !== '';

/** 由 v5 配置对象构建运行时数据 */
function fromV5(config: V5Config): ModelConfigData {
    const { conns, rules } = adaptV5(config);
    // 用途绑定归一成**有序数组**：单字符串（手写配置常见）等价于单元素数组。
    // 归一放在这一层，下游（Model.configPurposes / listModelsForUse）就只需处理一种形状。
    const purposes: Partial<Record<ModelUse, string[]>> = {};
    for (const [k, v] of Object.entries(config.purposes ?? {})) {
        const list = normalizePurposeList(v as string[] | string);
        if (list.length > 0) purposes[k as ModelUse] = list;
    }
    return { conns, rules, purposes, issues: [] };
}

function rejected(issues: V5Issue[]): ModelConfigData {
    Logger.error(`「${MODEL_CONFIG_KEY}」校验失败（共 ${issues.length} 处），本次不生效：\n${formatIssues(issues)}`);
    Logger.error(`提示：可用配置生成器生成后粘贴，避免手写格式问题。`);
    return { conns: [], rules: [], purposes: {}, issues };
}

/**
 * 解析模型配置。**只有一条路径**：读「模型配置」→ 校验 → 构建。
 *
 * 为什么没有 v4 兼容/迁移（方案 §1.1、§8）：
 *   `seal.ext` 没有配置写入 API —— 迁移的本质是"读旧→转换→**写新**"，
 *   而第三步永远做不到。所谓"迁移"只能退化成每次启动都跑一遍的兼容垫片：
 *   旧配置删不掉、旧依赖永久保留、用户也看不到转换结果（因此无法编辑它）。
 *   既然永远无法自我完成，就不做成兼容；旧配置直接不再读取。
 *
 * 旧的两个模板框（api连接/模型规则）在 register() 里**注销**，UI 上不再出现。
 * 老用户升级后会看到出厂示例，需要通过配置生成器重新生成一份（见下方空配置的日志提示）。
 */
function buildModelConfig(): ModelConfigData {
    const text = readStringConfig(MODEL_CONFIG_KEY);
    if (nonEmpty(text)) {
        const { config, issues } = parseV5Config(text);
        if (config) return fromV5(config);
        return rejected(issues);
    }

    // 配置为空 → 出厂默认
    const { config, issues } = parseV5Config(DEFAULT_V5_CONFIG);
    if (!config) {
        // 出厂默认自身不合法属于代码 bug，必须显式暴露
        Logger.error(`出厂默认配置不合法（这是插件 bug）：\n${formatIssues(issues)}`);
        return rejected(issues);
    }
    Logger.warning(`「${MODEL_CONFIG_KEY}」为空，已载入出厂示例（DeepSeek，apiKey 是占位符）。`);
    Logger.warning(`请填入真实 apiKey；**若你从旧版本升级**：旧的「${LEGACY_CONN_KEY}」/「${LEGACY_RULE_KEY}」`
        + `自 v5 起不再读取（海豹不提供配置写入能力，插件无法自动迁移），请用配置生成器重新生成一份后粘贴。`);
    return fromV5(config);
}

export default class ModelConfig {

    static register() {
        seal.ext.registerStringConfig(ext, MODEL_CONFIG_KEY, DEFAULT_V5_CONFIG, GENERATOR_CONFIG_HINT, CONFIG_GROUP);
    }

    static get(): ModelConfigData {
        if (!modelConfigCache) {
            modelConfigCache = buildModelConfig();
            // 运行时覆盖（.ai model 写入的）优先于配置里的持久默认
            Model.purposeModelOverrides = loadPurposeModelOverrides();
            Model.configPurposes = { ...modelConfigCache.purposes };
            Model.bootstrap(modelConfigCache.conns, modelConfigCache.rules, {
                fetch: testFetch ?? fetchModelList,
            });
        }
        return modelConfigCache;
    }
}

// 供 .ai model 展示用
export { MODEL_CONFIG_KEY, LEGACY_CONN_KEY, LEGACY_RULE_KEY };
export type { DeclarableModelTag };
