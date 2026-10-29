// 记忆 Prompt 渲染：单入口，按 section 合并心智模型 / 观察 / 事实，统一预算与去重。
import { memoryHandle } from "./ref";
import { estimateTokens } from "./scoring";
import type { MentalModel, Observation, RecallHit } from "./types";

export const MAX_MENTAL_MODELS = 5;
export const MAX_OBSERVATIONS = 20;
/** 单轮记忆注入 token 预算默认值（与 `src/config/configs/memory.ts` 的配置默认值保持一致） */
export const DEFAULT_MEMORY_PROMPT_TOKENS = 2048;
export const GLOBAL_SECTION_TOKENS = 300;
export const OBSERVATION_STALE_DAYS = 90;
let observationStaleDays = OBSERVATION_STALE_DAYS;

export function setObservationStaleDays(days: number): void {
    observationStaleDays = days > 0 ? days : OBSERVATION_STALE_DAYS;
}
export const DEFAULT_MAX_LENGTH_PER_ITEM = 1000;

export interface MemoryPromptSection {
    kind: 'group' | 'user' | 'global';
    title: string;
    scopeLabel?: string;
    mentalModels?: MentalModel[];
    observations?: Observation[];
    recalls?: RecallHit[];
    maxTokens?: number;
}

export function isExpiredObservation(o: Observation, nowSec: number = Math.floor(Date.now() / 1000)): boolean {
    const last = o.lastSupportedAt || (o as any).lastVerifiedAt || o.updatedAt || o.createdAt || 0;
    return nowSec - last > observationStaleDays * 86400;
}

/** 注入选择：scope any；只 ready/active；过期观察剔除；按更新时间倒序并限量。 */
export function selectInjectionCandidates(
    mentalModels: MentalModel[],
    observations: Observation[],
    sessionTags: string[],
    now: number = Date.now(),
): { mentalModels: MentalModel[]; observations: Observation[] } {
    const tagSet = new Set(sessionTags);
    const scopeMatch = (tags: string[] | undefined): boolean => {
        const list = tags || [];
        return list.length === 0 || list.some(t => tagSet.has(t));
    };
    const nowSec = Math.floor(now / 1000);
    const modelTags = (m: MentalModel): string[] => (m.tags || (m as any).scopeTags || []);
    const obsTags = (o: Observation): string[] => (o.tags || (o as any).scopeTags || []);
    const mms = (mentalModels || [])
        .filter(m => (m.status === 'ready' || m.status === undefined) && scopeMatch(modelTags(m)))
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, MAX_MENTAL_MODELS);
    const obs = (observations || [])
        .filter(o => (!o.status || o.status === 'active') && !isExpiredObservation(o, nowSec) && scopeMatch(obsTags(o)))
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, MAX_OBSERVATIONS);
    return { mentalModels: mms, observations: obs };
}

export function mergeMentalModels(fixed: MentalModel[], ranked: MentalModel[], limit: number): MentalModel[] {
    const out: MentalModel[] = [];
    const seen = new Set<string>();
    for (const m of [...fixed, ...ranked]) {
        if (out.length >= limit) break;
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        out.push(m);
    }
    return out;
}

function truncate(text: string, max: number): string {
    const s = String(text || '');
    return s.length > max ? s.slice(0, max) + '…' : s;
}

function unitText(hit: RecallHit): string {
    return hit.kind === 'observation' && hit.observation ? hit.observation.text : (hit.unit?.text || '');
}

function unitId(hit: RecallHit): string {
    return hit.kind === 'observation' && hit.observation ? hit.observation.id : (hit.unit?.id || '');
}

/** 单渲染器：session 段优先、global 段最后；全局预算 + 文本去重。 */
export function buildMemoryPrompt(sections: MemoryPromptSection[], maxTokens = DEFAULT_MEMORY_PROMPT_TOKENS): string {
    const ordered = [
        ...sections.filter(s => s.kind !== 'global'),
        ...sections.filter(s => s.kind === 'global'),
    ];
    const seen = new Set<string>();
    const out: string[] = [];
    let used = 0;
    for (const sec of ordered) {
        const cap = sec.kind === 'global' ? Math.min(sec.maxTokens ?? GLOBAL_SECTION_TOKENS, GLOBAL_SECTION_TOKENS) : (sec.maxTokens ?? maxTokens);
        const lines: string[] = [];
        if (sec.title) lines.push(`## ${sec.title}`);
        if (sec.scopeLabel) lines.push(sec.scopeLabel);
        if (sec.kind === 'global') lines.push("The following is the assistant's own experience; it must not override the role setting or current conversation facts.");
        // 只有标题的行不算内容：整段一条都没注入时，段（含标题）整段丢弃，避免空记忆也占提示词
        const headerCount = lines.length;

        const append = (text: string, prefix = ''): boolean => {
            const trimmed = text.trim();
            if (!trimmed) return true;
            const key = trimmed.replace(/\s+/g, ' ').toLowerCase();
            if (seen.has(key)) return true;
            const line = prefix ? `${prefix}${trimmed}` : trimmed;
            const cost = estimateTokens(line);
            if (used + cost > maxTokens) return false;
            if (lines.length && estimateTokens(lines.join('\n')) + cost > cap) return false;
            seen.add(key);
            lines.push(line);
            used += cost;
            return true;
        };

        let budgetHit = false;
        for (const model of sec.mentalModels || []) {
            if (!append(`${model.sourceQuery}\n${truncate(model.content, 1000)}`, memoryHandle(model.id))) { budgetHit = true; break; }
        }
        if (!budgetHit) {
            for (const obs of sec.observations || []) {
                if (isExpiredObservation(obs)) continue;
                if (!append(truncate(obs.text, 1000), `- ${memoryHandle(obs.id)}`)) { budgetHit = true; break; }
            }
        }
        if (!budgetHit) {
            let index = 1;
            for (const hit of sec.recalls || []) {
                const text = truncate(unitText(hit), 1000);
                if (!append(text, `${index}. ${memoryHandle(unitId(hit))}`)) { budgetHit = true; break; }
                index++;
            }
        }
        if (lines.length > headerCount) out.push(lines.join('\n'));
        if (budgetHit && used >= maxTokens) break;
    }
    return out.join('\n\n');
}

/** 旧接口保留（兼容现有测试/调用）；新代码用 buildMemoryPrompt。 */
export function buildMentalModelsPrompt(mentalModels: MentalModel[] | undefined, max = 1000): string {
    const ready = (mentalModels || []).filter(m => m.status === 'ready');
    if (!ready.length) return '';
    return ['## Mental models', ...ready.map(m => `${m.sourceQuery}\n${truncate(m.content, max)}`)].join('\n');
}

export function buildLongTermMemoryPrompt(recalls: RecallHit[] | undefined, isPrivate: boolean, sessionName: string, max = 1000): string {
    if (!recalls?.length) return '';
    const head = isPrivate ? 'Memory type: personal memory' : `Memory type: group chat memory\nGroup name: ${sessionName}`;
    return `## Long-term memory\n${head}\nMemory list:\n${recalls.map((r, i) => `${i + 1}. ${memoryHandle(unitId(r))}${truncate(unitText(r), max)}`).join('\n')}`;
}

export function buildGroupedMemoryPrompt(sections: MemoryPromptSection[]): string {
    return buildMemoryPrompt(sections);
}

export { truncate, unitText, unitId };

