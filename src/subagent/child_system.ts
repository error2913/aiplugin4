// child system 提示词构建（纯函数，不依赖 seal/Config，可单测）。
// 语义引导与委派指引对齐 docs/03 子代理框架：工具全量继承、仅任务需要时用对外动作工具、只回结论。
export interface ChildSystemOptions {
    /** child persona / 模板 Agent instruction（必填） */
    instruction: string;
    /** 当前时间文本（如 "2026-08-19 10:00"）；空则不渲染时间节 */
    nowText?: string;
    /** 工具说明块：原生模式=工具发现说明；提示词工程模式=含调用格式说明 */
    toolBlock?: string;
    /** 提示词工程模式（主链同款分支语义） */
    promptEngineering?: boolean;
    /** 是否追加"你拥有与主会话相同的工具能力"引导（默认 true） */
    toolGuidance?: boolean;
}

const TOOL_GUIDANCE_TEXT =
    'You have the same tool capabilities as the main conversation; use outbound send/management tools only when the task itself needs them.\n'
    + 'Your intermediate process is not returned to the main conversation; when done, give only the final conclusion; if unsure, say so directly instead of making things up.';

export function buildChildSystemContent(opts: ChildSystemOptions): string {
    const sections: string[] = [];
    const instruction = (opts.instruction ?? '').trim();
    if (instruction !== '') sections.push(instruction);
    const now = (opts.nowText ?? '').trim();
    if (now !== '') sections.push(`## Current time\n${now}`);
    const toolBlock = (opts.toolBlock ?? '').trim();
    if (toolBlock !== '') sections.push(toolBlock);
    if (opts.promptEngineering) {
        sections.push(
            'Tool call format: wrap a JSON array in a ```function code block to call tools (same convention as the main conversation); '
            + 'tool results come back to you as new messages.'
        );
    }
    if (opts.toolGuidance !== false) sections.push(TOOL_GUIDANCE_TEXT);
    return sections.join('\n\n');
}
