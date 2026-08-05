// 知识库服务：按角色加载知识库记忆与检索（继承记忆服务）
import Logger from "../logger";
import Config from "../config/config";
import { revive, TypeDescriptor } from "../utils/utils";
import MemoryService from "./memory";
import MemoryItem from "./memory_item";
import { GroupInfo, UserInfo } from "../session/types";
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
        const { KNOWLEDGE } = Config.memory;
        const { KNOWLEDGE_TEMPLATE } = Config.prompt;
        return KNOWLEDGE_TEMPLATE({
            "KNOWLEDGE": KNOWLEDGE,
            "memories": this.getTopScoreMemories(text, users, groups)
        });
    }


    get memoryIdList() {
        return Object.keys(this.memoryMap);
    }

    async init() {
        await KnowledgeService.get('*');
    }

    async updateKnowledgeMemory(roleIndex: number) {
        const { ROLE_NAMES } = Config.message as any;
        const role = (ROLE_NAMES && ROLE_NAMES[roleIndex]) || '*';
        if (this.role !== role) {
            const ks = await KnowledgeService.get(role);
            this.role = role;
            this.memoryMap = ks.memoryMap;
        }
    }

    buildKnowledgeMemory(memoryList: MemoryItem[]): string {
        if (memoryList.length === 0) return '';
        return memoryList.map((m, i) =>
            (i + 1) + '. [' + m.id + '] ' + m.content
        ).join('\n');
    }

    async buildKnowledgeMemoryPrompt(roleIndex: number, text: string, ui: UserInfo, gi: GroupInfo): Promise<string> {
        await this.updateKnowledgeMemory(roleIndex);
        if (this.memoryIds.length === 0) return '';

        const { KNOWLEDGE_SHOW_NUMBER } = Config.memory;
        const memoryList = await this.search(text, {
            topK: KNOWLEDGE_SHOW_NUMBER,
            tags: [],
            relatedMemories: [],
            users: ui ? [ui.id] : [],
            groups: gi ? [gi.id] : [],
            method: 'score'
        });

        return this.buildKnowledgeMemory(memoryList);
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
export const knowledgeService = new KnowledgeService();
