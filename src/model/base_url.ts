import { PROVIDER_MAP } from "../config/static_config/providers";

// baseURL 的理解与归一化 —— 媒体/对话请求组装的**地基**。
//
// 为什么需要这一层（这是此前一直缺的）：
// 插件原先一律把预设的 `urlSuffix` **盲目拼在用户给的 baseURL 后面**，隐含假定
// "你填的就是该厂商的规范基址"。但用户实际粘贴的形态至少有五种：
//
//   https://host                              根
//   https://host/v1                           带版本前缀
//   https://host/compatible-mode/v1           兼容模式前缀
//   https://host/v1beta/openai                网关风格前缀
//   https://host/v1/chat/completions          完整端点（从厂商文档复制的就是这种）
//
// 于是同一份预设在不同形态下拼出五花八门的结果：完整端点会变成
// `.../v1/chat/completions/audio/speech`，根形态会丢掉 `/v1`。
// 实测：96 个「厂商 × 形态」组合里 33 个是错的。
//
// 本模块把 baseURL 解析成 `{ origin, prefix, rest }`，让上层能：
//   · 用 `{origin}` 表达"挂在主机根的原生端点"（与用户填的路径前缀无关）
//   · 把"完整端点"归一化回版本前缀（用户从文档复制完整 URL 也能直接用）
//
// 纯函数、零依赖 —— 便于单测，也不依赖 goja 的全局对象（**不能用 `new URL`**）。

/** 解析结果 */
export interface BaseUrlParts {
    /** 协议 + 主机 + 端口，不含路径。如 `https://api.deepseek.com` */
    origin: string;
    /** 版本前缀，如 `/v1`、`/compatible-mode/v1`、`/api/v1`、`/v1beta/openai`；无则 `''` */
    prefix: string;
    /** 前缀之后剩下的路径（**非空说明用户粘的是完整端点**），如 `/chat/completions` */
    rest: string;
}

/** 版本段：`v1` / `v2beta` / `v1beta1` / `v4` … */
const VERSION_SEG_RE = /^v\d/i;
/** 版本段之后允许再跟一个模式标记段（`/v1beta/openai` 这种网关风格） */
const MODE_SEGS = new Set(['openai', 'compatible-mode']);

/**
 * 解析 baseURL。
 *
 * 前缀判定：**一路收到第一个版本段（含），再收紧跟其后的一个模式标记段**。
 * 找不到版本段 → 前缀为空，整条路径都算 `rest`。
 *
 * 例：
 *   `/v1`                          → prefix=`/v1`,              rest=``
 *   `/v1/chat/completions`         → prefix=`/v1`,              rest=`/chat/completions`
 *   `/compatible-mode/v1/images/…` → prefix=`/compatible-mode/v1`, rest=`/images/…`
 *   `/api/paas/v4`                 → prefix=`/api/paas/v4`,     rest=``     ← 智谱，版本段在中间
 *   `/api/v1/services/aigc/…`      → prefix=`/api/v1`,          rest=`/services/aigc/…`
 *   `/v1beta/openai/audio/speech`  → prefix=`/v1beta/openai`,   rest=`/audio/speech`
 *   `/text2audio`                  → prefix=``,                 rest=`/text2audio`  ← 百度：baseURL 本身就是端点
 */
