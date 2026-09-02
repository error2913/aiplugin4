// .ai model：查看/设置全局分用途模型
import { savePurposeModelOverrides } from "../../config/configs/model";
import Model, { BaseModel, ModelSource } from "../../model/model";
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

interface ModelCandidate {
    ref: string;
    name: string;
    source: ModelSource;
    configIndex: number;
    isMultimodal: boolean;
}

function isPurpose(value: string): value is ModelUse {
    return (MODEL_PURPOSES as string[]).includes(value);
}

function modelRef(m: BaseModel, source: ModelSource): string {
    return `${source}[${m.configIndex}]:${m.name}`;
}

/** 列出某用途的全部候选：use 精确匹配，不包含空 use 任意用途 */
function listModelsForPurpose(use: ModelUse): ModelCandidate[] {
    const candidates: ModelCandidate[] = [];
    const add = (models: BaseModel[], source: ModelSource) => {
        for (const m of models) {
            if (!(m as any).use.includes(use)) continue;
            candidates.push({
                ref: modelRef(m, source),
                name: m.name,
                source,
                configIndex: m.configIndex,
                isMultimodal: m.isMultimodal
            });
        }
    };

    if (use === 'image-understanding') {
        add(Model.multimodalModels, 'multimodal');
    } else if (use === 'text-embedding') {
        add(Model.embeddingModels, 'embedding');
    } else {
        add(Model.chatModels, 'text');
        add(Model.multimodalModels, 'multimodal');
    }
    return candidates;
}

function resolvePurposeModel(use: ModelUse): BaseModel | null {
    if (use === 'image-understanding') return Model.getMultimodalModel('image-understanding');
    if (use === 'text-embedding') return Model.getEmbeddingModel('text-embedding');
    return Model.getChatModel(use);
}

function formatPurpose(use: ModelUse, showList: boolean): string {
    const candidates = listModelsForPurpose(use);
    const overrideRef = Model.purposeModelOverrides[use];
    const overrideValid = overrideRef ? !!Model.findModelByRef(overrideRef, use) : false;
    const effective = resolvePurposeModel(use);

    let currentText: string;
    if (overrideValid) {
        currentText = `${overrideRef}（全局覆盖）`;
    } else if (overrideRef) {
        currentText = `${overrideRef} 已失效，当前默认: ${effective ? modelRef(effective, sourceOf(effective)) : '（无）'}`;
    } else if (effective) {
        currentText = `${modelRef(effective, sourceOf(effective))}（配置默认）`;
    } else {
        currentText = '（未配置可用模型）';
    }

    let text = `${PURPOSE_LABEL[use]}（${use}）: ${currentText}`;
    if (showList) {
        const listText = candidates.length === 0
            ? '（未配置任何可用模型）'
            : candidates.map((c, i) => `${i + 1}. ${c.ref}${c.isMultimodal ? '（多模态）' : ''}${c.ref === overrideRef ? '（覆盖）' : ''}${c.ref === (effective ? modelRef(effective, sourceOf(effective)) : '') ? '（当前）' : ''}`).join('\n');
        text += `\n可用模型:\n${listText}`;
    }
    return text;
}

function sourceOf(model: BaseModel): ModelSource {
    if (model.source && model.source !== 'text') return model.source;
    if (model.isMultimodal) return 'multimodal';
    return 'text';
}

function resolveCandidate(raw: string, candidates: ModelCandidate[]): ModelCandidate | { ambiguous: ModelCandidate[] } | null {
    if (/^(text|multimodal|embedding)\[\d+\]:.+$/.test(raw)) {
        return candidates.find(c => c.ref === raw) || null;
    }
    const matched = candidates.filter(c => c.name === raw);
    if (matched.length === 1) return matched[0];
    if (matched.length > 1) return { ambiguous: matched };
    return null;
}

function setPurposeModel(scc: SubCmdContext, purpose: ModelUse, raw: string) {
    const { ctx, msg, ret } = scc;
    const candidates = listModelsForPurpose(purpose);
    const target = resolveCandidate(raw, candidates);
    if (!target) {
        const listText = candidates.map(c => c.ref).join('、');
        seal.replyToSender(ctx, msg, `模型 ${raw} 不存在${purpose}用途，可用的模型: ${listText || '（无）'}`);
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
    cmd.desc = '查看/设置全局分用途模型';
    cmd.help = `帮助:
【.ai model】查看全部分用途模型
【.ai model <用途>】查看指定用途可用模型
【.ai model <用途> <模型标识>】设置指定用途的全局模型
用途: chat / compression / summarization / judge / image-understanding / text-embedding
模型标识格式: text[0]:模型名 / multimodal[0]:模型名 / embedding[0]:模型名`;
    cmd.priv = { priv: M };
    cmd.solve = (scc: SubCmdContext) => {
        const { ctx, msg, cmdArgs, ret } = scc;
        const val2 = cmdArgs.getArgN(2);
        const val3 = cmdArgs.getArgN(3);

        if (!val2) {
            const text = MODEL_PURPOSES.map(use => formatPurpose(use, true)).join('\n\n');
            seal.replyToSender(ctx, msg, `当前全局模型:\n${text}`);
            return ret;
        }

        if (isPurpose(val2)) {
            if (!val3) {
                seal.replyToSender(ctx, msg, formatPurpose(val2, true));
                return ret;
            }
            return setPurposeModel(scc, val2, val3);
        }

        // 兼容旧用法：.ai model <模型名> 等价于设置 chat 全局模型
        return setPurposeModel(scc, 'chat', val2);
    }
}
