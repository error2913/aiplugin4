import Logger from "../logger";
import Config from "../config/config";
import { revive, TypeDescriptor } from "../utils/utils";
import MemoryService from "./memory";
import MemoryItem from "./memory_item";
import Agent from "../agent/agent";

export default class KnowledgeService extends MemoryService {
    static validKeysMap: { [key in keyof KnowledgeService]?: TypeDescriptor<KnowledgeService[key]> } = {
        memoryMap: { array: MemoryItem },
        role: 'string'
    };
    role: string;

    constructor() {
        super();
        this.role = '*';
    }

    async initKnowledges() {
        const { KNOWLEDGE_MEMORIES_MAP } = Config.memory;
        const knowledges = KNOWLEDGE_MEMORIES_MAP[this.role] || [];
        await Promise.all(knowledges.map(async m => m.updateVector()));
        this.memoryMap = knowledges.reduce((map, m) => {
            if (this.memoryMap.hasOwnProperty(m.id)) {
                m.lastAccessedAt = Math.max(m.lastAccessedAt, this.memoryMap[m.id].lastAccessedAt);
                m.accessCount = Math.max(m.accessCount, this.memoryMap[m.id].accessCount);
            }
            map[m.id] = m;
            return map;
        }, {} as { [id: string]: MemoryItem });
        KnowledgeService.save(this);
    }

    async accessMemories(s: string) {
        const now = Math.floor(Date.now() / 1000);
        (await this.search(s, {
            topK: 5,
            tags: [],
            relatedMemories: [],
            users: [],
            groups: [],
            method: 'similarity'
        })).forEach(m => {
            m.lastAccessedAt = now;
            m.accessCount++;
        })
        KnowledgeService.save(this);
    }

    buildKnowledgePrompt(sessionId: string, text: string): string {
        if (this.memories.length === 0) return '';
        const agent = Agent.get(this.role);
        const session = agent.sessionService.getSession(sessionId);
        const users = session.sessionType === 'group' ? session.context.users : [session.sessionId];
        const groups = session.sessionType === 'group' ? [session.sessionId] : [];
        const { KNOWLEDGE, KNOWLEDGE_TEMPLATE } = Config.memory;
        return KNOWLEDGE_TEMPLATE({
            "KNOWLEDGE": KNOWLEDGE,
            "memories": this.getTopScoreMemories(text, users, groups)
        });
    }

    static knowledgeServiceMap: { [role: string]: KnowledgeService } = {};

    static async get(role: string) {
        if (!this.knowledgeServiceMap.hasOwnProperty(role)) {
            let knowledgeService = new KnowledgeService();
            try {
                const data = JSON.parse(Config.ext.storageGet(`knowledge_${role}`) || '{}');
                knowledgeService = revive(KnowledgeService, data);
            } catch (error) {
                Logger.error(`加载知识库${role}失败: ${error}`);
            }
            knowledgeService.role = role;
            await knowledgeService.initKnowledges();
            this.knowledgeServiceMap[role] = knowledgeService;
        }
        return this.knowledgeServiceMap[role];
    }

    static save(knowledgeService: KnowledgeService) {
        Config.ext.storageSet(`knowledge_${knowledgeService.role}`, JSON.stringify(knowledgeService));
    }
}