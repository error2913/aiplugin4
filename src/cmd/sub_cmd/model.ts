// .ai model：查看/绑定全局分用途模型 + 模型列表（加载快照 / 立即拉取）
import { savePurposeModelOverrides } from "../../config/configs/model";
import Model, { ConnState, ModelEntry } from "../../model/model";
import { ModelUse } from "../../model/types";
import { M } from "../privilege";
import { SubCmd, SubCmdContext } from "../root_cmd";

const MODEL_PURPOSES: ModelUse[] = ['chat', 'compression', 'summarization', 'judge', 'image-understanding', 'text-embedding'];

const PURPOSE_LABEL: Record<ModelUse, string> = {
    chat: '对话',
    compression: '压缩',
    summarization: '总结',
    judge: '评分',
    'image-understanding': '识图',
    'text-embedding': '嵌入'
};

const TAG_LABEL: Record<string, string> = {
    text: '文本',
    vision: '识图',
    embed: '嵌入',
    gen: '生图'
};

function isPurpose(value: string): value is ModelUse {
    return (MODEL_PURPOSES as string[]).includes(value);
}

function entryTagsText(e: ModelEntry): string {
    return e.tags.map(t => TAG_LABEL[t] ?? t).join('/');
}

/** 连接状态单行（供 list / 总览 / status 复用） */
export function formatConnState(state: ConnState): string {
    const head = `[${state.connIndex}] ${state.provider || '(未知)'} · ${state.baseUrl || '(无地址)'}`;
    if (state.status === 'ignored') return `${head} · 已忽略`;
    if (state.status === 'pending') return `${head} · 拉取中…`;
    if (state.status === 'error') return `${head} · ${state.errorText || '拉取失败'}`;
    const sourceLabel = state.source === 'pinned' ? '钉住' : state.source === 'cache' ? '缓存' : '自动';
    return `${head} · ${sourceLabel} · ${state.modelNames.length} 个模型`;
}

/** 展示全部连接与对应模型列表（数据源：加载/最近一次保存的列表，不联网） */
export function formatModelList(connFilter?: (st: ConnState) => boolean): string {
    const states = Model.states;
    const show = connFilter ? states.filter(connFilter) : states;
    if (show.length === 0) return '（未配置任何 api连接）';

    // 全量模型名计数：重名模型在列表里标注 [序号]:模型名，唯一名直接裸名
    const counts = new Map<string, number>();
    for (const st of states) {
        if (st.status !== 'ok') continue;
        for (const name of st.modelNames) counts.set(name, (counts.get(name) || 0) + 1);
    }

    const lines: string[] = [];
    for (const st of show) {
        lines.push(formatConnState(st));
        if (st.status === 'ok' && st.modelNames.length > 0) {
            const perConnLimit = 100;
            const shown = st.modelNames.slice(0, perConnLimit);
            for (const name of shown) {
                const display = (counts.get(name) || 0) > 1 ? `[${st.connIndex}]:${name}` : name;
                const entry = Model.entries.find(e => e.connIndex === st.connIndex && e.name === name);
                const tag = entry ? `（${entryTagsText(entry)}）` : '';
                lines.push(`  - ${display}${tag}`);
            }
            if (st.modelNames.length > perConnLimit) {
                lines.push(`  …（共 ${st.modelNames.length} 个，仅展示前 ${perConnLimit} 个）`);
            }
        } else if (st.status === 'ok') {
            lines.push('  （该连接无可用模型）');
        }
    }
    return lines.join('\n');
}

/** 单用途当前状态 + 候选列表 */
function formatPurpose(use: ModelUse): string {
    const candidates = Model.listModelsForUse(use);
    const overrideRef = Model.purposeModelOverrides[use];
    const overrideEntry = overrideRef ? Model.findModelByRef(overrideRef, use) : null;
    let effective = overrideEntry;
    if (!effective && candidates.length === 1) effective = candidates[0];

    let currentText: string;
    if (overrideEntry) {
        currentText = `${overrideEntry.ref}（全局覆盖）`;
    } else if (overrideRef) {
        currentText = `${overrideRef} 已失效，当前默认: ${effective ? effective.ref : '（无）'}`;
    } else if (effective) {
        currentText = `${effective.ref}（配置默认）`;
    } else {
        currentText = candidates.length > 0
            ? '（候选多个，未自动默认，请用 .ai model <用途> <模型> 指定）'
            : '（未配置可用模型）';
    }

    let text = `${PURPOSE_LABEL[use]}（${use}）: ${currentText}`;
    if (candidates.length > 0) {
        const listText = candidates.map((c, i) => `${i + 1}. ${c.ref}${c.isMultimodal ? '（多模态）' : ''}${c.ref === overrideRef ? '（覆盖）' : ''}${effective && c.ref === effective.ref ? '（当前）' : ''}`).join('\n');
        text += `\n候选模型:\n${listText}`;
    }
    return text;
}

