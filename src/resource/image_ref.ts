// CIR v1：通用图片引用标准（与 Image / ImageHost 解耦的纯解析层）
//
//   image-tag := "[" "img:" ref (":" description)? "]"
//   ref       := "h" 64HEX        // 图床托管图的规范形式
//              | 64HEX            // 兼容：裸 sha256
//              | plugin-id        // 插件图片 ID
//              | "user_avatar:" uid
//              | "group_avatar:" gid
//
// 说明：
// - 这里只做纯字符串解析/改写，不 import Image，避免 image.ts 与本模块循环依赖；
//   “注册虚拟图 / 解析成 Image”在 image.ts 的 Image.resolveRef() 里完成。
// - normalize 只改写“工具输出里的图床引用”，用户输入仍由 stripUserTags 转义。
import { isLoopbackUrl } from "../utils/url";

export type ImageRefKind = "hosted" | "plugin" | "user_avatar" | "group_avatar";

export interface ParsedImageRef {
    kind: ImageRefKind;
    /** hosted=sha256；plugin=imageId；avatar=uid/gid */
    id: string;
    /** 仅展示/发送用，不参与查找 */
    description?: string;
    /** 规范形式（不含 [img:...] 包裹）：h<sha> / <pluginId> / user_avatar:<id> / group_avatar:<id> */
    canonical: string;
}

