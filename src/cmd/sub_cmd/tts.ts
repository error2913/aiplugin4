// .ai tts：合成语音并发送（异步任务，提交即返回，完成后插件直接投递）
import { logger } from "../../logger";
import { MediaTaskManager } from "../../media/task_queue";
import { U } from "../privilege";
import { SubCmd, SubCmdContext } from "../root_cmd";

import { parseMediaArgs, queueSummary, resolveCommandEntry } from "./media_shared";

const log = logger.withTag('cmd');

export function registerCmdTts() {
    const cmd = new SubCmd('tts');
    cmd.desc = '合成语音并发送';
    cmd.help = `帮助:
【.ai tts <文本>】合成语音并发送
可选参数：--model=模型名 --voice=音色 --rate=语速 --pitch=音调 --volume=音量 --instruction=语气 --emotion=情绪
示例：.ai tts 今天天气真不错 --rate=1.5 --instruction=用欢快的语气说
说明：提交后立即返回任务号，生成完成后直接发到本会话；查看队列 .ai media`;
    // 注意：正文是自由文本，priv 不能带 args（否则正文会被权限链路当成子指令）
    cmd.priv = { priv: U };

    cmd.solve = async (scc: SubCmdContext) => {
        const { ctx, msg, ret } = scc;
        const parsed = parseMediaArgs(scc);
        if (!parsed.text) {
            seal.replyToSender(ctx, msg, cmd.help);
            return ret;
        }

        try {
            const { entry, error } = await resolveCommandEntry('tts', parsed.model);
            if (!entry) {
                seal.replyToSender(ctx, msg, error ?? '未配置语音模型');
                return ret;
            }

            const prepared = await entry.prepareTTS(parsed.text, parsed.params, { coerceStringTypes: true });
            if ('error' in prepared) {
                seal.replyToSender(ctx, msg, `参数有误：${prepared.error}`);
                return ret;
            }

            const task = MediaTaskManager.submit({
                ctx,
                kind: 'tts',
                origin: 'command',
                entry,
                text: parsed.text,
                params: parsed.params,
                modelLabel: entry.ref,
            });

            const sid = ctx.isPrivate ? (ctx.player?.userId ?? '') : (ctx.group?.groupId ?? '');
            const queued = queueSummary(sid).unfinished - 1;

            const text = parsed.text.length > 40 ? `${parsed.text.slice(0, 40)}…` : parsed.text;
            seal.replyToSender(ctx, msg, [
                `已提交语音生成任务 #${task.id}`,
                `文本：${text}`,
                `模型：${entry.ref}`,
                queued > 0 ? `当前有 ${queued} 个任务在排队/进行中` : '',
                `生成完成后会直接发给你；查看队列：.ai media`,
            ].filter(Boolean).join('\n'));
        } catch (e) {
            log.exception('提交语音生成任务失败', e);
            seal.replyToSender(ctx, msg, `提交语音生成任务失败：${e instanceof Error ? e.message : String(e)}`);
        }
        return ret;
    };
}
