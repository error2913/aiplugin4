// 媒体生成任务队列：把"提交即返回、完成再结算"的异步流程集中在一处。
//
// 为什么需要：工具层用 Config.base.TIMEOUT（默认 180s）包住整个 solve，而慢出图常需 300s，
// 会被工具层先杀掉；同时 AI 全程阻塞、用户看不到进度。改为 solve 只建任务入队并立即返回。
//
// 结算分流（关键）：
//   origin='command' —— 人类敲命令发起：插件直接 seal.replyToSender 投递，不经 AI；
//   origin='tool'    —— AI 调工具发起：写入会话 noticeQueue，并**直接起一轮对话**把结果发出去。
//
// 落盘策略：队列里只存句柄/短摘要（本地文件路径、Image imageId、url），绝不存 base64，
// 避免 ext.storageSet 与会话存档被撑爆；原始 base64 在 run() 作用域内落地后即弃。
import Config from "../config/config";
import { getHost } from "../core/host";
import { setMediaNotifiedHandler } from "../core/ports/media_notice";
import { logger } from "../logger";
import { MediaResult } from "../model/media";
import Model, { ModelEntry } from "../model/model";
import Image from "../resource/image";
import { ImageHost } from "../resource/image_host";
import { Session } from "../session/session";
import { getSession } from "../session/session_service";
import { generateId } from "../utils/id";
import { getSessionCtxAndMsg } from "../utils/seal";
import { getPlatform } from "../utils/target_id";

const log = logger.withTag('media');

export type MediaTaskKind = 'tts' | 'tti';
export type MediaTaskOrigin = 'tool' | 'command';
export type MediaTaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'canceled';

export interface MediaTaskResult {
    /** 结果种类：语音（record 段）或图片 */
    kind: 'record' | 'image';
    /**
     * **可直接交给 `replyToSender` / 消息段发送的 CQ 文本**。
     * 图片必须是真实文件路径或 URL（`Image.getSendFile()` 解析结果），不能是插件内部 imageId ——
     * 协议端不认识 imageId，直接发 `[CQ:image,file=<imageId>]` 会发不出去。
     */
    send: string;
    /** 语音：本地文件路径或 URL；图片：imageId（供 AI 用 [img:ID] 引用） */
    data: string;
    dataType: 'url' | 'base64';
    imageId?: string;
}

export class MediaTask {
    static validKeys: (keyof MediaTask)[] = [
        'id', 'sid', 'isPrivate', 'epId', 'kind', 'origin', 'status',
        'createdAt', 'updatedAt', 'request', 'result', 'error', 'notified', 'requester', 'save', 'name', 'sourceMeta',
    ];
    id: string;
    sid: string;
    isPrivate: boolean;
    epId: string;
    kind: MediaTaskKind;
    origin: MediaTaskOrigin;
    status: MediaTaskStatus;
    createdAt: number;
    updatedAt: number;
    /** 提交时的参数摘要（查看队列与通知文案用） */
    request: {
        text?: string;
        prompt?: string;
        model?: string;
        params?: Record<string, unknown>;
        /** 标记"提交时提供了参考图"（参考图本体只在内存，不落盘） */
        image?: string;
    };
    result?: MediaTaskResult;
    error?: string;
    /** 是否已呈现（tool 来源=已通知 AI；command 来源=已直接投递） */
    notified: boolean;
    /** 发起者用户 ID（群聊通知里带上，供 AI 措辞） */
    requester: string;
    /** 文生图：是否保存到记忆 */
    save: boolean;
    /** 文生图：保存名称 */
    name: string;
    /** 工具调用来源元数据（JSON，用于图床 source / 类型标签；不是标签） */
    sourceMeta: string;

    constructor() {
        this.id = '';
        this.sid = '';
        this.isPrivate = false;
        this.epId = '';
        this.kind = 'tts';
        this.origin = 'tool';
        this.status = 'pending';
        this.createdAt = 0;
        this.updatedAt = 0;
        this.request = {};
        this.notified = false;
        this.requester = '';
        this.save = false;
        this.name = '';
        this.sourceMeta = '';
    }
}

