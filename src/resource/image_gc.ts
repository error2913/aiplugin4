import Config from "../config/config";
import { getHost } from "../core/host";
// 图片清理与图床对账：
//   1. trim：删除超过「图片清理天数」未使用的图片记录（内存里正在用的跳过），并通知图床释放 ref
//   2. flushPending：图床暂时不可用时，释放失败的 ref 存待补发队列，下次再试
//   3. syncChanges：消费图床 change_log（WebUI 删除 / 容量淘汰），把对应图片标记为不可用并清掉图床字段
//
// 交叉清理的前提：插件的「删除」只发生在自己这条时间线上；图床侧的删除永远先看引用计数，
// 一条 ref 被释放不会带走还有别的 ref 的字节。两边都按 ref 幂等处理，重复释放只是 released=0。
import { logger } from "../logger";

import Image from "./image";
import { ImageHost } from "./image_host";
import { ImageIndex } from "./image_index";

const log = logger.withTag('image-gc');

const CURSOR_KEY = 'image_host_cursor';
const PENDING_KEY = 'image_release_pending';

/** 单次清理上限：避免一次删太多导致 storage 写入抖动 */
const MAX_PER_RUN = 500;
/** 待补发队列上限 */
const MAX_PENDING = 5000;

const START_DELAY_MS = 60 * 1000;
const RUN_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface GcReport {
    /** 删掉的图片记录数 */
    deleted: number;
    /** 成功通知图床的 ref 数 */
    released: number;
    /** 对账后标记为失效的图片数 */
    broken: number;
    /** 仍待补发的 ref 数 */
    pending: number;
    /** 对账时确认图床已不存在、被标记失效的图片数 */
    reconciled: number;
}

function isTransientId(imageId: string): boolean {
    return imageId.startsWith('user_avatar:') || imageId.startsWith('group_avatar:');
}

function readPending(): string[] {
    try {
        const raw = getHost().storage.get(PENDING_KEY);
        if (!raw) return [];
        const data = JSON.parse(raw);
        return Array.isArray(data) ? data.filter((x: any) => typeof x === 'string' && x) : [];
    } catch (_e) {
        return [];
    }
}

function writePending(refs: string[]): void {
    getHost().storage.set(PENDING_KEY, JSON.stringify(Array.from(new Set(refs)).slice(0, MAX_PENDING)));
}

function chunk<T>(list: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
}

class _ImageGC {
    private static started = false;

    /** 找出超过保留期未使用的图片（内存里还在用的不删） */
    static collectStale(days: number, now = Date.now()): string[] {
        if (days <= 0) return [];
        const cutoff = now - days * 86400_000;
        const stale: string[] = [];
        for (const { id, entry } of ImageIndex.all()) {
            if (stale.length >= MAX_PER_RUN) break;
            if (!id || isTransientId(id)) continue;
            // 没有索引时间的旧数据不猜：宁可不清，也不能误删
            if (!entry || !entry.u || entry.u > cutoff) continue;
            if (Image.imageMap[id]) continue;   // 正在内存里使用
            stale.push(id);
        }
        return stale;
    }

    /** 删除过期记录并释放 ref；返回删掉的记录数 */
    static async trim(days = Config.image.IMAGE_GC_DAYS): Promise<number> {
        const stale = this.collectStale(Number(days) || 0);
        if (!stale.length) return 0;
        for (const id of stale) {
            getHost().storage.set(`image_${id}`, '');
            ImageIndex.remove(id);
            delete Image.imageMap[id];
        }
        await this.releaseRefs(stale);
        log.info(`清理过期图片 ${stale.length} 条`);
        return stale.length;
    }

    /** 把 refs 交给图床释放；失败的进待补发队列。返回成功释放的条数 */
    static async releaseRefs(refs: string[]): Promise<number> {
        const all = Array.from(new Set([...readPending(), ...refs.filter(Boolean)]));
        if (!all.length) return 0;
        if (!ImageHost.enabled) {
            // 图床已被移除：本地记录可以删，但没有地方可释放，丢掉队列即可
            writePending([]);
            return 0;
        }
        const done: string[] = [];
        for (const part of chunk(all, 500)) {
            if (!(await ImageHost.release(part))) break;
            done.push(...part);
        }
        const doneSet = new Set(done);
        writePending(all.filter(ref => !doneSet.has(ref)));
        return done.length;
    }

    /** 补发之前失败的释放请求 */
    static async flushPending(): Promise<number> {
        const pending = readPending();
        if (!pending.length) return 0;
        return this.releaseRefs(pending);
    }

    /** 图床侧删除 → 插件标记图片不可用 */
    static markBroken(imageId: string, blobId = ''): boolean {
        const img = Image.get(imageId);
        if (!img) return false;
        if (blobId && img.hostedId && img.hostedId !== blobId) return false;   // 旧事件，跳过
        const used = img.lastUsedAt;
        img.urlBroken = true;
        img.hostedUrl = '';
        img.hostedId = '';
        img.hostedAt = 0;
        img.base64 = '';
        // 不因「被图床删了」而续命：保持原使用时间，让清理任务照常到期
        img.lastUsedAt = used;
        Image.save(img);
        return true;
    }

    /** 处理一条 change_log 事件；返回是否标记了图片 */
    static handleEvent(ev: any): number {
        if (!ev) return 0;
        const kind = String(ev.kind || '');
        if (kind !== 'delete_ref' && kind !== 'delete_blob' && kind !== 'purge_blob') return 0;
        const ref = String(ev.ref || '');
        const blobId = String(ev.blob_id || '');
        if (ref) return this.markBroken(ref, blobId) ? 1 : 0;
        if (!blobId) return 0;
        // 没有 ref 的事件（容量淘汰 / 回收站过期）：按 blob id 找索引里的图片
        let marked = 0;
        for (const { id, entry } of ImageIndex.all()) {
            if (entry && entry.h === blobId && this.markBroken(id, blobId)) marked++;
        }
        return marked;
    }

