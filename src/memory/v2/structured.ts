// Markdown ↔ StructuredDoc（心智模型 AST）与类型化 delta 操作。
// 关键保证：未被操作命中的 block 原样复制（不重新渲染/不改空格）。
import type { DeltaOperation, StructuredBlock, StructuredBlockType, StructuredDoc, StructuredSection } from "./types";

function hashText(text: string): string {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36).slice(0, 8);
}

function blockId(sectionIdx: number, blockIdx: number, text: string): string {
    return `b${sectionIdx}_${blockIdx}_${hashText(text)}`;
}

/** 解析 markdown：# 标题、- 列表、- [ ] 清单、``` 代码、其余段落。 */
export function parseMarkdown(markdown: string): StructuredDoc {
    const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
    const sections: StructuredSection[] = [];
    let current: StructuredSection | null = null;
    let paragraph: string[] = [];
    let code: string[] | null = null;

    const ensureSection = (heading = ''): StructuredSection => {
        if (!current) {
            current = { id: `s${sections.length}_${hashText(heading)}`, heading, blocks: [] };
            sections.push(current);
        }
        return current;
    };
    const flushParagraph = (): void => {
        const text = paragraph.join('\n').trim();
        paragraph = [];
        if (!text) return;
        const sec = ensureSection();
        sec.blocks.push({ id: blockId(sections.length - 1, sec.blocks.length, text), type: 'paragraph', text });
    };
    const flushCode = (): void => {
        if (code === null) return;
        const text = code.join('\n');
        const sec = ensureSection();
        sec.blocks.push({ id: blockId(sections.length - 1, sec.blocks.length, text), type: 'code', text });
        code = null;
    };

    for (const line of lines) {
        if (/^```/.test(line)) {
            flushParagraph();
            if (code === null) code = [];
            else flushCode();
            continue;
        }
        if (code !== null) {
            code.push(line);
            continue;
        }
        const heading = line.match(/^(#{1,6})\s+(.*)$/);
        if (heading) {
            flushParagraph();
            current = { id: `s${sections.length}_${hashText(heading[2])}`, heading: heading[2].trim(), blocks: [] };
            sections.push(current);
            continue;
        }
        const checklist = line.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/);
        if (checklist) {
            flushParagraph();
            const sec = ensureSection();
            const text = `${checklist[1].toLowerCase() === 'x' ? '[x]' : '[ ]'} ${checklist[2]}`;
            const type: StructuredBlockType = 'checklist';
            sec.blocks.push({ id: blockId(sections.length - 1, sec.blocks.length, text), type, text });
            continue;
        }
        const bullet = line.match(/^\s*[-*]\s+(.*)$/);
        if (bullet) {
            flushParagraph();
            const sec = ensureSection();
            const text = bullet[1];
            sec.blocks.push({ id: blockId(sections.length - 1, sec.blocks.length, text), type: 'bullet', text });
            continue;
        }
        if (!line.trim()) {
            flushParagraph();
            continue;
        }
        paragraph.push(line);
    }
    flushParagraph();
    flushCode();
    if (sections.length === 0) {
        sections.push({ id: `s0_${hashText('')}`, heading: '', blocks: [] });
    }
    return { version: 1, sections };
}

export function renderMarkdown(doc: StructuredDoc): string {
    const out: string[] = [];
    for (const section of doc.sections || []) {
        if (section.heading) out.push(`## ${section.heading}`);
        for (const block of section.blocks || []) {
            if (block.type === 'bullet') out.push(`- ${block.text}`);
            else if (block.type === 'checklist') out.push(`- ${block.text.startsWith('[') ? block.text : `[ ] ${block.text}`}`);
            else if (block.type === 'code') out.push('```', block.text, '```');
            else out.push(block.text);
        }
        out.push('');
    }
    return out.join('\n').trim();
}

function cloneDoc(doc: StructuredDoc): StructuredDoc {
    return JSON.parse(JSON.stringify(doc)) as StructuredDoc;
}

function normalizeBlocks(blocks: StructuredBlock[] | undefined, sectionIdx: number): StructuredBlock[] {
    return (blocks || []).map((b, i) => ({
        id: b.id || blockId(sectionIdx, i, b.text || ''),
        type: b.type || 'paragraph',
        text: String(b.text ?? ''),
    }));
}

export interface ApplyDeltaResult {
    doc: StructuredDoc;
    applied: number;
    rejected: number;
}

/** 应用类型化编辑；未命中的 block 原样保留。 */
export function applyDeltaOps(doc: StructuredDoc, ops: DeltaOperation[]): ApplyDeltaResult {
    const next = cloneDoc(doc || { version: 1, sections: [] });
    let applied = 0;
    let rejected = 0;
    for (const op of ops || []) {
        switch (op.op) {
            case 'add_section': {
                const heading = String(op.heading || '').trim();
                if (!heading) { rejected++; break; }
                next.sections.push({
                    id: `s${next.sections.length}_${hashText(heading)}`,
                    heading,
                    blocks: normalizeBlocks(op.blocks, next.sections.length),
                });
                applied++;
                break;
            }
            case 'append_bullet': {
                const section = findSection(next, op.sectionId);
                if (!section) { rejected++; break; }
                const text = String(op.text || '').trim();
                if (!text) { rejected++; break; }
                section.blocks.push({
                    id: blockId(next.sections.indexOf(section), section.blocks.length, text),
                    type: 'bullet',
                    text,
                });
                applied++;
                break;
            }
            case 'replace_block': {
                const found = findBlock(next, op.blockId);
                if (!found) { rejected++; break; }
                found.block.text = String(op.text ?? '');
                applied++;
                break;
            }
            case 'remove_stale_paragraph': {
                const found = findBlock(next, op.blockId);
                if (!found) { rejected++; break; }
                found.section.blocks.splice(found.index, 1);
                applied++;
                break;
            }
            case 'replace_section_blocks': {
                const section = findSection(next, op.sectionId);
                if (!section) { rejected++; break; }
                section.blocks = normalizeBlocks(op.blocks, next.sections.indexOf(section));
                applied++;
                break;
            }
            default:
                rejected++;
        }
    }
    return { doc: next, applied, rejected };
}

function findSection(doc: StructuredDoc, sectionId?: string): StructuredSection | null {
    if (!sectionId) return doc.sections[0] || null;
    return doc.sections.find(s => s.id === sectionId) || null;
}

function findBlock(doc: StructuredDoc, blockIdValue?: string): { section: StructuredSection; block: StructuredBlock; index: number } | null {
    if (!blockIdValue) return null;
    for (const section of doc.sections) {
        const index = section.blocks.findIndex(b => b.id === blockIdValue);
        if (index >= 0) return { section, block: section.blocks[index], index };
    }
    return null;
}

/** block 文本快照：测试未命中 block 逐字节不变。 */
export function blockSnapshot(doc: StructuredDoc): Array<{ id: string; text: string }> {
    return doc.sections.reduce<Array<{ id: string; text: string }>>((acc, s) => acc.concat(s.blocks.map(b => ({ id: b.id, text: b.text }))), []);
}

