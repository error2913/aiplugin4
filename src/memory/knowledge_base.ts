// 知识库服务：配置驱动（Markdown 模板，每条一份完整文档）、只读检索、惰性向量增强
import Config from "../config/config";
import Logger from "../logger";
import Model from "../model/model";
import { buildCharNGrams } from "../utils/string";
import { cosineSimilarity } from "../utils/utils";

import { hashString, KnowledgeChunk, splitMarkdownIntoChunks } from "./knowledge_chunk";

// 向量重排候选上限：仅对关键词命中的前 N 块做惰性嵌入，控制单次检索的 API 开销
const VECTOR_RERANK_CANDIDATE_LIMIT = 20;
/** 知识库索引渲染上限：注入兜底/列表展示时控制单次输出条数，超出提示用 knowledge_search 检索 */
export const KB_INDEX_LIMIT = 100;
/** 主动查询（.ai kb list / knowledge_list 工具）的索引上限，避免超大知识库一次输出过长 */
export const KB_LIST_LIMIT = 200;
/** 检索式注入上限：按当前对话内容命中时最多注入的分块数 */
export const KB_INJECT_TOP_K = 5;
/** 知识库注入段字符预算：正文/索引合计不超过该值，避免挤占 system prompt */
export const KB_INJECT_MAX_CHARS = 1500;

export class KnowledgeBaseService {
    private chunks: KnowledgeChunk[] = [];
    /** 惰性向量缓存：检索时才按块嵌入，加载知识库本身不请求嵌入模型 */
    private chunkVectors: Map<string, number[]> = new Map();
    /** 上次加载的配置内容签名：签名不变则跳过重新切分，避免依赖数组引用稳定性 */
    private loadedSignature: string | null = null;
    /** 启动解析一次的知识库条目快照与签名缓存（修改知识库需重载 JS 生效） */
    private loadedItems: string[] | null = null;
    private itemsSignature: string | null = null;
    private loadPromise: Promise<void> | null = null;

    /** 配置内容签名：全部条目内容 hash 拼接，配置变化后签名必然变化 */
    private getItemsSignature(items: string[]): string {
        const list = Array.isArray(items) ? items : [];
        return list.map(item => hashString(item || '')).join(',');
    }

