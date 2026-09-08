// child system 提示词构建（纯函数，不依赖 seal/Config，可单测）。
// 语义引导与委派指引对齐 docs/12 §3.8：工具全量继承、仅任务需要时用对外动作工具、只回结论。
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
    '你拥有与主会话相同的工具能力；仅当任务本身需要时才使用对外发送/管理类工具。\n'
    + '你的中间过程不返回给主会话，完成时只给最终结论；拿不准就直接说明，不要编造。';

export function buildChildSystemContent(opts: ChildSystemOptions): string {
    const sections: string[] = [];
    const instruction = (opts.instruction ?? '').trim();
    if (instruction !== '') sections.push(instruction);
    const now = (opts.nowText ?? '').trim();
    if (now !== '') sections.push(`## 当前时间\n${now}`);
    const toolBlock = (opts.toolBlock ?? '').trim();
    if (toolBlock !== '') sections.push(toolBlock);
    if (opts.promptEngineering) {
        sections.push(
            '工具调用格式：使用 ```function 代码块包裹 JSON 数组调用工具（与主会话同一约定）；'
            + '工具返回会作为新消息给你。'
        );
    }
    if (opts.toolGuidance !== false) sections.push(TOOL_GUIDANCE_TEXT);
    return sections.join('\n\n');
}
