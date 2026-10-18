// vendor（供应商标识）解析：baseURL → vendor 反查。
//
// 为什么需要（见 docs/05 模型配置）：
//   media_presets（媒体请求 body 结构）与 balance（内置余额端点）都按 **vendor** 索引，
//   而 vendor 不该让用户手填。所以从 baseURL 反查 —— 这与 balance.ts 既有的
//   `host.includes('api.deepseek.com')` 是同一思路，只是做成了一张表。
//
// 数据来源：PROVIDER_MAP（v4 的 vendor→默认URL）。v5 里它的职责变成"反查"，
// 表本身不删（它是 vendor↔host 的唯一数据源）。

import { canonicalPrefixOf } from "../../model/base_url";
import { MEDIA_PRESETS } from "../static_config/media_presets";
import { PROVIDER_MAP } from "../static_config/providers";

/** 取 URL 的 host（小写）。非法 URL 返回 '' */
export function hostOf(url: string): string {
    const raw = String(url ?? '').trim();
    if (!raw) return '';
    const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(raw);
    if (!m) return '';
    // 去掉可能的 user:pass@ 与端口
    const hostPort = m[1].includes('@') ? m[1].split('@').pop() ?? '' : m[1];
    return (hostPort.split(':')[0] ?? '').toLowerCase();
}

/** host → vendor（由 PROVIDER_MAP 反转得到；同一 host 只应出现一次） */
const HOST_TO_VENDOR: Record<string, string> = (() => {
    const map: Record<string, string> = {};
    for (const vendor of Object.keys(PROVIDER_MAP)) {
        const h = hostOf(PROVIDER_MAP[vendor]);
        if (h && map[h] === undefined) map[h] = vendor;
    }
    return map;
})();

/**
 * **vendor 独有的**媒体端点路径 → vendor（用于识别"用户直接粘了完整端点地址"）。
 *
 * 由 MEDIA_PRESETS **自己算出来**，不手抄（避免又多一张会漂移的表）。规则：
 *   - 跳过通用预设（`''` 键不代表任何 vendor）
 *   - 跳过含 `{占位符}` 的（如 ElevenLabs 的 `/v1/text-to-speech/{voice}`，无法字符串匹配）
 *   - **只收"恰好一个 vendor 拥有"的路径** —— `/images/generations`、`/audio/speech`
 *     这类被 6~7 个 vendor 共用的必须排除，否则会把自建网关误判成某一家
 *
 * 为什么需要它：`resolveVendor` 原先只看 host。而**专属部署域名**（如
 * `llm-xxxx.cn-beijing.maas.aliyuncs.com`）不在 PROVIDER_MAP 里，反查为空 →
 * 插件退回通用预设 → 把 `/images/generations` 拼到原生端点后面 →
 * 百炼回 400 `url error, please check url！`（官方文档：端点与模型不匹配）。
 * 这类地址的 host 认不出，但**路径是唯一的**，据此可安全反查。
 */
const SUFFIX_TO_VENDOR: Array<[string, string]> = (() => {
    const owners = new Map<string, Set<string>>();
    /**
     * 取预设里"能用来反查 vendor"的那段路径。
     *
     * 预设的地址有**两种表达**，两种都要看：
     *   · `urlSuffix` —— 相对版本前缀（OpenAI 兼容类），如 `/images/generations`
     *   · `url: '{origin}/…'` —— 相对主机根（厂商原生类），如 `/api/v1/services/aigc/…`
     * 只读 urlSuffix 会**漏掉全部原生预设**（百炼原生 / stability / elevenlabs /
     * fishaudio / minimax / google-cloud / gemini），专属部署域名的反查就会失效 ——
     * 实测被单测抓到过（守卫不触发、真发了请求拿到 401）。
     */
    const pathOf = (preset: any): string => {
        const suf = preset.request?.urlSuffix;
        if (typeof suf === 'string' && suf) return suf;
        const u = preset.request?.url;
        if (typeof u !== 'string' || !u) return '';
        return u.replace(/^\{origin\}/, '');   // 去掉主机占位符，剩下就是路径
    };
    for (const use of Object.keys(MEDIA_PRESETS)) {
        const table = MEDIA_PRESETS[use as keyof typeof MEDIA_PRESETS];
        for (const vendor of Object.keys(table)) {
            if (!vendor) continue;
            for (const preset of table[vendor]) {
                const suffix = pathOf(preset);
                if (typeof suffix !== 'string' || !suffix || suffix.includes('{')) continue;
                if (!owners.has(suffix)) owners.set(suffix, new Set());
                owners.get(suffix)!.add(vendor);
            }
        }
    }
    const out: Array<[string, string]> = [];
    for (const [suffix, vendors] of owners) {
        if (vendors.size === 1) { out.push([suffix, [...vendors][0]]); continue; }
        // 多个 owner：优先"**规范基址是主机根**"的那个 —— 说明这条路径本来就是它的原生端点。
        // 例：`/api/v1/services/aigc/multimodal-generation/generation` 同时挂在
        // dashscope（原生，基址是主机根）与 alibaba（兼容模式，基址带 /compatible-mode/v1）下
        // —— 后者只是"顺手也支持"（{origin} 表达，让用户填一个兼容基址也能用 TTS）。
        // 反查时该选 dashscope：那条地址就是它的原生端点。
        const native = [...vendors].filter((v) => !canonicalPrefixOf(v));
        if (native.length === 1) out.push([suffix, native[0]]);
    }
    // 长的优先：避免短后缀误吃长 URL 的尾段
    out.sort((a, b) => b[0].length - a[0].length);
    return out;
})();

/** 去掉 query / hash 与尾斜杠，便于按路径尾段比对 */
function pathTailOf(url: string): string {
    const raw = String(url ?? '').trim();
    if (!raw) return '';
    return raw.split('#')[0].split('?')[0].replace(/\/+$/, '');
}

/** 按"vendor 独有的端点路径"反查（认不出返回 ''） */
export function vendorByUrlSuffix(url: string): string {
    const clean = pathTailOf(url);
    if (!clean) return '';
    for (const [suffix, vendor] of SUFFIX_TO_VENDOR) {
        if (clean.endsWith(suffix)) return vendor;
    }
    return '';
}

/** 供测试与诊断：当前识别表 */
export function knownHosts(): Record<string, string> {
    return { ...HOST_TO_VENDOR };
}

/** 供测试与诊断：vendor 独有的端点路径表 */
export function knownVendorSuffixes(): Array<[string, string]> {
    return SUFFIX_TO_VENDOR.map(([s, v]) => [s, v]);
}

/**
 * 解析一条连接的 vendor：
 *   1. 配置显式写了 provider → 用它（逃生舱）
 *   2. 按 baseURL 的 host 反查
 *   3. host 认不出 → 看 URL 是不是**直接粘了某个 vendor 独有的端点路径**
 *      （专属部署域名 / 原生端点常是这种写法；见 SUFFIX_TO_VENDOR 的说明）
 *   4. 都不命中 → ''（按 OpenAI 兼容处理，与 v4 未收录 provider 的行为一致）
 */
export function resolveVendor(baseURL: string, explicitProvider?: string): string {
    const explicit = String(explicitProvider ?? '').trim();
    if (explicit) return explicit;
    const h = hostOf(baseURL);
    const byHost = h ? (HOST_TO_VENDOR[h] ?? '') : '';
    if (byHost) return byHost;
    return vendorByUrlSuffix(baseURL);
}
