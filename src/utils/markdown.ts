// Markdown 文本小工具：抽取首个正文段落。
//
// 技能描述 / 知识库描述在配置里可省略；省略时用正文首段兜底。
// 规则：跳过第一个标题，取标题后的第一段；没有标题时从首个非空行开始。
export function extractFirstParagraph(markdown: string, maxChars = 200): string {
    const normalized = String(markdown || '').replace(/\r\n?/g, '\n');
    const lines = normalized.split('\n');
    const buffer: string[] = [];
    let started = false;
    for (const line of lines) {
        const trimmed = line.trim();
        if (!started) {
            if (!trimmed) continue;
            started = true;
            if (/^#{1,6}\s+/.test(trimmed)) continue;
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
