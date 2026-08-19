/**
 * 本地扩展工具调用的出站消息捕获器。
 *
 * SealDice 的 onMessageSend 回调只携带出站消息上下文，不能保证与工具调用使用同一个
 * 临时 ctx 对象。因此这里按会话 lane 关联调用，避免依赖对象 identity；同一 lane 的
 * 并发工具调用会像普通 session listener 一样同时收到消息。
 */
type CaptureHandler = (content: string) => void;

interface CaptureEntry {
    lanes: Set<string>;
    handler: CaptureHandler;
}

const captures = new Set<CaptureEntry>();

export function registerLocalCommandCapture(lanes: string[], handler: CaptureHandler): () => void {
    const entry: CaptureEntry = {
        lanes: new Set(lanes.filter(Boolean)),
        handler
    };
    captures.add(entry);
    return () => captures.delete(entry);
}

export function dispatchLocalCommandOutput(lane: string, content: string): boolean {
    let captured = false;
    for (const entry of Array.from(captures)) {
        if (!entry.lanes.has(lane)) continue;
        captured = true;
        entry.handler(content);
    }
    return captured;
}
