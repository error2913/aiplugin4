// media_tasks：查看/取消当前会话的媒体生成任务队列。
// 媒体生成是异步的（提交即返回、完成再通知），AI 需要这个工具来确认队列状态与结果。
import { MediaTask, MediaTaskManager } from "../../../media/task_queue";
import Tool from "../../tool";

function statusLabel(task: MediaTask): string {
    switch (task.status) {
        case 'pending': return '排队中';
        case 'running': return '生成中';
        case 'done': return '已完成';
        case 'failed': return '失败';
        case 'canceled': return '已取消';
        default: return task.status;
    }
}

function elapsedText(task: MediaTask): string {
    const end = task.status === 'pending' || task.status === 'running' ? Date.now() : task.updatedAt;
    const sec = Math.max(0, Math.round((end - task.createdAt) / 1000));
    return `${sec}秒`;
}

/**
 * 展示用转义：把可被回复管线解析的标签（[img:…]/[audio:…]/[CQ:…] 等）改成全角括号。
 *
 * 必须做这一步的原因：队列列表是**纯说明文字**，但 `[img:ID]` 会被 `handleReply` 当成真发送指令，
 * 拿 ID 去重新解析并生成一次 CQ；那条 CQ 若平台读不到，用户在聊天里看到的不是本行文字，
 * 而是海豹的兜底 `[找不到图片/文件]` —— 说明文字被当成了发送指令。
 */
function escapeTagForDisplay(text: string): string {
    return String(text ?? '').replace(/\[/g, '［').replace(/\]/g, '］');
}

/** 单条任务的展示行（不含 base64；只给句柄/状态，不嵌任何可解析标签） */
export function formatTaskLine(task: MediaTask, index: number): string {
    const kind = task.kind === 'tts' ? '语音' : '生图';
    const summary = task.kind === 'tts' ? (task.request.text ?? '') : (task.request.prompt ?? '');
    const short = summary.length > 30 ? `${summary.slice(0, 30)}…` : summary;
    const head = `${index}. #${task.id} ${kind} ${statusLabel(task)} ${elapsedText(task)}「${short}」`;
    if (task.status === 'done' && task.result) {
        if (task.result.kind === 'record') {
            return `${head}\n   音频：${task.result.data}`;
        }
        // 同时给出落地时**现场生成**的发送形态，便于判断"CQ 是文件路径还是 URL、是否为空"
        const send = task.result.send ? escapeTagForDisplay(task.result.send) : '(未生成，见日志)';
        return `${head}\n   图片ID：${task.result.imageId}\n   发送形态：${send}`;
    }
    if (task.status === 'failed') return `${head}\n   失败原因：${task.error ?? '未知'}`;
    return head;
}

export function registerMediaTaskTools() {
    const tool = new Tool({
        type: "function",
        function: {
            name: "media_tasks",
            description:
                "查看或取消当前会话的语音/图片生成任务队列（这些任务是异步的：提交后立即返回任务号，完成后会自动通知你）。"
                + "action=list 列出任务与状态/结果；action=cancel 取消未完成的任务（需要 id）。",
            parameters: {
                type: "object",
                properties: {
                    action: { type: "string", enum: ["list", "cancel"], description: "list=查看队列；cancel=取消任务" },
                    id: { type: "string", description: "cancel 时必填，任务号（如 3）" },
                    status: {
                        type: "string",
                        enum: ["all", "pending", "running", "done", "failed", "canceled"],
                        description: "list 时筛选状态，默认 all"
                    },
                },
                required: [],
            },
        },
    });

    tool.solve = async (ctx, _msg, _session, args) => {
        const isPrivate = !!ctx.isPrivate;
        const sid = isPrivate ? (ctx.player?.userId ?? '') : (ctx.group?.groupId ?? '');
        const action = String(args?.action ?? 'list').trim().toLowerCase();

        if (action === 'cancel') {
            const id = String(args?.id ?? '').trim();
            if (!id) return '取消任务需要提供 id（任务号）';
            const result = MediaTaskManager.cancel(sid, id);
            return result.message;
        }

        const filter = String(args?.status ?? 'all').trim().toLowerCase();
        const all = MediaTaskManager.list(sid);
        const shown = filter === 'all' ? all : all.filter(t => t.status === filter);
        if (shown.length === 0) {
            return all.length === 0
                ? '当前会话没有生成任务。'
                : `当前会话没有状态为 ${filter} 的任务（共 ${all.length} 个）。`;
        }
        const lines = shown.map((t, i) => formatTaskLine(t, i + 1));
        const unfinished = all.filter(t => t.status === 'pending' || t.status === 'running').length;
        return [`当前会话生成任务（${shown.length}/${all.length}）：`, ...lines]
            .concat(unfinished > 0 ? [`未完成任务可用 media_tasks action=cancel id=<任务号> 取消`] : [])
            .join('\n');
    };
}
