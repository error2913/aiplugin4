// 知识库服务：配置驱动（Markdown 模板，每条一份完整文档）、只读检索、惰性向量增强
import Config from "../config/config";
import Logger from "../logger";
import Model from "../model/model";
import { cosineSimilarity } from "../utils/utils";

import { hashString, KnowledgeChunk, splitMarkdownIntoChunks } from "./knowledge_chunk";

// 向量重排候选上限：仅对关键词命中的前 N 块做惰性嵌入，控制单次检索的 API 开销
const VECTOR_RERANK_CANDIDATE_LIMIT = 20;

export class KnowledgeBaseService {
    private chunks: KnowledgeChunk[] = [];
    /** 惰性向量缓存：检索时才按块嵌入，加载知识库本身不请求嵌入模型 */
    private chunkVectors: Map<string, number[]> = new Map();
    /** 上次加载的配置引用：配置缓存 TTL 内引用不变，过期后重新解析 */
    private loadedItems: string[] | null = null;
    private loadPromise: Promise<void> | null = null;

    /** 解析配置中的全部 Markdown 文档为分块（不含向量） */
    private async reload(items: string[]): Promise<void> {
        const list = Array.isArray(items) ? items : [];
        this.chunks = [];
        this.chunkVectors.clear();
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
        this.loadedItems = items;
        Logger.info(`知识库加载完成: ${this.chunks.length} 个分块`);
    }

    private ensureLoaded(): Promise<void> {
        const items = Config.memory.KNOWLEDGE_ITEMS;
        if (this.loadedItems === items && this.loadedItems !== null) return Promise.resolve();
        if (!this.loadPromise) {
            this.loadPromise = this.reload(items);
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

    private keywordScore(chunk: KnowledgeChunk, tokens: string[]): number {
        if (tokens.length === 0) return 0;
        const text = `${chunk.title}\n${chunk.heading}\n${chunk.content}`;
        return tokens.filter(t => text.includes(t)).length / tokens.length;
    }

    /** 惰性嵌入单个分块；失败返回空数组（调用方降级为纯关键词） */
    private async getChunkVector(chunk: KnowledgeChunk): Promise<number[]> {
        const cached = this.chunkVectors.get(chunk.id);
        if (cached) return cached;
        if (!Config.model.EMBEDDING_MODEL_ENABLED) return [];
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
        if (!Config.model.EMBEDDING_MODEL_ENABLED || !query) return [];
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
            .map(chunk => ({ chunk, score: this.keywordScore(chunk, tokens) }))
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

    /** 索引渲染：只给 id 与标题，供列表/超阈值注入使用 */
    formatIndex(chunks: KnowledgeChunk[] = this.chunks): string {
        if (chunks.length === 0) return '';
        return chunks.map((c, i) => {
            const heading = c.heading ? ` - ${c.heading}` : '';
            return `${i + 1}. [${c.id}] ${c.title}${heading}`;
        }).join('\n');
    }

    /**
     * 构造 system prompt 的知识库段。
     * 总内容不超过「知识库注入阈值(字符)」时全量注入；超过则只注入标题索引，
     * 模型需要详情时通过 kb_read 工具按 ID 读取。
     */
    buildKnowledgePrompt(): string {
        if (this.chunks.length === 0) return '';
        const { KNOWLEDGE_INJECT_THRESHOLD } = Config.memory;
        const total = this.chunks.reduce((sum, c) => sum + c.content.length, 0);
        if (total <= KNOWLEDGE_INJECT_THRESHOLD) {
            const body = this.chunks.map((c, i) => `${i + 1}. ${this.formatChunk(c)}`).join('\n\n');
            return `## 知识库\n${body}`;
        }
        return `## 知识库\n知识库内容较多（共 ${this.chunks.length} 个分块），以下为条目索引，需要详情时使用 kb_read 工具按 ID 读取：\n${this.formatIndex()}`;
    }
}

export const knowledgeBase = new KnowledgeBaseService();
