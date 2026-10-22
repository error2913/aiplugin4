// .ai model：查看/绑定全局分用途模型 + 模型列表（加载快照 / 立即拉取）
import { savePurposeModelOverrides } from "../../config/apply/model";
import Model, { ConnState, ModelEntry } from "../../model/model";
import { ModelUse } from "../../model/types";
import { M } from "../privilege";
import { SubCmd, SubCmdContext } from "../root_cmd";

const MODEL_PURPOSES: ModelUse[] = ['chat', 'compression', 'summarization', 'judge', 'image-understanding', 'text-embedding', 'tts', 'image-generation'];

const PURPOSE_LABEL: Record<ModelUse, string> = {
    chat: '对话',
    compression: '压缩',
    summarization: '总结',
    judge: '评分',
    'image-understanding': '识图',
    'text-embedding': '嵌入',
    tts: '语音',
    'image-generation': '生图'
};

const TAG_LABEL: Record<string, string> = {
    text: '文本',
    vision: '识图',
    embed: '嵌入',
    gen: '生图',
    tts: '语音'
};

function isPurpose(value: string): value is ModelUse {
    return (MODEL_PURPOSES as string[]).includes(value);
}

function entryTagsText(e: ModelEntry): string {
    return e.tags.map(t => TAG_LABEL[t] ?? t).join('/');
}

/** 参与展示/统计的连接：ignore=1 的忽略连接不出现在任何指令里 */
function activeStates(): ConnState[] {
    return Model.states.filter(s => s.status !== 'ignored');
}

/** 连接状态单行（供 list / 总览 / status 复用；只传非 ignore 连接） */
export function formatConnState(state: ConnState): string {
    const head = `[${state.connIndex}] ${state.provider || '(未知)'} · ${state.baseUrl || '(无地址)'}`;
    if (state.status === 'pending') return `${head} · 拉取中…`;
    if (state.status === 'error') return `${head} · ${state.errorText || '拉取失败'}`;
    const sourceLabel = state.source === 'pinned' ? '钉住' : '自动';
    return `${head} · ${sourceLabel} · ${state.modelNames.length} 个模型`;
}