export interface SubmitOptions {
    ctx: seal.MsgContext;
    kind: MediaTaskKind;
    origin: MediaTaskOrigin;
    entry: ModelEntry;
    /** 正文（tts=文本，tti=描述） */
    text: string;
    /** 已解析的参考图（tti；url 或 base64/data url） */
    image?: string;
    negativePrompt?: string;
    params?: Record<string, unknown>;
    save?: boolean;
    name?: string;
    /** 摘要里展示的模型名（默认取 entry.name） */
    modelLabel?: string;
}

/** 每会话保留的"已结束"任务上限（未结束任务永不淘汰） */
const FINISHED_KEEP_PER_SESSION = 50;

/**
 * 净化图片名（用于拼 imageId）。
 * imageId 会被写进 `[img:ID]` 标签：标签内容正则排除 `[` `]`（含则整段标签失配、退化成纯文本），
 * 冒号会干扰「[img:ID:描述]」的兜底拆分，空白与超长也没必要。故统一替换为 `_` 并截断。
 */
export function sanitizeImageName(raw: unknown): string {
    const s = String(raw ?? '').trim();
    if (!s) return 'ai-draw';
    const cleaned = s.replace(/[[\]［］:：\s]+/g, '_').replace(/^_+|_+$/g, '');
    return (cleaned || 'ai-draw').slice(0, 24);
}

export class MediaTaskManager {
    static tasks: MediaTask[] = [];
    private static loaded = false;
    /**
     * 仅内存持有的运行期载荷（参考图 base64 / 反向提示词）。
     * 参考图 base64 可能很大，绝不落盘 —— 进程重启后待执行任务会失去参考图（可读错误提示重新提交）。
     */
    private static runtime = new Map<string, { image?: string; negativePrompt?: string }>();

    private static runtimeKey(task: MediaTask): string {
        return `${task.sid}:${task.id}`;
    }

    // -------------------- 持久化 --------------------

    static init(): void {
        if (this.loaded) return;
        this.loaded = true;
        try {
            const raw = getHost().storage.get('mediaTaskQueue');
            const data = raw ? JSON.parse(raw) : [];
            if (Array.isArray(data)) {
                for (const item of data) {
                    if (!item || typeof item !== 'object') continue;
                    if (!Object.prototype.hasOwnProperty.call(item, 'id')) continue;
                    const task = Object.assign(new MediaTask(), item) as MediaTask;
                    // 进程重启后无法续跑已发出的 HTTP 请求：running 一律标记失败并补通知
                    if (task.status === 'running') {
                        task.status = 'failed';
                        task.error = 'interrupted by plugin reload';
                        task.notified = false;
                        task.updatedAt = Date.now();
                    }
                    this.tasks.push(task);
                }
            }
        } catch (e) {
            log.error(`读取媒体任务队列失败：${e instanceof Error ? e.message : String(e)}`);
        }
        this.save();
        // 补通知：已完成但未呈现的任务（tool 来源）重新入队并尝试唤醒
        for (const task of this.tasks) {
            if (task.status === 'done' && !task.notified && task.origin === 'tool') this.deliver(task);
        }
        void this.pump();
    }

    static reset(): void {
        this.tasks = [];
        this.runtime = new Map();
        this.loaded = false;
    }

    private static save(): void {
        try {
            getHost().storage.set('mediaTaskQueue', JSON.stringify(this.tasks));
        } catch (e) {
            log.error(`保存媒体任务队列失败：${e instanceof Error ? e.message : String(e)}`);
        }
    }

    // -------------------- 查询 --------------------

    static list(sid: string): MediaTask[] {
        return this.tasks.filter(t => t.sid === sid).sort((a, b) => Number(a.id) - Number(b.id));
    }

