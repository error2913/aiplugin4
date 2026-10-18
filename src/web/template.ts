// 占位符渲染 + 取数路径（generic 方言用；不依赖 model/media_template，避免反向依赖）
//
// 语义与媒体模板一致：
//   - 整值占位符（"limit": "{count}"）保留原始类型（数字/布尔）
//   - 混合串按字符串拼接
//   - 值为 undefined/null/'' 时该键省略（数组元素同样丢弃）

const SINGLE_PLACEHOLDER_RE = /^\{([A-Za-z0-9_]+)\}$/;
const PLACEHOLDER_RE = /\{([A-Za-z0-9_]+)\}/g;

function isEmptyValue(v: unknown): boolean {
    return v === undefined || v === null || v === '';
}

/** 渲染任意模板节点；返回 undefined 表示"该键应删除" */
export function renderTemplate(node: unknown, vars: Record<string, unknown>): unknown {
    if (typeof node === 'string') {
        const single = SINGLE_PLACEHOLDER_RE.exec(node);
        if (single) {
            const value = vars[single[1]];
            return isEmptyValue(value) ? undefined : value;
        }
        if (node.indexOf('{') === -1) return node;
        return node.replace(PLACEHOLDER_RE, (_all, name: string) => {
            const value = vars[name];
            return isEmptyValue(value) ? '' : String(value);
        });
    }

    if (Array.isArray(node)) {
        const out: unknown[] = [];
        for (const item of node) {
            const rendered = renderTemplate(item, vars);
            if (rendered !== undefined) out.push(rendered);
        }
        return out;
    }

    if (node && typeof node === 'object') {
        const out: Record<string, unknown> = {};
        let dropped = false;
        for (const key of Object.keys(node as Record<string, unknown>)) {
            const rendered = renderTemplate((node as Record<string, unknown>)[key], vars);
            if (rendered === undefined) {
                dropped = true;
                continue;
            }
            out[key] = rendered;
        }
        // 整个对象都被删空：返回 undefined（例如可选的过滤条件全没填）
        if (dropped && Object.keys(out).length === 0) return undefined;
        return out;
    }

    return node;
}

/** 渲染纯文本模板（URL / path），无值时替换为空串 */
export function renderText(template: string, vars: Record<string, unknown>): string {
    const rendered = renderTemplate(String(template ?? ''), vars);
    return rendered === undefined ? '' : String(rendered);
}

/** 按点分路径取数（支持数组下标：a.b.0.c）；缺失返回 undefined */
export function getByPath(data: unknown, path?: string): unknown {
    const raw = String(path ?? '').trim();
    if (!raw) return undefined;
    let cur: any = data;
    for (const seg of raw.split('.')) {
        if (cur === undefined || cur === null) return undefined;
        if (Array.isArray(cur)) {
            const idx = Number(seg);
            if (!Number.isInteger(idx) || idx < 0) return undefined;
            cur = cur[idx];
        } else if (typeof cur === 'object') {
            cur = (cur as Record<string, unknown>)[seg];
        } else {
            return undefined;
        }
    }
    return cur;
}

/** 转字符串（非字符串安全） */
export function asText(v: unknown): string {
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return '';
}
