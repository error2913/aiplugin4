// 图片索引：海豹 storage 没有遍历能力，清理任务靠这里的分片索引找到所有图片记录。
// 索引只记「存活所需的最少信息」：最后使用时间 + 图床 blob id（用于变更对账）。
import { getHost } from "../core/host";

/** 分片数（索引写入摊到 64 个 key，避免单 key 过大） */
export const IMAGE_INDEX_SHARDS = 64;

export interface ImageIndexEntry {
    /** 最后一次使用时间（ms） */
    u: number;
    /** 图床 blob id（空 = 未入库） */
    h?: string;
}

function shardOf(imageId: string): number {
    let h = 0;
    for (let i = 0; i < imageId.length; i++) h = (h * 31 + imageId.charCodeAt(i)) >>> 0;
    return h % IMAGE_INDEX_SHARDS;
}

function shardKey(n: number): string {
    return `image_idx:${n.toString(16).padStart(2, '0')}`;
}

class _ImageIndex {
    private static cache = new Map<number, Record<string, ImageIndexEntry>>();

    private static load(n: number): Record<string, ImageIndexEntry> {
        const cached = this.cache.get(n);
        if (cached) return cached;
        let data: Record<string, ImageIndexEntry> = {};
        try {
            const raw = getHost().storage.get(shardKey(n));
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
            }
        } catch (_e) {
            data = {};
        }
        this.cache.set(n, data);
        return data;
    }

    private static save(n: number, shard: Record<string, ImageIndexEntry>): void {
        getHost().storage.set(shardKey(n), JSON.stringify(shard));
    }

    /** 记录/刷新一张图片的索引（使用时间 + 图床 id） */
    static touch(imageId: string, lastUsedAt: number, hostedId = ''): void {
        if (!imageId) return;
        const used = Math.max(0, Math.floor(lastUsedAt || 0)) || Date.now();
        const n = shardOf(imageId);
        const shard = this.load(n);
        const prev = shard[imageId];
        const hosted = hostedId || '';
        if (prev && prev.u === used && (prev.h || '') === hosted) return;
        shard[imageId] = hosted ? { u: used, h: hosted } : { u: used };
        this.save(n, shard);
    }

    static remove(imageId: string): void {
        if (!imageId) return;
        const n = shardOf(imageId);
        const shard = this.load(n);
        if (!shard[imageId]) return;
        delete shard[imageId];
        this.save(n, shard);
    }

    /** 枚举全部索引条目 */
    static all(): Array<{ id: string; entry: ImageIndexEntry }> {
        const out: Array<{ id: string; entry: ImageIndexEntry }> = [];
        for (let n = 0; n < IMAGE_INDEX_SHARDS; n++) {
            const shard = this.load(n);
            for (const id of Object.keys(shard)) out.push({ id, entry: shard[id] });
        }
        return out;
    }

    /** 测试用：清掉内存缓存（重新从 storage 读） */
    static resetForTest(): void {
        this.cache.clear();
    }
}

export const ImageIndex = _ImageIndex;
export default ImageIndex;
