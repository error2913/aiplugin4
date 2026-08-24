// 记忆 Prompt 渲染：MentalModel + Observation + Recall 结果。
import type { MentalModel, Observation, RecallResult } from "./types";

export interface MemoryPromptOptions {
    isPrivate: boolean;
    sessionName: string;
    mentalModels?: MentalModel[];
    observations?: Observation[];
    recalls?: RecallResult[];
    maxLengthPerItem?: number;
}

export function buildMemoryPrompt(options: MemoryPromptOptions): string {
    const parts: string[] = [];
    const max = options.maxLengthPerItem ?? 1000;

    if (options.mentalModels?.length) {
        parts.push('## 心智模型');
        parts.push(options.mentalModels.map(m => `${m.question}\n${truncate(m.answer, max)}`).join('\n'));
    }

    if (options.observations?.length) {
        parts.push('## 观察记忆');
        parts.push(options.observations.map((o, i) => `${i + 1}. ${truncate(o.text, max)}`).join('\n'));
    }

    if (options.recalls?.length) {
        const memoryType = options.isPrivate ? '个人记忆' : '群聊记忆';
        const head = `记忆类型:${memoryType}`;
        const nameLine = options.isPrivate ? '' : `\n群聊名称:${options.sessionName}`;
        const list = options.recalls.map((r, i) => `${i + 1}. [${r.unit.id}] ${truncate(r.unit.text, max)}`).join('\n');
        parts.push(`## 长期记忆\n${head}${nameLine}\n记忆列表:\n${list}`);
    }

    return parts.join('\n\n');
}

function truncate(text: string, max: number): string {
    const s = String(text || '');
    return s.length > max ? s.slice(0, max) + '…' : s;
}

