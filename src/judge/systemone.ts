// System One 决策模型的响应 → 六维分数（L2，纯函数）。
//
// 只读 answers[dim].score（概率加权档位索引 0..N-1），按 criteria.length-1 映射到 0~10。
// 缺问题/非数值 → 该维不返回（由 mergeDims 回退规则值）；全部无效 → null（失败即 WAIT）。
import type { JudgeDims } from './features';
import { JUDGE_SCORE_QUESTIONS, type JudgeScoreQuestionKey } from './prompt';

const DIM_KEYS: JudgeScoreQuestionKey[] = [
    'addressed', 'help_signal', 'relevance', 'friendships', 'silence_gap', 'interruption_risk',
];

function round(value: number): number {
    return Math.round(value * 10000) / 10000;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

/** 把 System One 的 answers 归一化成六维中模型可提供的那部分分数 */
export function parseSystemOneAnswers(data: unknown): Partial<JudgeDims> | null {
    if (!data || typeof data !== 'object') return null;
    const answers = (data as { answers?: unknown }).answers;
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return null;

    const out: Partial<JudgeDims> = {};
    let any = false;
    for (const key of DIM_KEYS) {
        const answer = (answers as Record<string, unknown>)[key];
        if (!answer || typeof answer !== 'object') continue;
        const raw = (answer as { score?: unknown }).score;
        const num = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN);
        if (!Number.isFinite(num)) continue;
        const levels = JUDGE_SCORE_QUESTIONS[key].criteria.length;
        const value = levels > 1 ? (num / (levels - 1)) * 10 : num;
        out[key] = round(clamp(value, 0, 10));
        any = true;
    }
    return any ? out : null;
}