    /** 解析配置中的全部 Markdown 文档为分块（不含向量）；未变分块保留已有向量缓存 */
    private async reload(items: string[]): Promise<void> {
        const list = Array.isArray(items) ? items : [];
        const oldVectors = this.chunkVectors;
        this.chunkVectors = new Map();
        this.chunks = [];
        list.forEach((md, index) => {
            const raw = (md || '').replace(/\r\n/g, '\n').trim();
            if (!raw) return;
            // 条目标题：取文档首个 #，无标题时用条目序号兜底
            const firstTitle = raw.match(/^#\s+(.+)$/m)?.[1]?.trim() || `条目${index + 1}`;
            const docChunks = splitMarkdownIntoChunks(raw);
            docChunks.forEach(c => {
                if (!c.title) c.title = firstTitle;
                // 条目序号参与 ID：跨条目内容完全相同时 ID 仍全局唯一（顺序变化会让未变动条目失效，可接受）
                c.id = `kb_${index + 1}_${c.id.replace(/^kb_/, '')}`;
                this.chunks.push(c);
            });
            // 完全没有标题的纯文本：整体作为一条
            if (docChunks.length === 0) {
                this.chunks.push({
                    id: `kb_${index + 1}_${hashString(raw)}_whole`,
                    title: firstTitle,
                    heading: '',
                    content: raw
                });
            }
        });
        // 保留未变分块的向量缓存：ID 稳定（内容 hash）时旧向量仍然有效
        for (const c of this.chunks) {
            const v = oldVectors.get(c.id);
            if (v) this.chunkVectors.set(c.id, v);
        }
        this.loadedItems = list;
        this.loadedSignature = this.getItemsSignature(list);
        this.itemsSignature = this.loadedSignature;
        Logger.info(`知识库加载完成: ${this.chunks.length} 个分块`);
    }

    private ensureLoaded(): Promise<void> {
        // 知识库内容为启动解析一次、重载 JS 才生效的复杂配置：加载一次后常驻，后续调用直接返回
        if (this.loadedSignature !== null) return Promise.resolve();
        if (!this.loadPromise) {
            const items = Config.knowledgeBase.KNOWLEDGE_ITEMS;
            const list = Array.isArray(items) ? items : [];
            this.loadPromise = this.reload(list);
            this.loadPromise.then(() => {
                this.loadPromise = null;
            }, () => {
                this.loadPromise = null;
            });
        }
        return this.loadPromise;
    }

    /** 启动预热：配置注册后主动解析一次（不触发任何嵌入请求） */
    async init(): Promise<void> {
        await this.ensureLoaded();
    }

    get isEmpty(): boolean {
        return this.chunks.length === 0;
    }

    /** prompt 缓存版本：开关/阈值等简单项实时参与（热加载后自然产生新 key），条目签名启动解析一次并缓存 */
    getCacheVersion(): string {
        const items = this.loadedItems ?? (Array.isArray(Config.knowledgeBase.KNOWLEDGE_ITEMS) ? Config.knowledgeBase.KNOWLEDGE_ITEMS : []);
        return `${Config.knowledgeBase.KNOWLEDGE ? '1' : '0'}|${Config.knowledgeBase.KNOWLEDGE_INJECT_THRESHOLD}|${items.length}|${this.getItemsSignatureCached()}`;
    }

    private getItemsSignatureCached(): string {
        if (this.itemsSignature !== null) return this.itemsSignature;
        const items = this.loadedItems ?? (Array.isArray(Config.knowledgeBase.KNOWLEDGE_ITEMS) ? Config.knowledgeBase.KNOWLEDGE_ITEMS : []);
        this.itemsSignature = this.getItemsSignature(items);
        return this.itemsSignature;
    }

    /** 全部条目索引（id/标题/小节） */
    list(): KnowledgeChunk[] {
        return this.chunks;
    }

    /** 按稳定 ID 读取单个分块 */
    read(id: string): KnowledgeChunk | null {
        return this.chunks.find(c => c.id === id) || null;
    }

    private tokenize(query: string): string[] {
        return Array.from(new Set(
            (query || '').split(/[\s,，。.、;；:：!！?？()（）[\]【】]+/).filter(t => t.length > 0)
        ));
    }

    private keywordScore(chunk: KnowledgeChunk, tokens: string[], query?: string): number {
        const text = `${chunk.title}\n${chunk.heading}\n${chunk.content}`;
        let score = 0;
        if (tokens.length > 0) {
            score += tokens.filter(t => text.includes(t)).length / tokens.length;
        }
        // 中文 n-gram 重合率：弥补按空白/标点切分对中文整句的失效
        const grams = query ? buildCharNGrams(query) : new Set<string>();
        if (grams.size > 0) {
            const contentGrams = buildCharNGrams(text);
            if (contentGrams.size > 0) {
                let hit = 0;
                for (const g of grams) if (contentGrams.has(g)) hit++;
                score += hit / grams.size * 0.5;
            }
        }
        return score;
    }

    /** 惰性嵌入单个分块；失败返回空数组（调用方降级为纯关键词） */
    private async getChunkVector(chunk: KnowledgeChunk): Promise<number[]> {
        const cached = this.chunkVectors.get(chunk.id);
        if (cached) return cached;
        const dimension = Model.getEmbeddingDimension();
        const model = dimension > 0 ? Model.getEmbeddingModel('text-embedding') : null;
        if (!model) return [];
        const vector = await model.callEmbedding(`${chunk.title}\n${chunk.heading}\n${chunk.content}`);
        if (vector.length === 0 || vector.length !== dimension) return [];
        this.chunkVectors.set(chunk.id, vector);
        return vector;
    }

    /** 嵌入查询词；未启用/未配置/失败时返回空数组 */
    private async embedQuery(query: string): Promise<number[]> {
        const dimension = Model.getEmbeddingDimension();
        const model = dimension > 0 ? Model.getEmbeddingModel('text-embedding') : null;
        if (!model) return [];
        const v = await model.callEmbedding(query);
        return v.length === dimension ? v : [];
    }

    /**
     * 关键词检索 + 可选向量重排。
     * 先按标题/小节/内容关键词过滤排序，嵌入可用时仅对命中候选做惰性向量相似度重排；
     * 嵌入失败/未配置时直接返回关键词结果，不影响可用性。
     */
    async search(query: string, topK = 5): Promise<KnowledgeChunk[]> {
        await this.ensureLoaded();
        if (this.chunks.length === 0) return [];
        if (topK < 1) topK = 1;
        const tokens = this.tokenize(query);
        if (tokens.length === 0) {
            // 空查询：返回前 topK 条（按注入顺序）
            return this.chunks.slice(0, topK);
        }
        const hits = this.chunks
            .map(chunk => ({ chunk, score: this.keywordScore(chunk, tokens, query) }))
            .filter(x => x.score > 0)
            .sort((a, b) => b.score - a.score || b.chunk.content.length - a.chunk.content.length);
        if (hits.length === 0) return [];

        // 向量重排：仅对关键词候选做惰性嵌入，数量受限避免拖慢响应
        const candidates = hits.slice(0, VECTOR_RERANK_CANDIDATE_LIMIT);
        const queryVector = await this.embedQuery(query);
        const withSim = queryVector.length > 0
            ? await Promise.all(candidates.map(async x => {
                const cv = await this.getChunkVector(x.chunk);
                return { chunk: x.chunk, sim: cv.length > 0 ? cosineSimilarity(queryVector, cv) : -1 };
            }))
            : [];
        if (withSim.some(x => x.sim >= 0)) {
            withSim.sort((a, b) => b.sim - a.sim);
            return withSim.slice(0, topK).map(x => x.chunk);
        }
        return hits.slice(0, topK).map(x => x.chunk);
    }

    /** 单块渲染：条目 + 小节 + 内容 */
    formatChunk(chunk: KnowledgeChunk): string {
        const heading = chunk.heading ? `（${chunk.heading}）` : '';
        return `[${chunk.id}] ${chunk.title}${heading}\n${chunk.content}`;
    }

    /** 索引渲染：只给 id 与标题，供列表/超阈值注入使用；limit>0 时只取前 limit 条并提示总数 */
    formatIndex(chunks: KnowledgeChunk[] = this.chunks, limit = 0): string {
        if (chunks.length === 0) return '';
        const list = limit > 0 ? chunks.slice(0, limit) : chunks;
        const lines = list.map((c, i) => {
            const heading = c.heading ? ` - ${c.heading}` : '';
            return `${i + 1}. [${c.id}] ${c.title}${heading}`;
        }).join('\n');
        if (limit > 0 && chunks.length > limit) {
            return `${lines}\n…共 ${chunks.length} 条，检索请用 knowledge_search / knowledge_read`;
        }
        return lines;
    }

    /**
     * 构造 system prompt 的知识库段（检索式注入，不再全量注入正文）：
     * - 传入 query 时按当前对话内容检索，命中的 topK 分块正文在字符预算内才注入；
     * - 命中正文超预算 / 未命中 / 无 query 时，把预算优先花在条目索引上（尽可能多列），
     *   模型需要详情时通过 knowledge_read 按 ID 读取。
     */
    async buildKnowledgePrompt(query = ''): Promise<string> {
        if (this.chunks.length === 0) return '';
        const trimmed = String(query || '').trim();
        if (trimmed) {
            const hits = await this.search(trimmed, KB_INJECT_TOP_K);
            if (hits.length > 0) {
                const body = hits.map((c, i) => `${i + 1}. ${this.formatChunk(c)}`).join('\n\n');
                if (body.length <= KB_INJECT_MAX_CHARS) {
                    return `## 知识库\n${body}`;
                }
                // 命中正文超预算：降级为索引，避免正文挤占上下文
            }
        }
        return this.buildIndexFallback();
    }

    /** 注入索引兜底：预算内尽可能多列条目（标题 + 小节），正文按需用 knowledge_read 读取 */
    private buildIndexFallback(): string {
        const head = `## 知识库\n知识库内容较多（共 ${this.chunks.length} 个分块），以下为条目索引，需要详情时使用 knowledge_read 工具按 ID 读取：\n`;
        const lines: string[] = [];
        let total = 0;
        for (let i = 0; i < this.chunks.length && lines.length < KB_INDEX_LIMIT; i++) {
            const c = this.chunks[i];
            const heading = c.heading ? ` - ${c.heading}` : '';
            const line = `${lines.length + 1}. [${c.id}] ${c.title}${heading}`;
            if (total + line.length + 1 > KB_INJECT_MAX_CHARS) break;
            lines.push(line);
            total += line.length + 1;
        }
        const index = lines.join('\n');
        const remaining = this.chunks.length > lines.length
            ? `\n…共 ${this.chunks.length} 条，检索请用 knowledge_search / knowledge_read`
            : '';
        return head + index + remaining;
    }
}

export const knowledgeBase = new KnowledgeBaseService();
