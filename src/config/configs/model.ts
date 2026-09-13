// 模型配置（v4）：两个 TOML 模板 ——「api连接」+「模型规则」。
// - api连接：api_key 必填，provider/base_url 选填（provider 省略时按 OpenAI 兼容处理；base_url 省略时取 provider 默认），
//   + 可选 models（钉住清单，填写后跳过自动拉取）+ 可选 [request]（列表拉取覆盖）；
// - 模型规则：use 数组 + 可选 [body]/[request]，作为“用途组的请求模板”，配置里不出现任何模型名。
// 连接启动时自动拉取可用模型列表（只存内存、不持久化；失败按连接降级展示）；模型名只存在于连接与拉取结果，不进配置。
import { load } from 'js-toml'

import Logger from "../../logger";
import { DeclarableModelTag } from "../../model/catalog";
import { fetchModelList, ListFetchFn } from "../../model/list";
import Model, { ConnConfigLike, isIgnoredConfig } from "../../model/model";
import { ModelRuleTemplate, resetRuleRowsForTest } from "../../model/request_rules";
import { ModelUse } from "../../model/types";
import { revive, TypeDescriptor } from "../../utils/utils";
import { ext } from "../config";
import { PROVIDER_MAP } from "../static_config";

export const MODEL_PURPOSE_OVERRIDES_KEY = 'modelPurposeOverrides';

const API_CONNECTION_CONFIG_KEY = 'api连接';
const MODEL_RULE_CONFIG_KEY = '模型规则';
const CONFIG_GROUP = '模型';

/** 支持的用途全集（use 数组元素校验） */
const VALID_USES: ModelUse[] = ['chat', 'compression', 'summarization', 'judge', 'image-understanding', 'text-embedding'];

// 模型配置属于启动解析一次、重载 JS 才生效的复杂配置（TOML 逐行解析）：模块级缓存，重载 JS 后重新解析
interface ModelConfigData {
    conns: ConnConfigLike[];
    rules: ModelRuleTemplate[];
}
let modelConfigCache: ModelConfigData | null = null;

// 单测可注入的拉取实现（默认走真实网络）
let testFetch: ListFetchFn | null = null;

/** 仅供单元测试使用：清空模块级缓存与规则/注册表，模拟重载 JS 后重新解析模型配置 */
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

export default class ModelConfig {

