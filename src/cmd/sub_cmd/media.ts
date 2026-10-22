// .ai media：查看/取消本会话的生成任务队列（异步任务的可见入口）
import { MediaTaskManager } from "../../media/task_queue";
import { formatTaskLine } from "../../tool/tools/media/tool_media_tasks";
import { aliasToCmd } from "../../utils/alias";
import { U } from "../privilege";
import { SubCmd, SubCmdContext } from "../root_cmd";

/** 默认展示：未完成 + 最近 N 条已结束（--all 查看全部） */
const FINISHED_KEEP = 10;

export function registerCmdMedia() {
    const cmd = new SubCmd('media');
    cmd.desc = '查看/取消生成任务队列';
    cmd.help = `帮助:
【.ai media】查看本会话生成任务队列（未完成 + 最近 ${FINISHED_KEEP} 条已结束）
【.ai media list [页码] [--all]】分页查看；--all 包含全部已结束任务
【.ai media cancel <任务号>】取消未完成的任务
说明：语音/图片生成是异步的，提交后立即返回任务号，完成时会直接发到本会话`;
    cmd.priv = { priv: U, args: { list: { priv: U }, cancel: { priv: U } } };

    cmd.solve = (scc: SubCmdContext) => {
        const { ctx, msg, cmdArgs, page, ret } = scc;
        const action = aliasToCmd(cmdArgs.getArgN(2));

        if (action === 'cancel') {
            const arg3 = cmdArgs.getArgN(3);
            const argKw = cmdArgs.getKwarg('id');
            const id = String(arg3 || (argKw && argKw.valueExists ? argKw.value : '')).trim();
            if (!id) {
                seal.replyToSender(ctx, msg, '【.ai media cancel <任务号>】取消未完成的任务');
                return ret;
            }
            const sid = sidOf(scc);
            const result = MediaTaskManager.cancel(sid, id);
            seal.replyToSender(ctx, msg, result.message);
            return ret;
        }

        if (action === 'list' || !action) {
            const showAll = !!cmdArgs.getKwarg('all');
            seal.replyToSender(ctx, msg, buildQueueText(sidOf(scc), page, showAll));
            return ret;
        }

        seal.replyToSender(ctx, msg, cmd.help);
        return ret;
    };
}

function sidOf(scc: SubCmdContext): string {
    const { ctx } = scc;
    return ctx.isPrivate ? (ctx.player?.userId ?? '') : (ctx.group?.groupId ?? '');
}

/** 队列文本：未完成 + （全部 或 最近 FINISHED_KEEP 条已结束），分页展示 */
export function buildQueueText(sid: string, page = 1, showAll = false): string {
    const all = MediaTaskManager.list(sid);
    if (all.length === 0) return '当前会话没有生成任务。';

    const unfinished = all.filter(t => t.status === 'pending' || t.status === 'running');
    const finished = all.filter(t => t.status !== 'pending' && t.status !== 'running');
    const finishedShown = showAll
        ? finished
        : finished.slice(Math.max(0, finished.length - FINISHED_KEEP));
    const shownAll = [...unfinished, ...finishedShown];

    const perPage = 10;
    const totalPages = Math.max(1, Math.ceil(shownAll.length / perPage));
    const p = Math.min(Math.max(1, page), totalPages);
    const slice = shownAll.slice((p - 1) * perPage, p * perPage);

    const lines = [
        `当前会话生成任务（共 ${all.length} 个，未完成 ${unfinished.length} 个）：`,
        ...slice.map((t, i) => formatTaskLine(t, (p - 1) * perPage + i + 1)),
    ];
    if (unfinished.length > 0) lines.push('未完成任务可用 .ai media cancel <任务号> 取消');
    if (!showAll && finished.length > finishedShown.length) {
        lines.push(`（已结束任务仅显示最近 ${FINISHED_KEEP} 条，全部用 .ai media list --all）`);
    }
    lines.push(`当前页码:${p}/${totalPages}`);
    return lines.join('\n');
}
