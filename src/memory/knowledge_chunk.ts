// 知识库分块：Markdown 结构化切块（# 标题 → ##/### 小节 → 段落 → 硬切）与稳定 ID 生成
export interface KnowledgeChunk {
    /** 稳定分块 ID：同一内容在配置重载后保持不变 */
    id: string;
    /** 条目/一级标题 */
    title: string;
    /** 二级/三级标题（可为空） */
    heading: string;
    content: string;
}

export interface ChunkOptions {
    /** 单块最大字符数，默认 800 */
    maxSize?: number;
    /** 切块重叠字符数，默认 100 */
    overlap?: number;
}

/** 稳定哈希：同一输入总是得到同一 ID */
function hashString(s: string): string {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
        h = ((h << 5) + h) ^ s.charCodeAt(i);
        h |= 0;
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

interface ChunkGroup {
    title: string;
    heading: string;
    text: string;
}

/** 按段落累积切块；单段仍超长时按行/字符硬切，相邻块间保留 overlap 字符重叠 */
function splitParagraphs(text: string, maxSize: number, overlap: number): string[] {
    const parts: string[] = [];
    const paragraphs = text.split(/\n\s*\n/);
    let current = '';
    for (const p of paragraphs) {
        const candidate = current ? `${current}\n\n${p}` : p;
        if (candidate.length <= maxSize) {
            current = candidate;
            continue;
        }
        if (current) {
            parts.push(current);
            const tail = overlap > 0 ? current.slice(-overlap) : '';
            current = tail ? `${tail}\n\n${p}` : p;
        } else {
            current = p;
        }
        // 单段超长：按行优先硬切，行内过长时按字符切
        while (current.length > maxSize) {
            let cut = current.lastIndexOf('\n', maxSize);
            if (cut <= 0) cut = maxSize;
            const head = current.slice(0, cut);
            parts.push(head);
            // 重叠尾部不得超过 head 长度 - 1，保证每次循环 current 严格变短，避免死循环
            const overlapLen = Math.min(overlap, head.length - 1);
            const tail = overlapLen > 0 ? head.slice(-overlapLen) : '';
            current = tail + current.slice(cut);
        }
    }
    if (current) parts.push(current);
    return parts;
}

/**
 * 把一段 Markdown 切分为知识库分块。
 * 以 `#` 作为条目标题、`##`/`###` 作为小节标题；无 `#` 的文档由调用方
 * 补充条目标题（如条目序号）。
 * @param seed 用于区分同名条目的额外种子（如条目序号），保证 ID 全局唯一
 */
export function splitMarkdownIntoChunks(markdown: string, options: ChunkOptions = {}, seed = ''): KnowledgeChunk[] {
    const maxSize = options.maxSize ?? 800;
    const overlap = options.overlap ?? 100;
    const lines = (markdown || '').replace(/\r\n/g, '\n').split('\n');
    const groups: ChunkGroup[] = [];
    let title = '';
    let heading = '';
    let buffer: string[] = [];
    let groupSeq = 0;

    const flushGroup = () => {
        const text = buffer.join('\n').trim();
        if (text) groups.push({ title, heading, text });
        buffer = [];
    };

    for (const line of lines) {
        const m = line.match(/^(#{1,3})\s+(.+)$/);
        if (m) {
            const level = m[1].length;
            const text = m[2].trim();
            flushGroup();
            if (level === 1) {
                title = text;
                heading = '';
            } else {
                heading = text;
            }
            buffer.push(line);
            continue;
        }
        buffer.push(line);
    }
    flushGroup();

    const chunks: KnowledgeChunk[] = [];
    for (const g of groups) {
        groupSeq++;
        const contents = g.text.length <= maxSize ? [g.text] : splitParagraphs(g.text, maxSize, overlap);
        contents.forEach((content, i) => {
            chunks.push({
                id: `kb_${hashString(`${seed}|${groupSeq}|${i}`)}`,
                title: g.title,
                heading: g.heading,
                content
            });
        });
    }
    return chunks;
}