    static register() {

        seal.ext.registerTemplateConfig(ext, API_CONNECTION_CONFIG_KEY, [
            `# 每框一个 API 连接（TOML）。连接成功加载时自动获取可用模型列表；失败按连接降级（可改用 models 钉住清单或上次成功缓存）。
api_key = "sk-xxxx"                 # 必填，API 密钥
provider = "deepseek"               # 可选，服务商，省略时自动识别
base_url = "https://api.deepseek.com/v1"  # 可选，API 地址，省略时取服务商默认
models = ["deepseek-flash"]               # 可选，模型清单：填写=跳过自动拉取直接用该清单

[types]                                  # 可选，必须写在本框最后（其后不能再写 api_key 等键）：手动声明模型类型，优先级最高
deepseek-flash = "vision"                   # 取值只能填 text/vision/embed；模型名含 . : / 等字符必须加引号；无效值只忽略该键并记日志

# [request]                                  # 可选，列表/余额查询覆盖（默认不写，由插件按 provider 解析）
# list_url = "https://your-gateway/v1/models"    # 自定义列表端点（服务商无 /models 时用）
# auth_header_name = "x-api-key"                  # 缺省 Authorization: Bearer（给了则原样放 key 不拼 Bearer）
# timeout = 10                                    # 秒
# # 余额查询（.ai balance）：deepseek/moonshot/siliconflow 内置端点，无需写任何余额配置
# balance_url = "https://your-gateway/api/user/self"  # 自定义余额端点（one-api/new-api 等网关管理 API 用）
# balance_json_path = "data.quota"                    # 余额数字所在路径（配合 balance_url）
# balance_divisor = 500000                            # 可选，金额 = 取值/除数（new-api 默认 500000/元）
# balance_currency = "CNY"                            # 可选，显示币种（缺省无符号）
`,
            `api_key = "sk-xxxx"                 # 必填，API 密钥
provider = "zhipu"                  # 可选，服务商，省略时自动识别
base_url = "https://open.bigmodel.cn/api/paas/v4"  # 可选，API 地址，省略时取服务商默认
models = ["glm-4v"]               # 可选，模型清单：填写=跳过自动拉取直接用该清单
ignore = 1                         # 可选，1=忽略该条配置，0/不写=正常，使用前删除该行`,
            `api_key = "sk-xxxx"                 # 必填，API 密钥
provider = "alibaba"                # 可选，服务商，省略时自动识别
base_url = "https://dashscope.aliyuncs.com/compatible-mode/v1"  # 可选，API 地址，省略时取服务商默认
models = ["text-embedding-v4"]               # 可选，模型清单：填写=跳过自动拉取直接用该清单
ignore = 1                         # 可选，1=忽略该条配置，0/不写=正常，使用前删除该行`,
        ], `每框一个 API 连接（TOML）。必填：provider（服务商）、api_key（密钥）。可选：base_url（API 地址，省略取服务商默认）、models（模型钉住清单：填写则跳过自动拉取，直接用该清单，适合离线/无列表接口的服务商）、[types]（可选，手动声明模型类型：在本框末尾追加 [types] 表，表内每个模型写一条 "模型名" = "text" / "vision" / "embed"，优先级最高，可覆盖命名猜测与接口自报能力位；模型名含 . : / 等字符必须加引号；必须写在本框最后，其后不能再写 api_key 等键，否则整框解析失败；无效值只忽略该键并记日志）、ignore（1=忽略该连接）。未写 models 的连接启动时自动请求模型列表接口（OpenAI 兼容 GET /models；anthropic 走 x-api-key 的 /v1/models 并自动翻页），失败按连接降级展示，不会拖垮其他连接。下方默认值即完整示例，可直接修改：出厂默认钉住 deepseek-v4-flash，删掉 models 行即改为启动自动拉取。框序 = 连接序号（自上而下，第一个框为 0）；重名模型用 [连接序号]:模型名 区分。修改后需重载 JS 生效。余额查询（.ai balance）：deepseek/moonshot/siliconflow 连接无需配置即可查；其余平台未开放余额接口（仅控制台）；one-api/new-api 等网关可在连接 [request] 里配 balance_url + balance_json_path（配合 auth_header_name/headers）后查询。`, CONFIG_GROUP);
        seal.ext.registerTemplateConfig(ext, MODEL_RULE_CONFIG_KEY, [
            `# 每框一个用途组模板（TOML）：绑定到这些 use 的模型发起请求时统一套用下面的 body/request。
# use 可选值：chat/compression/summarization/judge/image-understanding/text-embedding。
# 默认对话类（chat/压缩/总结/judge）共用对话默认 max_tokens=8192、stop=null、stream=false；本表可覆盖。
# 注意：多条规则 use 重叠时按框顺序逐键合并（后覆盖先）；建议不同框不重叠。

use = ["chat", "compression", "summarization", "judge"]   # 用途组

[body]                              # 可选，请求参数覆盖；默认 max_tokens=8192、stop=null、stream=false
temperature = 1                     # 可选
top_p = 1                           # 可选
max_tokens = 8192                   # 可选
`,
            `use = ["image-understanding"]       # 必填，用途：image-understanding / chat / compression / summarization / judge

[body]                              # 可选，请求参数覆盖；默认 max_tokens=2048、stop=null、stream=false
temperature = 1                     # 可选
max_tokens = 2048                   # 可选`,
            `use = ["text-embedding"]            # 必填，用途：text-embedding

[body]                              # 可选，请求参数覆盖；默认 encoding_format=float、dimensions=1024
dimensions = 1024                   # 可选，输出向量维度，须与后端一致（如 text-embedding-v4 为 1024）`
        ], `每框一个模型规则（TOML）。字段：use（用途数组，必填，可多个：chat/compression/summarization/judge/image-understanding/text-embedding）、[body]（可选，请求参数模板：命中这些用途的模型统一套用；不写时使用代码兜底默认——对话类 max_tokens=8192/stop=null/stream=false，识图 max_tokens=2048，嵌入 encoding_format=float+dimensions=1024）、[request]（可选，调用期覆盖：method/url/headers/content_type/auth_header_name/timeout，默认不写由插件解析）。本表不写任何模型名：模型来自「api连接」的拉取/钉住清单，默认模型仅当某用途候选恰好唯一时才自动生效，其余用途请用 .ai model <用途> <模型> 显式绑定。修改后需重载 JS 生效。`, CONFIG_GROUP);
    }

