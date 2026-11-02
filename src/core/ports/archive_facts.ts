// 归档事实接收端口（L0）：上下文层（context/compact）不 import memory，
// 由组合根 src/index.ts 注册实现，把「归档段抽出的 facts」交给记忆层写库。
//
// 分层：本文件只依赖类型；context(L3) 与 memory(L2) 都只依赖本端口，不互相引用。

export interface ArchiveFactsInput {
    sessionId: string;
    agentName: string;
    /** 归档段抽出的原始 facts（字段与 extract_prompt 一致） */
    facts: unknown[];
    epoch: number;
    fromSeq: number;
    toSeq: number;
}

/** 返回本次写入触及的 bank id（供调度器排巩固） */
export type ArchiveFactsSink = (input: ArchiveFactsInput) => Promise<string[]>;

let sink: ArchiveFactsSink | null = null;

export function setArchiveFactsSink(fn: ArchiveFactsSink | null): void {
    sink = fn;
}

export function getArchiveFactsSink(): ArchiveFactsSink | null {
    return sink;
}
