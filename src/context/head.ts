// Context v2 会话头（ContextHead）：常量级索引，随会话保存/增量 flush 落盘。
// 事件本体绝不进这里；只放水位、页号范围、epoch 与近似体积。
import { CONTEXT_SCHEMA_VERSION } from "./events";

export interface LegacyIndex {
    /** 旧版归档分片水位（只读兼容/清理用） */
    archiveSeq: number;
    /** 旧版窗口移出分片水位（只读兼容/清理用） */
    rawSeq: number;
    /** 旧版结算水位（只作为迁移信息，不再由上下文消费） */
    settledSeq: number;
    /** 迁移阶段：pending=尚未迁移，flipped=已切换到 v2 */
    phase: 'pending' | 'flipped';
}

export interface ContextHead {
    version: number;
    /** 当前世代；purge 时递增，旧 epoch 的摘要/记录不参与视图 */
    epoch: number;
    /** 当前 epoch 从哪个 seq 开始（含） */
    epochStartSeq: number;
    /** 下一个待分配 seq（单调，不复用） */
    nextSeq: number;
    /** 已成功落盘到的 seq */
    persistedSeq: number;
    /** 下一个事件页号（从 1 开始，单调） */
    nextPageNo: number;
    /** 事件页清理下界：pageNo < pageFloor 视为已清理 */
    pageFloor: number;
    /** 下一个记录页号 */
    nextRecPageNo: number;
    /** 记录页清理下界 */
    recFloor: number;
    /** 当前 epoch 已摘要覆盖到的 seq（含） */
    summarizedThrough: number;
    /** 未摘要 token 估算（用于触发阈值；允许近似） */
    unsummarizedTokens: number;
    /** 事件 + 记录的近似总字节数（.ai ctx 展示用） */
    bytesTotal: number;
    /** 旧版兼容索引；无旧数据时缺省 */
    legacy?: LegacyIndex;
}

export function createEmptyHead(): ContextHead {
    return {
        version: CONTEXT_SCHEMA_VERSION,
        epoch: 1,
        epochStartSeq: 1,
        nextSeq: 1,
        persistedSeq: 0,
        nextPageNo: 1,
        pageFloor: 1,
        nextRecPageNo: 1,
        recFloor: 1,
        summarizedThrough: 0,
        unsummarizedTokens: 0,
        bytesTotal: 0,
    };
}

function asFiniteInt(value: unknown, fallback: number, min = 0): number {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.floor(n));
}

/**
 * 读取/修复一个 head：未知字段丢弃、非法数字回退默认，
 * 并保证关键单调关系（epochStart <= nextSeq、pageFloor <= nextPageNo 等）。
 * 损坏到无法修复时返回 null，由上层决定重建/报错。
 */
export function normalizeHead(raw: unknown): ContextHead | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    if (asFiniteInt(r.version, 0) !== CONTEXT_SCHEMA_VERSION) return null;
    const head = createEmptyHead();
    head.epoch = asFiniteInt(r.epoch, head.epoch, 1);
    head.epochStartSeq = asFiniteInt(r.epochStartSeq, head.epochStartSeq, 1);
    head.nextSeq = Math.max(head.epochStartSeq, asFiniteInt(r.nextSeq, head.nextSeq, 1));
    head.persistedSeq = Math.min(head.nextSeq - 1, asFiniteInt(r.persistedSeq, 0));
    head.nextPageNo = asFiniteInt(r.nextPageNo, 1, 1);
    head.pageFloor = Math.min(head.nextPageNo, asFiniteInt(r.pageFloor, 1, 1));
    head.nextRecPageNo = asFiniteInt(r.nextRecPageNo, 1, 1);
    head.recFloor = Math.min(head.nextRecPageNo, asFiniteInt(r.recFloor, 1, 1));
    head.summarizedThrough = Math.max(head.epochStartSeq - 1, Math.min(head.nextSeq - 1, asFiniteInt(r.summarizedThrough, 0)));
    head.unsummarizedTokens = asFiniteInt(r.unsummarizedTokens, 0);
    head.bytesTotal = asFiniteInt(r.bytesTotal, 0);
    if (r.legacy && typeof r.legacy === 'object') {
        const l = r.legacy as Record<string, unknown>;
        const phase = l.phase === 'pending' || l.phase === 'flipped' ? l.phase : 'flipped';
        head.legacy = {
            archiveSeq: asFiniteInt(l.archiveSeq, 0),
            rawSeq: asFiniteInt(l.rawSeq, 0),
            settledSeq: asFiniteInt(l.settledSeq, 0),
            phase,
        };
    }
    return head;
}

/** 把 head 序列化为存储字符串（保持字段顺序稳定，便于 diff/调试） */
export function serializeHead(head: ContextHead): string {
    return JSON.stringify(head);
}

export function parseHead(raw: string | null | undefined): ContextHead | null {
    if (!raw) return null;
    try {
        return normalizeHead(JSON.parse(raw));
    } catch {
        return null;
    }
}
