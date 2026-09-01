// 知识库工具：只读检索（search/read/list/docs），内容由配置维护，AI 不能增删
import { knowledgeService } from "../../../memory/knowledge";
import Tool from "../../tool";

// 单次检索返回条数上限，防止模型请求超大 topK 造成上下文/API 浪费
const KB_SEARCH_TOPK_MAX = 50;
const KB_PAGE_SIZE_LIMIT = 100;

export function registerKnowledgeTools() {
    const toolSearch = new Tool({
        type: 'function',
        function: {
            name: 'knowledge_search',
            description: '在知识库中按关键词搜索相关条目，返回匹配的标题与内容；知识库内容由管理员配置，只读',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: '搜索关键词或问题描述'
                    },
                    library_id: {
                        type: 'string',
                        description: '可选，限定搜索某个知识库'
                    },
                    topK: {
                        type: 'number',
                        description: '返回条数，默认 5，最大 50'
                    }
                },
                required: ['query']
            }
        }
    });
    toolSearch.solve = async (_ctx, _msg, _session, args) => {
        const query = typeof args.query === 'string' ? args.query : '';
        const libraryId = typeof args.library_id === 'string' ? args.library_id : '';
        const topK = Math.min(Math.max(typeof args.topK === 'number' && args.topK > 0 ? Math.floor(args.topK) : 5, 1), KB_SEARCH_TOPK_MAX);
        const chunks = await knowledgeService.search(query, topK, libraryId || undefined);
        if (chunks.length === 0) return query ? '未找到相关知识库条目' : '知识库为空';
        return chunks.map((c, i) => `${i + 1}. ${knowledgeService.formatChunk(c)}`).join('\n\n');
    };

    const toolRead = new Tool({
        type: 'function',
        function: {
            name: 'knowledge_read',
            description: '按 ID 读取知识库中某个条目的完整内容，ID 来自 knowledge_list / knowledge_docs / knowledge_search 的结果',
            parameters: {
                type: 'object',
                properties: {
                    id: {
                        type: 'string',
                        description: '知识库分块 ID（形如 kb_xxxxxxxx）'
                    }
                },
                required: ['id']
            }
        }
    });
    toolRead.solve = async (_ctx, _msg, _session, args) => {
        const id = typeof args.id === 'string' ? args.id : '';
        await knowledgeService.init();
        const chunk = knowledgeService.read(id);
        return chunk ? knowledgeService.formatChunk(chunk) : `未找到知识库条目:${id}`;
    };

    const toolList = new Tool({
        type: 'function',
        function: {
            name: 'knowledge_list',
            description: '分页列出知识库的库名与描述；查看某个库的文档结构使用 knowledge_docs',
            parameters: {
                type: 'object',
                properties: {
                    page: {
                        type: 'integer',
                        description: '页码，从 1 开始，默认 1'
                    },
                    page_size: {
                        type: 'integer',
                        description: '每页数量，默认 20，最大 100'
                    },
                    query: {
                        type: 'string',
                        description: '按库名或描述关键词过滤'
                    }
                },
                required: []
            }
        }
    });
    toolList.solve = async (_ctx, _msg, _session, args) => {
        await knowledgeService.init();
        const { page = 1, page_size = 20, query = '' } = args || {};
        const libs = knowledgeService.getLibraries();
        if (libs.length === 0) return '知识库为空';
        const q = String(query || '').trim().toLowerCase();
        const filtered = q
            ? libs.filter(l =>
                l.name.toLowerCase().includes(q) ||
                (l.description || '').toLowerCase().includes(q)
            )
            : libs;
        const size = Math.min(Math.max(parseInt(page_size, 10) || 20, 1), KB_PAGE_SIZE_LIMIT);
        const current = Math.max(parseInt(page, 10) || 1, 1);
        const totalPages = Math.max(1, Math.ceil(filtered.length / size));
        const start = (current - 1) * size;
        const items = filtered.slice(start, start + size);
        const lines = [`知识库列表（共 ${filtered.length} 个库）`];
        items.forEach((lib, i) => {
            lines.push(`${start + i + 1}. [${lib.id}] ${lib.name}：${lib.description || '无描述'}`);
        });
        lines.push(`当前第 ${current} 页，共 ${totalPages} 页；使用 knowledge_docs 查看某库结构，knowledge_search 搜索内容。`);
        return lines.join('\n');
    };

    const toolDocs = new Tool({
        type: 'function',
        function: {
            name: 'knowledge_docs',
            description: '查看某个知识库下的文档/章节结构，返回分块 ID；详细正文用 knowledge_read 读取',
            parameters: {
                type: 'object',
                properties: {
                    library_id: {
                        type: 'string',
                        description: '知识库 ID，来自 knowledge_list'
                    },
                    page: {
                        type: 'integer',
                        description: '页码，从 1 开始，默认 1'
                    },
                    page_size: {
                        type: 'integer',
                        description: '每页数量，默认 20，最大 100'
                    }
                },
                required: ['library_id']
            }
        }
    });
    toolDocs.solve = async (_ctx, _msg, _session, args) => {
        await knowledgeService.init();
        const libraryId = typeof args.library_id === 'string' ? args.library_id : '';
        const page = parseInt(args.page, 10) || 1;
        const pageSize = parseInt(args.page_size, 10) || 20;
        return knowledgeService.formatLibraryDocs(libraryId, page, pageSize);
    };
}