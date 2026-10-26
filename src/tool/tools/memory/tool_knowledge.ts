// 知识库工具：只读检索（search/read/list/docs），内容由配置维护，AI 不能增删；
// 按库过滤：frontmatter platform（平台白名单）+ 会话级 kbState 开关。
import { knowledgeService } from "../../../memory/knowledge";
import { matchesPlatform, platformOf } from "../../../utils/target_id";
import Tool, { KNOWLEDGE_GROUP } from "../../tool";

// 单次检索返回条数上限，防止模型请求超大 topK 造成上下文/API 浪费
const KB_SEARCH_TOPK_MAX = 50;
const KB_PAGE_SIZE_LIMIT = 100;

/** 当前平台 + 会话开关过滤后的库 ID 白名单 */
function allowedLibraryIds(ctx: any, session: any): Set<string> {
    const platform = platformOf(ctx);
    const ids = new Set<string>();
    for (const lib of knowledgeService.getLibraries()) {
        if (matchesPlatform(lib.platforms, platform) && (!session?.kbState || session.kbState[lib.id] !== false)) {
            ids.add(lib.id);
        }
    }
    return ids;
}

export function registerKnowledgeTools() {
    const toolSearch = new Tool({
        type: 'function',
        function: {
            name: 'knowledge_search',
            description: 'Search knowledge bases for relevant entries by keyword (only bases available on the current platform and enabled in this session); returns matching titles and content. Knowledge base content is read-only and configured by the administrator',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Search keyword or question description'
                    },
                    library_id: {
                        type: 'string',
                        description: 'Optional; restrict the search to one knowledge base'
                    },
                    topK: {
                        type: 'number',
                        description: 'Number of results to return; default 5, max 50'
                    }
                },
                required: ['query']
            }
        }
    }, false, KNOWLEDGE_GROUP);
    toolSearch.solve = async (ctx, _msg, session, args) => {
        const query = typeof args.query === 'string' ? args.query : '';
        const libraryId = typeof args.library_id === 'string' ? args.library_id : '';
        const topK = Math.min(Math.max(typeof args.topK === 'number' && args.topK > 0 ? Math.floor(args.topK) : 5, 1), KB_SEARCH_TOPK_MAX);
        const allowed = allowedLibraryIds(ctx, session);
        if (allowed.size === 0) return query ? '未找到可用知识库条目（无当前平台可用的库或库均已关闭）' : '知识库为空';
        if (libraryId && !allowed.has(libraryId)) return `知识库 ${libraryId} 不可用（平台限制或已在本会话关闭）`;
        const chunks = await knowledgeService.search(query, topK, libraryId || undefined, allowed);
        if (chunks.length === 0) return query ? '未找到相关知识库条目' : '知识库为空';
        return chunks.map((c, i) => `${i + 1}. ${knowledgeService.formatChunk(c)}`).join('\n\n');
    };

    const toolRead = new Tool({
        type: 'function',
        function: {
            name: 'knowledge_read',
            description: 'Read the full content of a knowledge base entry by ID (only bases available on the current platform and enabled in this session). IDs come from knowledge_list / knowledge_docs / knowledge_search results',
            parameters: {
                type: 'object',
                properties: {
                    id: {
                        type: 'string',
                        description: 'Knowledge base chunk ID (of the form kb_xxxxxxxx)'
                    }
                },
                required: ['id']
            }
        }
    }, false, KNOWLEDGE_GROUP);
    toolRead.solve = async (ctx, _msg, session, args) => {
        const id = typeof args.id === 'string' ? args.id : '';
        await knowledgeService.init();
        const allowed = allowedLibraryIds(ctx, session);
        const chunk = knowledgeService.read(id);
        if (!chunk) return `未找到知识库条目:${id}`;
        if (!allowed.has(chunk.libraryId || '')) return `条目所属知识库不可用（平台限制或已在本会话关闭）`;
        return knowledgeService.formatChunk(chunk);
    };

    const toolList = new Tool({
        type: 'function',
        function: {
            name: 'knowledge_list',
            description: 'List the names and descriptions of knowledge bases available on the current platform and enabled in this session, page by page; use knowledge_docs to view one base document structure',
            parameters: {
                type: 'object',
                properties: {
                    page: {
                        type: 'integer',
                        description: 'Page number, starting at 1; default 1'
                    },
                    page_size: {
                        type: 'integer',
                        description: 'Page size; default 20, max 100'
                    },
                    query: {
                        type: 'string',
                        description: 'Filter by base name or description keyword'
                    }
                },
                required: []
            }
        }
    }, false, KNOWLEDGE_GROUP);
    toolList.solve = async (ctx, _msg, session, args) => {
        await knowledgeService.init();
        const { page = 1, page_size = 20, query = '' } = args || {};
        const allowed = allowedLibraryIds(ctx, session);
        const libs = knowledgeService.getLibraries().filter(l => allowed.has(l.id));
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
            description: 'View the document/section structure of a knowledge base and return chunk IDs; read full content with knowledge_read',
            parameters: {
                type: 'object',
                properties: {
                    library_id: {
                        type: 'string',
                        description: 'Knowledge base ID, from knowledge_list'
                    },
                    page: {
                        type: 'integer',
                        description: 'Page number, starting at 1; default 1'
                    },
                    page_size: {
                        type: 'integer',
                        description: 'Page size; default 20, max 100'
                    }
                },
                required: ['library_id']
            }
        }
    }, false, KNOWLEDGE_GROUP);
    toolDocs.solve = async (ctx, _msg, session, args) => {
        await knowledgeService.init();
        const libraryId = typeof args.library_id === 'string' ? args.library_id : '';
        const page = parseInt(args.page, 10) || 1;
        const pageSize = parseInt(args.page_size, 10) || 20;
        const allowed = allowedLibraryIds(ctx, session);
        if (!allowed.has(libraryId)) return `知识库 ${libraryId} 不可用（平台限制或已在本会话关闭）`;
        return knowledgeService.formatLibraryDocs(libraryId, page, pageSize);
    };
}