    static get(): ModelConfigData {
        if (!modelConfigCache) {
            modelConfigCache = buildModelConfig();
            // 把用途覆盖读入内存（供 Model.getChatModel 等使用）
            Model.purposeModelOverrides = loadPurposeModelOverrides();
            // 预热：pinned 立即生效；未钉住连接异步拉取列表（只存内存；首条真实消息/命令前 await Model.ensureLoaded()）
            Model.bootstrap(modelConfigCache.conns, modelConfigCache.rules, {
                fetch: testFetch ?? fetchModelList,
            });
        }
        return modelConfigCache;
    }
}

// -------------------- TOML 解析 --------------------

class ApiConnectionItem {
    static validKeysMap: { [key in keyof ApiConnectionItem]?: TypeDescriptor<ApiConnectionItem[key]> } = {
        provider: 'string',
        api_key: 'string',
        base_url: 'string',
        ignore: 'any',
        models: { array: 'string' },
        types: { objectValue: 'any' },
        request: { objectValue: 'any' },
    }
    provider: string;
    api_key: string;
    base_url: string;
    ignore: any;
    models: string[];
    types: Record<string, any>;
    request: any;
    constructor() {
        this.provider = "";
        this.api_key = "";
        this.base_url = "";
        this.ignore = 0;
        this.models = [];
        this.types = {};
        this.request = {};
    }
}

class ModelRuleItem {
    static validKeysMap: { [key in keyof ModelRuleItem]?: TypeDescriptor<ModelRuleItem[key]> } = {
        use: { array: 'string' },
        body: { objectValue: 'any' },
        request: { objectValue: 'any' },
    }
    use: string[];
    body: any;
    request: any;
    constructor() {
        this.use = [];
        this.body = {};
        this.request = {};
    }
}

function trimLines(list: string[]): string[] {
    return list.map(s => String(s ?? '').trim()).filter(s => s !== '');
}

/** [types] 可声明的类型（内部排除值 gen 不可声明：生图/reranker 仅由命名白名单判定） */
const DECLARABLE_TAGS: DeclarableModelTag[] = ['text', 'vision', 'embed'];

/**
 * 解析一个「api连接」框的 [types] 表：模型名 → 手动声明的类型（优先级最高）。
 * 非法值只忽略该键并记 error 日志，不影响整框连接；模型名含点号未加引号会被 TOML 解析成嵌套表，单独提示。
 */