    static find(sid: string, id: string): MediaTask | null {
        const key = String(id || '').trim().replace(/^#/, '');
        return this.tasks.find(t => t.sid === sid && t.id === key) ?? null;
    }

    static pendingCount(sid: string): number {
        return this.tasks.filter(t => t.sid === sid && (t.status === 'pending' || t.status === 'running')).length;
    }

    /** 下一个会话内序号（按现有最大 id +1，保证展示稳定） */
    private static nextId(sid: string): string {
        let max = 0;
        for (const t of this.tasks) {
            if (t.sid !== sid) continue;
            const n = parseInt(t.id, 10);
            if (Number.isFinite(n) && n > max) max = n;
        }
        return String(max + 1);
    }

    private static runningCount(): number {
        return this.tasks.filter(t => t.status === 'running').length;
    }

    private static maxConcurrent(): number {
        const configured = Number(Config.tool.MEDIA_MAX_CONCURRENT);
        return Number.isFinite(configured) && configured > 0 ? configured : 3;
    }

    private static trimFinished(sid: string): void {
        const mine = this.tasks.filter(t => t.sid === sid);
        const finished = mine.filter(t => t.status === 'done' || t.status === 'failed' || t.status === 'canceled');
        if (finished.length <= FINISHED_KEEP_PER_SESSION) return;
        const drop = finished
            .sort((a, b) => a.updatedAt - b.updatedAt)
            .slice(0, finished.length - FINISHED_KEEP_PER_SESSION);
        const dropSet = new Set(drop);
        this.tasks = this.tasks.filter(t => !dropSet.has(t));
    }

    // -------------------- 提交与执行 --------------------

    /** 建任务入队并立即返回（不等待生成完成） */
    static submit(opts: SubmitOptions): MediaTask {
        const { ctx, kind, origin, entry, text } = opts;
        const isPrivate = !!ctx.isPrivate;
        const sid = isPrivate ? (ctx.player?.userId ?? '') : (ctx.group?.groupId ?? '');
        const task = new MediaTask();
        task.id = this.nextId(sid);
        task.sid = sid;
        task.isPrivate = isPrivate;
        task.epId = ctx.endPoint.userId;
        task.kind = kind;
        task.origin = origin;
        task.status = 'pending';
        task.createdAt = Date.now();
        task.updatedAt = task.createdAt;
        task.requester = ctx.player?.userId ?? '';
        task.save = opts.save === true;
        task.name = opts.name ?? '';
        task.request = kind === 'tts'
            ? { text, model: opts.modelLabel ?? entry.name, params: opts.params }
            : { prompt: text, model: opts.modelLabel ?? entry.name, params: opts.params };
        if (kind === 'tti') {
            // 工具产出图片的来源元数据：组包时写入 Image.sourceMeta，入库时随 source 上报图床
            try {
                task.sourceMeta = JSON.stringify({
                    platform: getPlatform(sid),
                    group_id: isPrivate ? '' : sid,
                    user_id: task.requester || '',
                    session_id: sid,
                    at: task.createdAt,
                    tool: 'text_to_image',
                    via: 'tool',
                });
            } catch (_e) {
                task.sourceMeta = '';
            }
        }
        if (opts.image) task.request.image = '(reference image provided at submit time)';

        // 参考图 base64 只进内存，不落盘
        this.runtime.set(this.runtimeKey(task), { image: opts.image, negativePrompt: opts.negativePrompt });

        this.tasks.push(task);
        this.trimFinished(sid);
        this.save();
        void this.pump();
        return task;
    }

    /** 在并发上限内启动 pending 任务 */
    private static async pump(): Promise<void> {
        const max = this.maxConcurrent();
        while (this.runningCount() < max) {
            const next = this.tasks.find(t => t.status === 'pending');
            if (!next) break;
            next.status = 'running';
            next.updatedAt = Date.now();
            this.save();
            void this.run(next);
        }
    }

    /** 解析任务对应的模型实例（沿用提交时的模型名；模型已下线则报错） */
    private static resolveEntry(task: MediaTask): ModelEntry | null {
        const use = task.kind === 'tts' ? 'tts' : 'image-generation';
        const name = task.request.model ?? '';
        if (name) {
            const found = Model.findModelByRef(name, use);
            if (found) return found;
        }
        return use === 'tts' ? Model.getTTSModel() : Model.getImageModel();
    }

    /** 任务是否已被取消（取消后一律不再落结果、不再投递） */
    private static isCanceled(task: MediaTask): boolean {
        return task.status === 'canceled';
    }

    private static async run(task: MediaTask): Promise<void> {
        const key = this.runtimeKey(task);
        const payload = this.runtime.get(key) ?? {};
        try {
            const entry = this.resolveEntry(task);
            if (!entry) {
                this.fail(task, task.kind === 'tts' ? 'no speech model configured (add one under "API connections" and declare it as tts)' : 'no image model configured (add one under "API connections" and declare it as gen)');
                return;
            }
            if (task.kind === 'tti' && !payload.image && task.request.image) {
                // 参考图随进程重启丢失（不落盘）：给出可读错误而不是静默忽略
                this.fail(task, 'reference image expired after plugin reload; please submit again');
                return;
            }
            // 命令来源的参数是 kwargs 字符串（--rate=1.5），需要按"看起来是数字/布尔"归一；
            // 工具来源本就是 JSON 类型，不做额外转换。
            const normOpts = task.origin === 'command' ? { coerceStringTypes: true } : undefined;
            const result: MediaResult = task.kind === 'tts'
                ? await entry.callTTS(task.request.text ?? '', task.request.params ?? {}, normOpts)
                : await entry.callTTI(task.request.prompt ?? '', {
                    negativePrompt: payload.negativePrompt ?? '',
                    image: payload.image ?? '',
                    params: task.request.params ?? {},
                    normOpts,
                });
            if (!result.ok) {
                this.fail(task, result.error || 'generation failed');
                return;
            }
            await this.land(task, result);
        } catch (e) {
            this.fail(task, e instanceof Error ? e.message : String(e));
        } finally {
            this.runtime.delete(key);
        }
    }

    private static fail(task: MediaTask, error: string): void {
        // 已取消的任务：不要用失败状态覆盖"已取消"，更不要投递结果。
        // （取消可发生在生成进行中的任意时刻，run()/land() 均可能在之后才返回。）
        if (MediaTaskManager.isCanceled(task)) {
            log.info(`媒体任务 #${task.id} 已被取消，忽略失败结果：${error}`);
            void this.pump();
            return;
        }
        task.status = 'failed';
        task.error = error;
        task.updatedAt = Date.now();
        this.save();
        log.warning(`媒体任务 #${task.id}（${task.kind}）失败：${error}`);
        this.deliver(task);
        void this.pump();
    }

    /**
     * 结果落地：把 base64 转成本地文件 / Image 句柄，任务里只留句柄。
     * 音频：seal.base64ToImage(base64) → 本地文件路径；URL 原样保留。
     * 图片：Image（base64 或 url），生成 imageId；按 save 意图写入记忆。
     */
    private static async land(task: MediaTask, result: MediaResult): Promise<void> {
        // 生成期间被取消：丢弃结果（不落地、不写记忆、不投递）。
        // 这里必须在落地副作用之前拦下，否则"已取消"会被下面的 status='done' 覆盖并照常发送。
        if (MediaTaskManager.isCanceled(task)) {
            log.info(`媒体任务 #${task.id} 已被取消，丢弃生成结果（${task.kind}）`);
            void this.pump();
            return;
        }
        try {
            if (task.kind === 'tts') {
                const file = result.dataType === 'url' ? result.data : seal.base64ToImage(result.data);
                task.result = {
                    kind: 'record',
                    send: `[CQ:record,file=${file}]`,
                    data: file,
                    dataType: result.dataType,
                };
            } else {
                const img = new Image();
                // 名称参与 imageId，而 imageId 会出现在 [img:ID] 标签里：
                // 标签内容不允许 [ ]（会截断标签），冒号会干扰「id:描述」的兜底拆分，故统一净化。
                const baseName = sanitizeImageName(task.name);
                img.imageId = `${baseName}_${generateId()}`;
                img.sourceSessionId = task.sid;
                if (task.sourceMeta) img.sourceMeta = task.sourceMeta;
                if (result.dataType === 'url') {
                    img.url = result.data;
                    try {
                        // urlToBase64() 内部会 Image.save(this)；失败时下面还会补一次 save
                        await img.urlToBase64();
                    } catch (e) {
                        log.warning(`媒体任务 #${task.id} 图片 URL 转 base64 失败：${e instanceof Error ? e.message : String(e)}`);
                    }
                    // 图床已接：字节在图床，内存里的 base64 不必留
                    img.dropBase64IfHosted();
                } else {
                    img.base64 = /^data:/i.test(result.data) && result.data.indexOf(',') >= 0
                        ? result.data.slice(result.data.indexOf(',') + 1)
                        : result.data;
                    // 生图返回的 base64 先转存图床；成功则清空 base64，失败保留本地 base64 兜底
                    if (ImageHost.enabled) {
                        const adopted = await img.adoptBase64ToHost();
                        if (!adopted) log.warning(`媒体任务 #${task.id} 生图结果转存图床失败，保留本地 base64`);
                    }
                }
                img.format = img.format || 'unknown';
                img.description = `AI image [img:${img.imageId}]\nDescription: ${task.request.prompt ?? ''}`;
                // 关键：注册/持久化，否则 Image.get(imageId) 取不到，AI 回复里的 [img:ID] 无法解析。
                // 原 tool_image.ts 只在 base64 结果 + save=true 时才间接可查，这里统一补齐。
                Image.imageMap[img.imageId] = img;
                Image.save(img);
                if (task.save) this.saveToMemory(task, img);

                // 命令侧直接投递需要真实文件/URL（CQ 不认识 imageId）。
                // 拿不到 CQ 时**不要**退化成 [img:imageId]：命令回复是纯文本外发，协议端只会把它当字面量显示。
                // getSendFile：图床配成 IP/域名时用稳定地址；回环地址取本地文件（绝不把回环地址发给协议端）。
                let send = '';
                try {
                    const file = await img.getSendFile();
                    if (file) send = `[CQ:image,file=${file}]`;
                } catch (e) {
                    log.warning(`媒体任务 #${task.id} 生成发送用 CQ 失败：${e instanceof Error ? e.message : String(e)}`);
                }
                if (send) {
                    // 把"现场生成的发送形态"落进日志：据此可判断 CQ 指向的是本地文件还是 URL（URL 需要协议端能访问，
                    // 否则海豹会显示"找不到图片/文件"），以及 base64 是否真的落地成了文件。
                    log.info(`媒体任务 #${task.id} 图片已落地：类型=${img.type} 发送形态=${send}`);
                } else {
                    log.error(`媒体任务 #${task.id} 无法生成可发送的图片 CQ（imageId=${img.imageId}，类型=${img.type}，url=${img.url || '(空)'}，base64 长度=${(img.base64 || '').length}）——协议端将无法显示该图`);
                }
                task.result = {
                    kind: 'image',
                    send,
                    data: img.imageId,
                    dataType: result.dataType,
                    imageId: img.imageId,
                };
            }
            // 落地过程含 await（URL 转 base64 等），期间可能被取消：提交"完成"前再确认一次。
            // 此时副作用（Image 注册/写记忆）已发生，但**结果不会被投递**，符合取消语义。
            if (MediaTaskManager.isCanceled(task)) {
                log.info(`媒体任务 #${task.id} 在落地过程中被取消，丢弃结果不投递`);
                void this.pump();
                return;
            }
            task.status = 'done';
            task.updatedAt = Date.now();
            this.save();
            log.info(`媒体任务 #${task.id}（${task.kind}）完成`);
            this.deliver(task);
        } catch (e) {
            this.fail(task, `failed to finalize result: ${e instanceof Error ? e.message : String(e)}`);
            return;
        }
        void this.pump();
    }

    /** 文生图存记忆：需要 ctx/session，异步完成后用 epId/sid 重建 */
    private static saveToMemory(task: MediaTask, img: Image): void {
        try {
            const { ctx } = getSessionCtxAndMsg(task.epId, task.sid, task.isPrivate);
            const session = getSession(task.sid);
            const kws = ['tti', task.name || task.request.model || ''];
            session.memory.addMemory(ctx, session, [], [], kws, [img], img.description);
        } catch (e) {
            log.warning(`媒体任务 #${task.id} 写入记忆失败：${e instanceof Error ? e.message : String(e)}`);
        }
    }

    // -------------------- 结算与投递 --------------------

    /** 可读的结果文案（命令直接投递用；拿不到可发送格式时如实回报，不伪造标签） */
    static resultText(task: MediaTask): string {
        if (task.status === 'failed') return `Generation failed: ${task.error || 'unknown error'}`;
        if (task.status === 'canceled') return 'Task canceled';
        if (!task.result) return 'No result';
        if (task.result.send) return task.result.send;
        const id = task.result.imageId ?? task.result.data;
        return `(generated but could not be converted to a sendable format, ID: ${id}; check the address and token of backends.image-host / backends.image-url-to-base64 under "Backend settings", or use media_tasks to inspect)`;
    }

    private static deliver(task: MediaTask): void {
        if (task.notified) {
            // 不静默：曾经这里直接 return，配合 defer 分支的 debug 日志，表现为"完成之后什么都没有"
            log.debug(`媒体任务 #${task.id} 已投递过（notified=true），跳过重复投递`);
            return;
        }
        if (task.origin === 'command') {
            this.deliverToChat(task);
            return;
        }
        this.noticeAndWake(task);
    }

    /** 命令来源：插件直接投递，不经 AI */
    private static deliverToChat(task: MediaTask): void {
        try {
            const { ctx, msg } = getSessionCtxAndMsg(task.epId, task.sid, task.isPrivate);
            const head = task.status === 'done'
                ? `Media task #${task.id} finished: `
                : `Media task #${task.id} failed: `;
            const body = task.status === 'done' ? this.resultText(task) : (task.error || 'unknown error');
            seal.replyToSender(ctx, msg, `${head}${body}`);
            task.notified = true;
            task.updatedAt = Date.now();
            this.save();
        } catch (e) {
            log.warning(`媒体任务 #${task.id} 直接投递失败：${e instanceof Error ? e.message : String(e)}`);
        }
    }

    /**
     * 工具来源：写入完成通知，然后**尽力起一轮对话**把结果发出去。
     *
     * 为什么不是"无条件直接 chat()"（原实现）：`Agent.run()`/`runStream()` 开头有一道同会话闸门
     * `if (session.running || session.starting) return;` —— 那里是**静默 return**（不抛错、不排队），
     * 于是 chat() 的 Promise 正常 resolve、`.catch` 不触发、日志还写着"触发成功"，
     * 通知却再没人管：本轮若已过最后一次模型请求，flushNotices 不会再看它，
     * 表现为"生成完了什么都没发生"，且因为 notified 已被置位而**永久等待**。
     *
     * 因此这里改成三段式，每段都有明确兜底：
     *   1) 入队（通知不可丢）：单独一步且在所有可能抛错的调用之前，带 taskId 供"是否已被消费"判定；
     *   2) 判定：接 decideWake（与子代理共用同一份"何时可唤醒"的语义），忙/待机 → defer；
     *   3) 唤醒：失败只影响"是否立刻起一轮"，通知仍在队列，由轮末补触发
     *      （Agent.run/runStream 的 finally → wakePendingNotices）兜住，不会永久等待。
     *
     * 待机仍然唤醒：standby 约束的是"机器人主动搭话"，而这是**用户请求的送达**。
     * 免桶（skipBucket）保留：chat() 会因桶空直接 return，那样就等于没触发。
     */
    private static noticeAndWake(task: MediaTask): void {
        // ---- 1) 入队：通知不可丢；带 taskId 以便判断"是否已被本会话消费" ----
        let session: ReturnType<typeof getSession>;
        try {
            session = getSession(task.sid);
            // kind='media'：让 flushNotices 用 [system:media-task] 而不是子代理口径渲染
            session.noticeQueue.push({
                text: this.buildNotice(task),
                from: '',
                time: Date.now(),
                kind: 'media',
                taskId: task.id,
            });
            // 注意：这里**不**置 notified —— 入队只是"准备好要呈现"，不等于"已呈现给 AI"。
            // notified 由 flushNotices 真正消费时回置（markNotifiedByNotice），
            // 否则重载补发（init 里只补 !notified 的任务）这条路会被谎报堵死。
            task.updatedAt = Date.now();
            this.save();
        } catch (e) {
            log.error(`媒体任务 #${task.id} 完成通知入队失败（结果仍在任务队列，可用 media_tasks 查看）：${e instanceof Error ? e.message : String(e)}`);
            return;
        }

        // ---- 2)+3) 判定并唤醒 ----
        this.tryWake(task, session);
    }

    /**
     * 判定并唤醒会话起一轮投递。
     *
     * 唤醒条件**不走 decideWake 的待机分支**：待机是"不主动搭话"，而媒体结果属于用户请求的送达，
     * 必须发出去（与 tool/subagent 的唤醒口径不同，见 docs/03 的硬约束）。
     * 忙（running/starting）则 defer —— 通知留在队列，由轮末补触发接手。
     */
    private static tryWake(task: MediaTask, session: ReturnType<typeof getSession>): void {
        const busy = session.running || session.starting;
        if (busy) {
            // 关键：会话忙**不代表**通知一定会被呈现。本轮若已过最后一次模型请求就直接结束，
            // 通知会一直躺在队列里。故不在这里等待，而是交给轮末补触发（wakePendingNotices）——
            // 它由"会话真的结束了"这一确定事件驱动，不需要猜时机、也不会永久等待。
            log.info(`媒体任务 #${task.id} 完成通知已入队，会话忙（running=${session.running} starting=${session.starting}），留待本轮结束补触发`);
            return;
        }

        let ctx: seal.MsgContext;
        let msg: seal.Message;
        try {
            ({ ctx, msg } = getSessionCtxAndMsg(task.epId, task.sid, task.isPrivate));
        } catch (e) {
            // 端点离线等：通知已入队不丢，用户下次发言或下次轮末补触发时会呈现
            log.warning(`媒体任务 #${task.id} 唤醒跳过：无法构造会话上下文（端点 ${task.epId} 可能离线）——通知已入队：${e instanceof Error ? e.message : String(e)}`);
            return;
        }
        // 媒体结果是"用户请求的送达"，不吃群内触发额度：免桶唤醒（桶空也照常送达）
        if (session.bucket && session.bucket.count <= 0) {
            log.info(`媒体任务 #${task.id}：会话触发令牌桶为空，仍按送达语义唤醒（免桶）`);
        }
        log.info(`媒体任务 #${task.id} 完成通知已入队，唤醒会话 ${task.sid} 起一轮对话`);
        void session.chat(ctx, msg, '生成任务完成', undefined, { skipBucket: true }).catch((e) => {
            log.warning(`媒体任务 #${task.id} 触发对话失败（通知已入队，本轮结束会补触发）：${e instanceof Error ? e.message : String(e)}`);
        });
    }

    /**
     * 轮末补触发：会话真正空闲（activeRuns 归零）后，把**还没被消费**的媒体完成通知补起一轮。
     *
     * 这是唤醒链路的**唯一确定性兜底**，由 `Agent.run()`/`runStream()` 的 finally 在
     * `resumePending()` 之后调用（此时 running 已转 false，判定"空闲"是准的）。
     *
     * 为什么放在这里而不是用计时器重试（原 5d22f19 的做法）：
     *   - 计时器要猜"会话还要忙多久"，猜短了白跑、猜长了延迟送达，且次数用尽仍可能落空；
     *   - 这里只在"这一轮确实结束了"时检查，条件成立才触发，不成立就什么都不做。
     *
     * **不会无限循环**：补触发起的这一轮，其 finally 会再检查一次，但那时通知已被
     * flushNotices 消费（消费发生在下一轮模型请求前）→ 判定不成立 → 自动停止。
     * 若该轮因故没走到 flushNotices，则条件仍成立、再补一次，这正是"不永久等待"的保证。
     */
    static wakePendingNotices(session: Session): void {
        try {
            // 还有别的轮在跑（activeRuns>0）：等它结束时再检查，避免并发起轮
            if (session.activeRuns > 0 || session.running || session.starting) return;
            // 被 .ai stop 停掉：不补（尊重停止语义）
            if (session.stopEvent && session.stopEvent.fired) return;
            const pending = session.noticeQueue.filter(n => n.kind === 'media' && n.taskId);
            if (pending.length === 0) return;

            const first = pending[0];
            const ctx2 = this.getSessionCtxAndMsgSafe(session, first.taskId!);
            if (!ctx2) return;
            log.info(`媒体任务 #${first.taskId} 通知仍未被消费，会话已空闲，补触发一轮对话（共 ${pending.length} 条待呈现）`);
            void session.chat(ctx2.ctx, ctx2.msg, '生成任务完成', undefined, { skipBucket: true }).catch((e) => {
                log.warning(`媒体任务 #${first.taskId} 补触发失败（通知仍在队列，下次轮末会再试）：${e instanceof Error ? e.message : String(e)}`);
            });
        } catch (e) {
            log.warning(`媒体完成通知补触发出错（通知仍在队列）：${e instanceof Error ? e.message : String(e)}`);
        }
    }

    /** 按 taskId 重建会话上下文（补触发用；端点离线返回 null 而非抛错） */
    private static getSessionCtxAndMsgSafe(session: Session, taskId: string): { ctx: seal.MsgContext; msg: seal.Message } | null {
        const task = this.tasks.find(t => t.sid === session.sessionId && t.id === taskId);
        if (!task) return null;
        try {
            return getSessionCtxAndMsg(task.epId, task.sid, task.isPrivate);
        } catch (e) {
            log.warning(`媒体任务 #${taskId} 补触发跳过：无法构造会话上下文（端点 ${task.epId} 可能离线）：${e instanceof Error ? e.message : String(e)}`);
            return null;
        }
    }

    /**
     * 通知被真正呈现（flushNotices 消费）后回置 notified。
     *
     * 语义：`notified=true` = 结果已进入上下文/已投递，**不再需要**任何补发。
     * 因此这里才是唯一该置位的时机；入队时置位会谎报成功，
     * 让"重载补发未呈现任务"（init）与"轮末补触发"两条兜底同时失效 —— 即原实现的永久等待。
     */
    static markNotifiedByNotice(sid: string, taskId: string): void {
        const task = this.find(sid, String(taskId));
        if (!task) return;
        if (task.notified) return;
        task.notified = true;
        task.updatedAt = Date.now();
        this.save();
        log.info(`媒体任务 #${task.id} 完成通知已被会话消费（notified=true）`);
    }

    /**
     * 提交后等待窗口：在给定毫秒内轮询任务是否已结束，结束则返回该任务（调用方据此**当场**返回结果）。
     *
     * 为什么要它：生成响应过快时（本地模型/缓存命中/极短文本），任务可能在工具 solve() 还没返回时
     * 就已完成，此时完成通知会撞上"发起轮还在跑"的闸门 —— 虽然现在有轮末补触发兜底，
     * 但当场返回结果更快、也更省一轮模型调用。窗口内没结束就正常走异步（返回 null）。
     */
    static async waitForSettle(task: MediaTask, timeoutMs: number, pollMs = 200): Promise<MediaTask | null> {
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return null;
        const deadline = Date.now() + timeoutMs;
        const settled = () => task.status === 'done' || task.status === 'failed' || task.status === 'canceled';
        while (Date.now() < deadline) {
            if (settled()) return task;
            const remain = deadline - Date.now();
            await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(pollMs, remain))));
        }
        return settled() ? task : null;
    }

    /** 给 AI 的可执行通知（含发送方式；只含句柄，不含 base64） */
    private static buildNotice(task: MediaTask): string {
        const lines: string[] = ['Media task notice'];
        lines.push(`Task: #${task.id} (${task.kind === 'tts' ? 'text-to-speech' : 'text-to-image'})`);
        if (task.requester) lines.push(`Requester: ${task.requester}`);
        if (task.kind === 'tts') lines.push(`Text: ${task.request.text ?? ''}`);
        else lines.push(`Prompt: ${task.request.prompt ?? ''}`);
        if (task.request.model) lines.push(`Model: ${task.request.model}`);
        if (task.status === 'done' && task.result) {
            if (task.result.kind === 'record') {
                lines.push(`Result: audio generated (${task.result.dataType === 'url' ? 'URL' : 'local file'}: ${task.result.data})`);
                // 注意：回复里的 [audio:xxx] 只认「资源」页配置的本地语音**资源名**，不认文件路径/URL，
                // 所以生成结果只能走 call_ob11_api 的 record 段（与旧 tts 依赖链路一致）。
                lines.push(`How to send: call call_ob11_api and put {"type":"record","data":{"file":"${task.result.data}"}} into the message segment (do not use [audio:…]; that tag only accepts configured local audio resource names)`);
            } else {
                lines.push(`Result: image generated (imageId: ${task.result.imageId})`);
                lines.push(`How to send: **prefer** writing [img:${task.result.imageId}] directly in your reply (the system sends it automatically); do not call call_ob11_api for this`);
            }
        } else {
            lines.push(`Result: failed — ${task.error || 'unknown error'}`);
            lines.push('You can tell the user the failure reason, or adjust the parameters and submit again.');
        }
        return lines.join('\n');
    }

    // -------------------- 取消 --------------------

    static cancel(sid: string, id: string): { ok: boolean; message: string } {
        const task = this.find(sid, id);
        if (!task) return { ok: false, message: `未找到任务 #${String(id).replace(/^#/, '')}` };
        if (task.status === 'pending' || task.status === 'running') {
            task.status = 'canceled';
            task.updatedAt = Date.now();
            task.notified = true; // 不再投递结果
            this.save();
            void this.pump();
            return { ok: true, message: `已取消任务 #${task.id}` };
        }
        return { ok: false, message: `任务 #${task.id} 已结束（${task.status}），无法取消` };
    }
}

// 把「已送达回置」注册到 L0 端口：会话侧 flushNotices 消费媒体通知后经 port 回调，
// 避免 session/inbox 反向 import 本模块（会话编排环）。
setMediaNotifiedHandler((sessionId, taskId) => MediaTaskManager.markNotifiedByNotice(sessionId, taskId));