/** 展示全部连接与对应模型列表（数据源：加载/最近一次拉取到内存的列表，不联网、不持久化；忽略连接不显示） */
export function formatModelList(connFilter?: (st: ConnState) => boolean): string {
    const base = activeStates();
    const show = connFilter ? base.filter(connFilter) : base;
    if (show.length === 0) return '（未配置任何连接）';

    // 全量模型名计数：重名模型在列表里标注 [序号]:模型名，唯一名直接裸名
    const counts = new Map<string, number>();
    for (const st of base) {
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

/**
 * 单用途当前模型（供总览与单用途查看共用；不内嵌候选）。
 * 标注**当前值来自哪一层**（方案 2.3.3）：运行时覆盖 > 配置绑定 > 自动首个可用。
 * 不标注的话用户会困惑"我改了为什么配置里没变"。
 */
function formatPurpose(use: ModelUse): string {
    const autoEntry = Model.listModelsForUse(use)[0] ?? null;
    const overrideRef = Model.purposeModelOverrides[use];
    const configList = Model.configPurposes[use] ?? [];
    const overrideEntry = overrideRef ? Model.findModelByRef(overrideRef, use) : null;
    // 配置绑定是**有序数组**：生效的是第一个仍然有效的
    const configEntry = configList.reduce<ReturnType<typeof Model.findModelByRef>>(
        (acc, id) => acc ?? Model.findModelByRef(id, use), null);
    const effective = overrideEntry ?? configEntry ?? autoEntry;

    let currentText: string;
    if (overrideEntry) {
        currentText = `${overrideEntry.ref}（运行时覆盖 · 由 .ai model 设置）`;
    } else if (configEntry) {
        const rank = configList.indexOf(configEntry.ref) + 1;
        currentText = `${configEntry.ref}（配置绑定 #${rank}/${configList.length} · 来自「模型配置」的 purposes）`;
    } else if (effective) {
        currentText = `${effective.ref}（自动 · 首个可用）`;
    } else {
        currentText = '（未配置可用模型）';
    }
    // 失效的层要显式提示，否则用户看不到"我设过但它没生效"
    const stale: string[] = [];
    if (overrideRef && !overrideEntry) stale.push(`运行时覆盖 ${overrideRef}`);
    if (configList.length > 0 && !configEntry) stale.push(`配置绑定 ${configList.join(' / ')}`);
    if (stale.length) currentText += `\n     ⚠ 已失效并回退：${stale.join('、')}`;

    return `${PURPOSE_LABEL[use]}（${use}）: ${currentText}`;
}

/** 单用途详情：当前模型 + 该用途候选列表（.ai model <用途>） */
function formatPurposeDetail(use: ModelUse): string {
    const candidates = Model.listModelsForUse(use);
    const overrideRef = Model.purposeModelOverrides[use];
    const configList = Model.configPurposes[use] ?? [];

    let text = formatPurpose(use);
    if (candidates.length === 0) return text;
    // 候选已按用户顺序排（listModelsForUse 内排序），这里把绑定序号标出来，
    // 用户一眼能看出"插件会按什么顺序取用"
    const listText = candidates.map((c, i) => {
        const marks: string[] = [];
        if (c.isMultimodal) marks.push('多模态');
        if (c.ref === overrideRef) marks.push('运行时覆盖');
        const rank = configList.indexOf(c.ref);
        if (rank >= 0) marks.push(`绑定 #${rank + 1}`);
        return `${i + 1}. ${c.ref}${marks.length ? `（${marks.join('/')}）` : ''}`;
    }).join('\n');
    text += `\n候选模型（按取用顺序）:\n${listText}`;
    return text;
}

/** 连接状态简表（只含非忽略连接，仅一行/连接：状态与模型数；完整模型见 .ai model list） */
function formatConnSummary(): string {
    const states = activeStates();
    if (states.length === 0) return '（未配置任何连接）';
    return states.map(formatConnState).join('\n');
}

/** 候选内解析用户输入：完整 ref（v5 模型 id）/ 模型名（唯一）/ 编号 / 歧义 */
function resolveCandidate(raw: string, candidates: ModelEntry[]): ModelEntry | { ambiguous: ModelEntry[] } | null {
    if (/^\[\d+\]:.+$/.test(raw)) {
        return candidates.find(c => c.ref === raw) || null;
    }
    const idx = parseInt(raw, 10);
    if (String(idx) === raw && idx >= 1 && idx <= candidates.length) {
        return candidates[idx - 1];
    }
    // v5：ref 是配置里的**模型 id**，可能与模型名不同，故先按 ref 精确匹配
    const byRef = candidates.filter(c => c.ref === raw);
    if (byRef.length === 1) return byRef[0];
    if (byRef.length > 1) return { ambiguous: byRef };
    // 退回按模型名匹配（用户更可能直接抄平台上的模型名）
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
        seal.replyToSender(ctx, msg, `模型 ${raw} 不存在${PURPOSE_LABEL[purpose]}用途，请用 .ai model list 查看可用模型后重试`);
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
【.ai model】查看全部分用途当前模型与连接状态
【.ai model list】展示加载/最近一次拉取的模型列表（不联网，按连接序号分组）
【.ai model pull】立即重拉全部连接的模型列表并展示（无视配置里的 models 钉住清单，强制走网络）
【.ai model <用途>】查看指定用途当前模型与该用途候选
【.ai model <用途> <模型>】把指定用途绑到某模型（支持编号 / 模型 id / 模型名）
用途: chat / compression / summarization / judge / image-understanding / text-embedding / tts / image-generation
绑定有三层，本命令写的是**最上层**（运行时覆盖），优先级最高：
  1. 运行时覆盖（本命令写入，存插件存储）
  2. 配置绑定（「模型配置」里的 purposes，跟配置走、重装不丢）
  3. 自动（该用途首个可用模型）
  → 想让绑定进配置，把第 1 层选中的模型 id 填进配置的 purposes 即可。
模型类型: 配置里每个模型的 kind（text/vision/embed/gen/tts）优先；未声明时按命名推断
  （嵌入/生图/语音可推断，**视觉不会自动推断**，需在配置里写 kind:"vision"）。
说明: 全量模型列表用 .ai model list；enabled:false 的连接不参与展示/统计`;
    cmd.priv = { priv: M };
    cmd.solve = async (scc: SubCmdContext) => {
        const { ctx, msg, cmdArgs, ret } = scc;
        const val2 = cmdArgs.getArgN(2);
        const val3 = cmdArgs.getArgN(3);

        if (val2 === 'list') {
            await Model.ensureLoaded();
            seal.replyToSender(ctx, msg, `当前模型列表（连接 ${activeStates().length} 条）:\n${formatModelList()}`);
            return ret;
        }

        if (val2 === 'pull') {
            await Model.pull();
            seal.replyToSender(ctx, msg, `已重新拉取模型列表（连接 ${activeStates().length} 条）:\n${formatModelList()}`);
            return ret;
        }

        if (!val2) {
            await Model.ensureLoaded();
            const text = MODEL_PURPOSES.map(use => formatPurpose(use)).join('\n');
            seal.replyToSender(ctx, msg, `当前全局模型:\n${text}\n\n连接状态:\n${formatConnSummary()}`);
            return ret;
        }

        if (isPurpose(val2)) {
            if (!val3) {
                seal.replyToSender(ctx, msg, formatPurposeDetail(val2));
                return ret;
            }
            return setPurposeModel(scc, val2, val3);
        }

        // 兼容旧写法：.ai model <模型名> 等价于设置 chat 全局模型
        return setPurposeModel(scc, 'chat', val2);
    }
}