function parseModelTypes(raw: any, rowIndex: number): Record<string, DeclarableModelTag> {
    const out: Record<string, DeclarableModelTag> = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const key of Object.keys(raw)) {
        const value = raw[key];
        const tag = typeof value === 'string' ? value.trim().toLowerCase() : '';
        if ((DECLARABLE_TAGS as string[]).includes(tag)) {
            out[String(key).trim()] = tag as DeclarableModelTag;
            continue;
        }
        if (value && typeof value === 'object') {
            Logger.error(`「${API_CONNECTION_CONFIG_KEY}」第 ${rowIndex + 1} 框 [types] 的 "${key}" 值非法：模型名含点号时未加引号（被解析成嵌套表），请写作 "模型名" = "embed" 形式，已忽略该键`);
        } else {
            Logger.error(`「${API_CONNECTION_CONFIG_KEY}」第 ${rowIndex + 1} 框 [types] 的 "${key}" 值非法: ${String(value)}（可选 text/vision/embed），已忽略该键`);
        }
    }
    return out;
}

function buildModelConfig(): ModelConfigData {
    // api连接：框序即连接序号（含被忽略的框，保证序号稳定）
    const conns: ConnConfigLike[] = [];
    const rawConnRows = trimLines(seal.ext.getTemplateConfig(ext, API_CONNECTION_CONFIG_KEY));
    rawConnRows.forEach((tomlString, index) => {
        try {
            const item = revive(ApiConnectionItem, load(tomlString));
            const provider = (item.provider || '').trim();
            const apiKey = (item.api_key || '').trim();
            let baseUrl = (item.base_url || '').trim();
            // provider 选填（沿用旧做法：省略时按 OpenAI 兼容处理，此时必须显式填 base_url）
            if (provider === '' && baseUrl === '') throw new Error('缺失 API 地址 base_url（provider 省略时必须填写）');
            if (apiKey === '') throw new Error('缺失 API 密钥 api_key');
            if (baseUrl === '') {
                baseUrl = PROVIDER_MAP?.[provider as keyof typeof PROVIDER_MAP] || '';
                if (baseUrl === '') throw new Error(`未收录该服务商默认地址，请显式填写 base_url（provider=${provider || '(空)'}）`);
            }
            const pinned = Array.isArray(item.models) && item.models.length > 0
                ? item.models.map(m => String(m).trim()).filter(m => m !== '')
                : null;
            conns.push({
                connIndex: index,
                provider,
                apiKey,
                baseUrl,
                ignore: isIgnoredConfig(item.ignore),
                models: pinned && pinned.length > 0 ? pinned : null,
                modelTypes: parseModelTypes(item.types, index),
                request: item.request && typeof item.request === 'object' ? item.request : {},
            });
            Logger.info(`api连接[${index}]解析成功: ${provider} ${baseUrl}${pinned ? '（钉住 ' + pinned.length + ' 个模型）' : ''}`);
        } catch (e) {
            Logger.error(`「${API_CONNECTION_CONFIG_KEY}」第 ${index + 1} 框解析错误，已跳过，内容:${tomlString.slice(0, 200)}，错误:${e instanceof Error ? e.message : String(e)}`);
        }
    });

    // 模型规则：use 数组 + [body]/[request] 模板
    const rules: ModelRuleTemplate[] = [];
    const rawRuleRows = trimLines(seal.ext.getTemplateConfig(ext, MODEL_RULE_CONFIG_KEY));
    rawRuleRows.forEach((tomlString, index) => {
        try {
            const item = revive(ModelRuleItem, load(tomlString));
            const use = (Array.isArray(item.use) ? item.use : [])
                .map(u => String(u).trim() as ModelUse)
                .filter(u => (VALID_USES as string[]).includes(u));
            if (use.length === 0) throw new Error('use 为空或含非法用途');
            rules.push({
                use: Array.from(new Set(use)),
                body: item.body && typeof item.body === 'object' ? item.body : {},
                request: item.request && typeof item.request === 'object' ? item.request : {},
            });
        } catch (e) {
            Logger.error(`「${MODEL_RULE_CONFIG_KEY}」第 ${index + 1} 框解析错误，已跳过，内容:${tomlString.slice(0, 200)}，错误:${e instanceof Error ? e.message : String(e)}`);
        }
    });

    return { conns, rules };
}