export function parseBaseUrl(baseUrl: string): BaseUrlParts {
    const raw = String(baseUrl ?? '').trim();
    const m = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)([^?#]*)/i.exec(raw);
    if (!m) return { origin: '', prefix: '', rest: '' };

    const origin = m[1];
    const segs = m[2].split('/').filter(Boolean);

    // 找到第一个版本段
    const vi = segs.findIndex((s) => VERSION_SEG_RE.test(s));
    if (vi < 0) {
        // 没有版本段 → 没有"版本前缀"可言，整条路径都留给调用方判断
        return { origin, prefix: '', rest: segs.length ? '/' + segs.join('/') : '' };
    }
    // 版本段 + 紧跟的一个模式标记段
    let end = vi + 1;
    if (end < segs.length && MODE_SEGS.has(segs[end].toLowerCase())) end++;

    return {
        origin,
        prefix: '/' + segs.slice(0, end).join('/'),
        rest: segs.slice(end).length ? '/' + segs.slice(end).join('/') : '',
    };
}

/**
 * 把用户给的 baseURL 归一化成"**只到版本前缀为止**"的基址。
 *
 * 为什么必须做：用户从厂商文档复制 URL 时，复制的往往是**完整端点**
 * （`https://host/v1/chat/completions`）。插件若再往上拼 `/audio/speech`，
 * 就得到 `.../v1/chat/completions/audio/speech` —— 必然 404。
 * 这里把它退回 `https://host/v1`，用户不必自己删。
 *
 * **只在找到了版本前缀时才回退**：像百度那样"baseURL 本身就是端点"（无版本段）
 * 的厂商不能被削，否则会把端点削没。
 *
 * 另外：厂商已知、但用户只给了主机根（没有版本前缀）时，补上该厂商的规范前缀。
 *
 * @param canonicalPrefix 该厂商的规范版本前缀（可选；给了才会在"只有主机根"时补）
 */
export function normalizeBaseUrl(baseUrl: string, canonicalPrefix?: string): string {
    const { origin, prefix, rest } = parseBaseUrl(baseUrl);
    if (!origin) return String(baseUrl ?? '').trim().replace(/\/+$/, '');

    // 有版本前缀 + 后面还有东西 → 说明粘的是完整端点，退回前缀
    if (prefix && rest) return origin + prefix;

    // 只给了主机根，且该厂商有规范前缀 → 补上
    if (!prefix && !rest && canonicalPrefix) return origin + canonicalPrefix;

    return origin + prefix + rest;
}

/** 是否看起来是"完整端点"（而非基址）—— 供提示/日志用 */
export function looksLikeEndpoint(baseUrl: string): boolean {
    return parseBaseUrl(baseUrl).rest !== '';
}

/**
 * 各 vendor 的**规范 baseURL**。
 *
 * 聊天厂商取自 `PROVIDER_MAP`（单一事实来源，不重复维护）；
 * 这里只补 **PROVIDER_MAP 里没有的媒体专属厂商** —— 它们的规范基址同样是事实，
 * 只是没被收进聊天表。
 *
 * 为什么需要：用户可能只填主机根（`https://api.minimax.chat`），归一化要能补出
 * `/api/v3`、`/v1` 这类前缀；不补的话 `/images/generations` 就拼到根上，少一层。
 */
const MEDIA_VENDOR_BASE: { [vendor: string]: string } = {
    volcengine: 'https://ark.cn-beijing.volces.com/api/v3',
    'tencent-tokenhub': 'https://api.lkeap.cloud.tencent.com/v1',
    stability: 'https://api.stability.ai',
    // MiniMax 官方 OpenAPI：servers=[https://api.minimax.io]，paths=[/v1/t2a_v2]
    // → 它的端点是**相对版本前缀**的（与 OpenAI 兼容类同），不是相对主机根。
    minimax: 'https://api.minimax.io/v1',
    fishaudio: 'https://api.fish.audio',
    elevenlabs: 'https://api.elevenlabs.io',
    'google-cloud': 'https://texttospeech.googleapis.com',
    baidu: 'https://tsn.baidu.com/text2audio',
    dashscope: 'https://dashscope.aliyuncs.com',
};

/** 某 vendor 的规范 baseURL（聊天表优先，其次媒体表；都没有返回 ''） */
export function canonicalBaseOf(provider: string): string {
    const key = String(provider || '').trim().toLowerCase();
    return PROVIDER_MAP[key] || MEDIA_VENDOR_BASE[key] || '';
}

/**
 * 某 vendor 的**规范版本前缀**。
 *
 * 用途：用户只填了主机根（没带版本前缀）时，归一化要能补上它 ——
 * 例如 openai 只填 `https://api.openai.com` 也应拼出 `/v1/images/generations`。
 *
 * 规范基址本身就是主机根的厂商（stability / elevenlabs / fishaudio / google-cloud /
 * minimax / baidu / dashscope）→ 前缀为空，正好正确。
 */
export function canonicalPrefixOf(provider: string): string {
    return parseBaseUrl(canonicalBaseOf(provider)).prefix;
}