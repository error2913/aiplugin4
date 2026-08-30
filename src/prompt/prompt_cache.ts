// prompt 分层缓存：只缓存 system prompt 的静态壳与短期动态段，避免连续对话重复 embedding。
// 仅使用海豹 Goja 可运行的 ES6 能力：Map、Date.now、Promise，不引入 WeakRef/structuredClone 等现代 API。

interface CacheEntry {
    value?: string;
    expiresAt: number;
    promise?: Promise<string>;
}

const cache = new Map<string, CacheEntry>();
const MAX_CACHE_ENTRIES = 1000;

function pruneExpired(now: number): void {
    for (const [key, entry] of cache) {
        if (entry.value !== undefined && entry.expiresAt <= now) {
            cache.delete(key);
        }
    }
}

function ensureCapacity(): void {
    const now = Date.now();
    pruneExpired(now);

    while (cache.size > MAX_CACHE_ENTRIES) {
        const oldestKey = Array.from(cache.keys())[0];
        if (oldestKey === undefined) break;
        cache.delete(oldestKey);
    }
}

/**
 * 读取字符串缓存；未命中或已过期时执行 build，并把同一 key 的并发构建复用为同一个 Promise，
 * 防止多个请求同时重复做昂贵的记忆检索/embedding。
 */
export function getCachedString(key: string, ttlMs: number, build: () => string | Promise<string>): Promise<string> {
    const now = Date.now();
    const existing = cache.get(key);

    if (existing) {
        // LRU：命中时移到 Map 尾部，淘汰时优先淘汰最久未使用的条目
        cache.delete(key);
        cache.set(key, existing);
        if (existing.value !== undefined && now < existing.expiresAt) {
            return Promise.resolve(existing.value);
        }
        if (existing.promise) return existing.promise;
    }

    const entry: CacheEntry = { expiresAt: 0 };
    const promise = Promise.resolve().then(build);
    entry.promise = promise;
    ensureCapacity();
    cache.set(key, entry);

    promise.then(value => {
        entry.value = value;
        entry.expiresAt = Date.now() + ttlMs;
        entry.promise = undefined;
    }, () => {
        cache.delete(key);
    });

    return promise;
}

/** 按前缀清理缓存，用于记忆/总结写入后主动失效，保证新写入内容立即可见 */
export function invalidateCachedPrefix(prefix: string): void {
    for (const key of Array.from(cache.keys())) {
        if (key.startsWith(prefix)) cache.delete(key);
    }
}