const HOSTED_ID_RE = /^[a-f0-9]{64}$/i;
const HOSTED_WITH_H_RE = /^h([a-f0-9]{64})$/i;
const URL_HOSTED_RE = /\/i\/([a-f0-9]{64})(?:[/?#]|$)/i;

/** 去掉一层 [img:...] / [avatar:...] / [group_avatar:...] 包裹（兼容全角） */
function unwrap(raw: string): { type: string; body: string } | null {
    const m = /^[[［]\s*(img|avatar|group_avatar)\s*[:：]\s*([^\[\]［］]*?)\s*[\]］]$/i.exec(raw);
    if (!m) return null;
    return { type: m[1].toLowerCase(), body: m[2] };
}

/** 拆分 ref 与描述（只按第一个冒号拆；sha/插件 id 都不含冒号） */
function splitDescription(body: string): { ref: string; description?: string } {
    const idx = body.search(/[:：]/);
    if (idx < 0) return { ref: body.trim(), description: undefined };
    const ref = body.slice(0, idx).trim();
    const description = body.slice(idx + 1).trim();
    return { ref, description: description || undefined };
}

function fromHosted(id: string, description?: string): ParsedImageRef {
    const sha = id.toLowerCase();
    return { kind: "hosted", id: sha, description, canonical: `h${sha}` };
}

/**
 * 解析任意图片引用形态：
 * - [img:<ref>] / [img:<ref>:描述] / 全角括号冒号
 * - [avatar:uid] / [group_avatar:gid] / [img:user_avatar:uid] / [img:group_avatar:gid]
 * - 裸 ref（64hex / h<64hex> / 插件 ID / user_avatar:uid / group_avatar:gid）
 * - /i/<64hex> 或绝对 URL 里的 /i/<64hex>
 * 解析失败返回 null。
 */
export function parseImageRef(raw: unknown): ParsedImageRef | null {
    let text = String(raw ?? "").trim();
    if (!text) return null;

    const wrapped = unwrap(text);
    if (wrapped) {
        if (wrapped.type === "avatar") {
            const { ref, description } = splitDescription(wrapped.body);
            if (!ref) return null;
            return { kind: "user_avatar", id: ref, description, canonical: `user_avatar:${ref}` };
        }
        if (wrapped.type === "group_avatar") {
            const { ref, description } = splitDescription(wrapped.body);
            if (!ref) return null;
            return { kind: "group_avatar", id: ref, description, canonical: `group_avatar:${ref}` };
        }
        text = wrapped.body;
    }

    // 头像别名
    const avatar = /^(user_avatar|group_avatar)[:：]\s*(.+)$/i.exec(text);
    if (avatar) {
        const kind = avatar[1].toLowerCase() === "user_avatar" ? "user_avatar" : "group_avatar";
        const { ref, description } = splitDescription(avatar[2]);
        if (!ref) return null;
        return { kind, id: ref, description, canonical: `${kind}:${ref}` };
    }

    // /i/<sha256>（相对或绝对 URL）：先于“按冒号拆描述”，否则 https:// 会被冒号拆坏
    const urlId = URL_HOSTED_RE.exec(text);
    if (urlId) return fromHosted(urlId[1]);

    const { ref, description } = splitDescription(text);
    if (!ref) return null;

    // h<sha256>
    const withH = HOSTED_WITH_H_RE.exec(ref);
    if (withH) return fromHosted(withH[1], description);

    // 裸 sha256
    if (HOSTED_ID_RE.test(ref)) return fromHosted(ref, description);

    // 其它：插件图片 ID
    if (/[[［\]］]/.test(ref)) return null;
    return { kind: "plugin", id: ref, description, canonical: ref };
}

/** 规范引用文本（不含 [img:] 包裹） */
export function canonicalImageRef(raw: unknown): string | null {
    return parseImageRef(raw)?.canonical ?? null;
}

/** 是否为图床托管引用（h<sha> / 裸 sha / /i/<sha>） */
export function isHostedImageRef(raw: unknown): boolean {
    return parseImageRef(raw)?.kind === "hosted";
}

/**
 * 把文本里的图床引用改写为规范形式 [img:h<sha256>(:描述)]。
 * 只改写 kind=hosted 的标签；插件 ID / 头像标签原样保留。
 * onHosted 用于注册虚拟图（由 image.ts 传入），避免本模块依赖 Image。
 */
export function rewriteHostedImageRefs(
    text: string,
    onHosted?: (sha256: string) => void,
): { text: string; translated: number } {
    let translated = 0;
    const out = String(text || "").replace(
        /[[［]\s*img\s*[:：]\s*([^\[\]［］]+?)\s*[\]］]/gi,
        (whole: string, body: string) => {
            const parsed = parseImageRef(body);
            if (!parsed || parsed.kind !== "hosted") return whole;
            translated++;
            try {
                onHosted?.(parsed.id);
            } catch (_e) {
                // 注册失败不影响文本规范化
            }
            const desc = parsed.description ? `:${parsed.description}` : "";
            return `[img:h${parsed.id}${desc}]`;
        },
    );
    return { text: out, translated };
}

/** 从文本里提取所有图床 id（用于批量处理/打标；不注册） */
export function extractHostedImageIds(text: string): string[] {
    const ids: string[] = [];
    const seen = new Set<string>();
    String(text || "").replace(
        /[[［]\s*img\s*[:：]\s*([^\[\]［］]+?)\s*[\]］]/gi,
        (_whole: string, body: string) => {
            const parsed = parseImageRef(body);
            if (parsed && parsed.kind === "hosted" && !seen.has(parsed.id)) {
                seen.add(parsed.id);
                ids.push(parsed.id);
            }
            return _whole;
        },
    );
    return ids;
}

/** 判断图床对外地址是否为“仅内网可达”（用于模型 URL/b64 选择；域名按公网处理） */
export function isPrivateOrLoopbackUrl(raw: string): boolean {
    const text = String(raw || "").trim();
    if (!text) return false;
    if (isLoopbackUrl(text)) return true;
    const m = /^[a-z][a-z0-9+.-]*:\/\/(\[[^\]]*\]|[^/?#:]+)/i.exec(text);
    if (!m) return false;
    let host = m[1].toLowerCase();
    if (host.startsWith("[") && host.endsWith("]")) {
        host = host.slice(1, -1);
        if (host === "::1" || host === "::" || /^f[cd]/.test(host) || /^fe80:/.test(host)) return true;
        return false;
    }
    if (host === "localhost" || host.endsWith(".localhost")) return true;
    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (!v4) return false; // 域名：按公网处理（无法在 goja 里可靠解析 DNS）
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
}

/** 把引用里的图床 id 归一化为小写 sha（解析失败返回空串） */
export function hostedIdOf(raw: unknown): string {
    const parsed = parseImageRef(raw);
    return parsed && parsed.kind === "hosted" ? parsed.id : "";
}
