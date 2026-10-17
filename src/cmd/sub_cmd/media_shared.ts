// 媒体命令共享逻辑：正文与 kwargs 解析、参数收集、模型解析。
// 关键点（见 .dev/issue-127-media-plan.md 4.14）：
//   - .ai tts / .ai tti 的 priv 不能带 args：正文是自由文本，PrivilegeManager 会把
//     cmdArgs.args 逐段拼进权限链路，带 args 时正文会被当成子指令而误报"命令不存在"。
//   - 正文从 cmdArgs.args 第 2 位（0-based index 1）起，按 RE_KEYWORD 剔除 --xxx 后拼接，
//     不用 getRestArgsFrom：真实 SealDice 下它可能把 --rate=1.5 并进正文。
import { MediaTaskManager } from "../../media/task_queue";
import Model from "../../model/model";
import { MediaModelUse } from "../../model/types";
import { resolveMediaEntry } from "../../tool/tools/media/shared";
import { SubCmdContext } from "../root_cmd";

/** 与海豹 ArgsParse 一致的 kwargs 形态（--name / --name=value） */
const RE_KEYWORD = /^--([^\s=]+)=(.*)$|^--([^\s=]+)$/;

/** 不作为模型参数的 kwargs：命令控制项 */
const CONTROL_KWARGS = ['page', 'p', 'action', 'status', 'id', 'help'];

export interface ParsedMediaArgs {
    text: string;
    params: Record<string, unknown>;
    raw: Record<string, string>;
    /** 命令里显式指定的模型名（kwargs --model） */
    model: string;
}

/** 解析正文与 kwargs（正文不含 --xxx token） */
export function parseMediaArgs(scc: SubCmdContext): ParsedMediaArgs {
    const args = (scc.cmdArgs.args || []) as string[];
    const plain: string[] = [];
    const raw: Record<string, string> = {};

    // args[0] = 子命令名（tts/tti），正文从其后的位置参数开始
    for (let i = 1; i < args.length; i++) {
        const item = String(args[i] ?? '');
        const m = RE_KEYWORD.exec(item);
        if (!m) {
            plain.push(item);
            continue;
        }
        const name = (m[1] || m[3] || '').trim();
        if (!name) continue;
        raw[name] = m[2] !== undefined ? m[2] : '';
    }

    const params: Record<string, unknown> = {};
    for (const key of Object.keys(raw)) {
        if (CONTROL_KWARGS.indexOf(key) !== -1) continue;
        if (key === 'model') continue;
        params[key] = raw[key];
    }

    return { text: plain.join(' ').trim(), params, raw, model: (raw.model ?? '').trim() };
}

export interface MediaCommandTarget {
    entry?: import("../../model/model").ModelEntry;
    error?: string;
}

/** 解析命令要用的模型（需要模型列表已就绪） */
export async function resolveCommandEntry(use: MediaModelUse, modelArg: string): Promise<MediaCommandTarget> {
    await Model.ensureLoaded();
    const { entry, error } = resolveMediaEntry(use, modelArg);
    return entry ? { entry } : { error };
}

/** 队列摘要（供 .ai media 与提交回话复用） */
export function queueSummary(sid: string): { total: number; unfinished: number } {
    const all = MediaTaskManager.list(sid);
    return {
        total: all.length,
        unfinished: all.filter(t => t.status === 'pending' || t.status === 'running').length,
    };
}

export { MediaTaskManager };