    /** 消费图床变更日志；返回标记失效的图片数 */
    static async syncChanges(): Promise<number> {
        if (!ImageHost.enabled) return 0;
        let cursor = parseInt(getHost().storage.get(CURSOR_KEY) || '0') || 0;
        let marked = 0;
        for (let round = 0; round < 20; round++) {
            const data = await ImageHost.fetchChanges(cursor, 500);
            if (!data) return marked;
            if (data.reset) {
                // 日志已被裁掉：这一轮没法补，接受当前 head，下轮从新事件开始
                getHost().storage.set(CURSOR_KEY, String(data.cursor));
                return marked;
            }
            for (const ev of data.events) marked += this.handleEvent(ev);
            cursor = data.cursor;
            getHost().storage.set(CURSOR_KEY, String(cursor));
            if (data.events.length < 500) break;
        }
        if (marked) log.info(`图床删除对账：标记 ${marked} 张图片不可用`);
        return marked;
    }

    /** 对账：索引里所有「有图床 id」的图片，向图床批量确认还在不在；缺失的标失效 */
    static async reconcile(): Promise<number> {
        if (!ImageHost.enabled) return 0;
        const hosted = ImageIndex.all().filter(({ id, entry }) =>
            !!id && !isTransientId(id) && !!entry && !!entry.h);
        if (!hosted.length) return 0;
        const blobOf = new Map(hosted.map(({ id, entry }) => [id, String(entry.h)]));
        const refs = hosted.map(({ id }) => id);
        let marked = 0;
        for (let i = 0; i < refs.length; i += 500) {
            const part = refs.slice(i, i + 500);
            const missing = await ImageHost.exists(part);
            if (!missing) return marked;   // 网络失败：本轮跳过对账，不误伤
            for (const id of missing) {
                if (this.markBroken(id, blobOf.get(id) || '')) marked++;
            }
        }
        if (marked) log.info(`图床对账：标记 ${marked} 张图片不可用`);
        return marked;
    }

    /** 跑一轮：变更对账 → exists 对账 → 清理 → 补发 */
    static async runOnce(): Promise<GcReport> {
        const report: GcReport = { deleted: 0, released: 0, broken: 0, pending: 0, reconciled: 0 };
        try {
            report.broken = await this.syncChanges();
        } catch (e) {
            log.exception('图床变更对账失败', e);
        }
        try {
            report.reconciled = await this.reconcile();
        } catch (e) {
            log.exception('图床引用对账失败', e);
        }
        try {
            report.deleted = await this.trim();
        } catch (e) {
            log.exception('图片清理失败', e);
        }
        try {
            report.released = await this.flushPending();
        } catch (e) {
            log.exception('补发图床释放失败', e);
        }
        report.pending = readPending().length;
        return report;
    }

    /** 启动延迟跑一轮，然后每 6 小时一轮（JSON 重载后旧定时器会被清掉，避免叠加） */
    static init(): void {
        if (this.started) return;
        this.started = true;
        if (ImageHost.enabled) {
            log.info(`图床已启用：${ImageHost.base}（对外地址=${ImageHost.externalBase || '未配置→发图/模型降级'}），图片清理天数=${Config.image.IMAGE_GC_DAYS || 0}，启动 60s 后开始清理/对账`);
        }
        const g = globalThis as any;
        const old = g.__imageGcTimers;
        if (old) {
            try { clearTimeout(old.probe); } catch (_e) { /* ignore */ }
            try { clearTimeout(old.timer); } catch (_e) { /* ignore */ }
            try { clearInterval(old.interval); } catch (_e) { /* ignore */ }
        }
        const run = () => {
            void this.runOnce().then(r => {
                if (r.deleted || r.released || r.broken || r.reconciled) {
                    log.info(`图片清理：删除 ${r.deleted} 条，释放 ${r.released} 条，变更对账 ${r.broken} 条，引用对账 ${r.reconciled} 条，待补发 ${r.pending} 条`);
                }
            });
        };
        // 启动后探一次可用性（只记日志，不因此禁用图床）
        const probe = () => {
            if (!ImageHost.enabled) return;
            void ImageHost.probe().then(ok => {
                if (!ok) log.warning('图床探测失败（/api/health 不通）：抓取/取图会按失败规则降级，检查「图床」地址与后端是否启动');
            });
        };
        const timers = {
            probe: setTimeout(probe, 5000),
            timer: setTimeout(run, START_DELAY_MS),
            interval: setInterval(run, RUN_INTERVAL_MS),
        };
        // Node 环境下（smoke/单测）让定时器不阻止进程退出；goja 的 timer id 是数字，没有 unref
        for (const t of Object.values(timers)) {
            try { (t as any)?.unref?.(); } catch (_e) { /* ignore */ }
        }
        g.__imageGcTimers = timers;
    }

    /** 测试用：停掉定时器并重置内存状态 */
    static resetForTest(): void {
        this.started = false;
        const g = globalThis as any;
        const old = g.__imageGcTimers;
        if (old) {
            try { clearTimeout(old.probe); } catch (_e) { /* ignore */ }
            try { clearTimeout(old.timer); } catch (_e) { /* ignore */ }
            try { clearInterval(old.interval); } catch (_e) { /* ignore */ }
            delete g.__imageGcTimers;
        }
        ImageIndex.resetForTest();
    }
}

export const ImageGC = _ImageGC;
export default ImageGC;
