// 媒体通知「已送达」回置端口（L0 叶子）：会话侧（inbox/flushNotices）真正把通知呈现给 AI 后，
// 需要把对应媒体任务标记为 notified（重载补发据此判断"已送达"）。
// 若会话直接 import media/task_queue，会把媒体模块重新拉进会话编排环；
// 因此由 media 模块在自身加载时注册实现（见 src/media/task_queue.ts 末尾）。
export type MediaNotifiedHandler = (sessionId: string, taskId: string) => void;

let handler: MediaNotifiedHandler | null = null;

/** 由 media 模块在加载时注册（重复注册以后者为准） */
export function setMediaNotifiedHandler(fn: MediaNotifiedHandler | null): void {
    handler = fn;
}

/** 标记媒体任务已送达；实现未注册时静默（与"找不到任务记录"的语义一致） */
export function markMediaNotified(sessionId: string, taskId: string): void {
    if (!handler) return;
    handler(sessionId, taskId);
}
