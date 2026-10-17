// .ai tti：生成图片并发送（异步任务，提交即返回，完成后插件直接投递）
import { logger } from "../../logger";
import { MediaTaskManager } from "../../media/task_queue";
import { U } from "../privilege";
import { SubCmd, SubCmdContext } from "../root_cmd";

import { parseMediaArgs, queueSummary, resolveCommandEntry } from "./media_shared";

const log = logger.withTag('cmd');

export function registerCmdTti() {
    const cmd = new SubCmd('tti');
    cmd.desc = '文字生图';
    cmd.help = `帮助:
【.ai tti <描述>】生成图片并发送
可选参数：--model=模型名 --size=尺寸 --steps=步数 --seed=种子 --quality=质量 --style=风格 --negative=反向提示 --save
示例：.ai tti 一只在雪地里奔跑的白狐 --size=1024x1024
说明：提交后立即返回任务号，生成完成后直接发到本会话；查看队列 .ai media；
     --save 会把生成结果写入记忆（可用 --name=名称 指定名字）`;
    // 注意：正文是自由描述，priv 不能带 args（否则描述会被权限链路当成子指令）
    cmd.priv = { priv: U };

    cmd.solve = async (scc: SubCmdContext) => {
        const { ctx, msg, ret } = scc;
        const parsed = parseMediaArgs(scc);
        if (!parsed.text) {
            seal.replyToSender(ctx, msg, cmd.help);
            return ret;
        }

        try {
            const { entry, error } = await resolveCommandEntry('image-generation', parsed.model);
            if (!entry) {
                seal.replyToSender(ctx, msg, error ?? '未配置生图模型');
                return ret;
            }

            const negative = parsed.raw.negative ?? parsed.raw.negative_prompt ?? '';
            const save = Object.prototype.hasOwnProperty.call(parsed.raw, 'save');
            const name = parsed.raw.name ?? '';

            const prepared = await entry.prepareTTI(parsed.text, {
                negativePrompt: negative,
                params: parsed.params,
                normOpts: { coerceStringTypes: true },
            });
            if ('error' in prepared) {
                seal.replyToSender(ctx, msg, `参数有误：${prepared.error}`);
                return ret;
            }

            const task = MediaTaskManager.submit({
                ctx,
                kind: 'tti',
                origin: 'command',
                entry,
                text: parsed.text,
                negativePrompt: negative,
                params: parsed.params,
                save,
                name,
                modelLabel: entry.ref,
            });

            const sid = ctx.isPrivate ? (ctx.player?.userId ?? '') : (ctx.group?.groupId ?? '');
            const queued = queueSummary(sid).unfinished - 1;

            const text = parsed.text.length > 40 ? `${parsed.text.slice(0, 40)}…` : parsed.text;
            seal.replyToSender(ctx, msg, [
                `已提交生图任务 #${task.id}`,
                `描述：${text}`,
                `模型：${entry.ref}`,
                queued > 0 ? `当前有 ${queued} 个任务在排队/进行中` : '',
                `生成完成后会直接发给你；查看队列：.ai media`,
            ].filter(Boolean).join('\n'));
        } catch (e) {
            log.exception('提交生图任务失败', e);
            seal.replyToSender(ctx, msg, `提交生图任务失败：${e instanceof Error ? e.message : String(e)}`);
        }
        return ret;
    };
}