/** 候选内解析用户输入：完整 ref / 裸名唯一 / 编号 / 歧义 */
function resolveCandidate(raw: string, candidates: ModelEntry[]): ModelEntry | { ambiguous: ModelEntry[] } | null {
    if (/^\[\d+\]:.+$/.test(raw)) {
        return candidates.find(c => c.ref === raw) || null;
    }
    const idx = parseInt(raw, 10);
    if (String(idx) === raw && idx >= 1 && idx <= candidates.length) {
        return candidates[idx - 1];
    }
    const matched = candidates.filter(c => c.name === raw);
    if (matched.length === 1) return matched[0];
    if (matched.length > 1) return { ambiguous: matched };
    return null;
}

function setPurposeModel(scc: SubCmdContext, purpose: ModelUse, raw: string) {
    const { ctx, msg, ret } = scc;
    const candidates = Model.listModelsForUse(purpose);
    const target = resolveCandidate(raw, candidates);
    if (!target) {
        const listText = candidates.map(c => c.ref).join('、');
        seal.replyToSender(ctx, msg, `模型 ${raw} 不存在${PURPOSE_LABEL[purpose]}用途，可用的模型: ${listText || '（无）'}`);
        return ret;
    }
    if ('ambiguous' in target) {
        const listText = target.ambiguous.map(c => c.ref).join('\n');
        seal.replyToSender(ctx, msg, `模型名 ${raw} 在${PURPOSE_LABEL[purpose]}用途下存在多个同名模型，请使用完整标识:\n${listText}`);
        return ret;
    }

    Model.purposeModelOverrides[purpose] = target.ref;
    savePurposeModelOverrides();
    seal.replyToSender(ctx, msg, `已设置${PURPOSE_LABEL[purpose]}（${purpose}）全局模型: ${target.ref}`);
    return ret;
}

export function registerCmdModel() {
    const cmd = new SubCmd('model');
    cmd.desc = '查看/设置全局分用途模型与模型列表';
    cmd.help = `帮助:
【.ai model】查看全部分用途模型与连接状态
【.ai model list】展示加载/最近一次保存的模型列表（不联网，按连接序号分组）
【.ai model pull】立即重新拉取全部连接的可用模型列表并展示
【.ai model <用途>】查看指定用途可用模型
【.ai model <用途> <模型标识>】设置指定用途的全局模型（支持编号/裸名/[连接序号]:模型名）
用途: chat / compression / summarization / judge / image-understanding / text-embedding`;
    cmd.priv = { priv: M };
    cmd.solve = async (scc: SubCmdContext) => {
        const { ctx, msg, cmdArgs, ret } = scc;
        const val2 = cmdArgs.getArgN(2);
        const val3 = cmdArgs.getArgN(3);

        if (val2 === 'list') {
            await Model.ensureLoaded();
            seal.replyToSender(ctx, msg, `当前模型列表（连接 ${Model.states.filter(s => s.status !== 'ignored').length} 条）:\n${formatModelList()}`);
            return ret;
        }

        if (val2 === 'pull') {
            await Model.pull();
            seal.replyToSender(ctx, msg, `已重新拉取模型列表（连接 ${Model.states.filter(s => s.status !== 'ignored').length} 条）:\n${formatModelList()}`);
            return ret;
        }

        if (!val2) {
            await Model.ensureLoaded();
            const text = MODEL_PURPOSES.map(use => formatPurpose(use)).join('\n\n');
            const conns = formatModelList().split('\n');
            const connSummary = conns.slice(0, 30).join('\n') + (conns.length > 30 ? `\n…（共 ${conns.length} 行，详情 .ai model list）` : '');
            seal.replyToSender(ctx, msg, `当前全局模型:\n${text}\n\n连接状态:\n${connSummary}`);
            return ret;
        }

        if (isPurpose(val2)) {
            if (!val3) {
                seal.replyToSender(ctx, msg, formatPurpose(val2));
                return ret;
            }
            return setPurposeModel(scc, val2, val3);
        }

        // 兼容旧写法：.ai model <模型名> 等价于设置 chat 全局模型
        return setPurposeModel(scc, 'chat', val2);
    }
}
