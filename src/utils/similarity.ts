// 文本相似度工具（叶子模块）：余弦相似度与公共元素。
import { logger } from "../logger";
// 计算余弦相似度
export function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
        logger.error(`cosineSimilarity: 向量维度必须相同，a: ${a.length}, b: ${b.length}`);
        return 0;
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function getCommonItem(a: string[], b: string[]): string[] {
    if (a.length === 0 || b.length === 0) return [];
    const aset = new Set(a);
    return b.filter(u => aset.has(u));
}
