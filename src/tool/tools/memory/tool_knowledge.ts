// 知识库工具：只读检索（search/read/list），内容由配置维护，AI 不能增删
import { KB_LIST_LIMIT, knowledgeService } from "../../../memory/knowledge";
import Tool from "../../tool";

// 单次检索返回条数上限，防止模型请求超大 topK 造成上下文/API 浪费
const KB_SEARCH_TOPK_MAX = 50;

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
                    topK: {
                        type: 'number',
                        description: '返回条数，默认 5'
                    }
                },
                required: ['query']
            }
        }
    });
    toolSearch.solve = async (_ctx, _msg, _session, args) => {
        const query = typeof args.query === 'string' ? args.query : '';
        const topK = Math.min(Math.max(typeof args.topK === 'number' && args.topK > 0 ? Math.floor(args.topK) : 5, 1), KB_SEARCH_TOPK_MAX);
        const chunks = await knowledgeService.search(query, topK);
        if (chunks.length === 0) return query ? '未找到相关知识库条目' : '知识库为空';
        return chunks.map((c, i) => `${i + 1}. ${knowledgeService.formatChunk(c)}`).join('\n\n');
    };

    const toolRead = new Tool({
        type: 'function',
        function: {
            name: 'knowledge_read',
            description: '按 ID 读取知识库中某个条目的完整内容，ID 来自 knowledge_list 或 knowledge_search 的结果',
            parameters: {
                type: 'object',
                properties: {
                    id: {
                        type: 'string',
                        description: '知识库条目 ID（形如 kb_xxxxxxxx）'
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
            description: '列出知识库全部条目的 ID 与标题索引',
            parameters: {
                type: 'object',
                properties: {}
            }
        }
    });
    toolList.solve = async () => {
        await knowledgeService.init();
        const index = knowledgeService.formatIndex(undefined, KB_LIST_LIMIT);
        return index ? index : '知识库为空';
    };
}

