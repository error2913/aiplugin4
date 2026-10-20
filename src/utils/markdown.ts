// Markdown 文本小工具：抽取首个正文段落。
//
// 技能描述 / 知识库描述在配置里可省略；省略时用正文首段兜底。
// 默认：跳过第一个标题（有标题时），没有标题则从首个非空行开始。
// requireH1=true 时保持知识库旧行为：必须有 # 一级标题才开始取正文（避免无标题库描述变化导致 libraryId 漂移）。
export function extractFirstParagraph(markdown: string, maxChars = 200, requireH1 = false): string {
    const normalized = String(markdown || '').replace(/\r\n?/g, '\n');
    const lines = normalized.split('\n');
    const buffer: string[] = [];
    let started = false;
    for (const line of lines) {
        const trimmed = line.trim();
        if (!started) {
            if (!trimmed) continue;
            if (/^#\s+/.test(trimmed)) {
                started = true;
                continue;
            }
            if (requireH1) continue;
            started = true;
        }
        if (/^#{1,6}\s+/.test(trimmed)) {
            if (buffer.length > 0) break;
            continue;
        }
        if (!trimmed) {
            if (buffer.length > 0) break;
            continue;
        }
        buffer.push(trimmed);
        if (buffer.join(' ').length >= maxChars) break;
    }
    return buffer.join(' ').slice(0, maxChars);
}
