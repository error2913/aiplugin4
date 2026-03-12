import MemoryService from "./memory";

export default class KnowledgeService extends MemoryService {
    constructor() {
        super();
    }

    init() {
        const data = JSON.parse(Config.ext.storageGet('knowledge') || '{}');
        const ms = revive(MemoryService, data);
        this.memoryMap = ms.memoryMap;
    }

    save() {
        Config.ext.storageSet('knowledge', JSON.stringify(this.memoryMap));
    }

    // wip 和配置一起改
    async updateKnowledgeMemory(roleIndex: number) {
        const { knowledgeMemoryStringList } = Config.memory;
        if (roleIndex < 0 || roleIndex >= knowledgeMemoryStringList.length) return;
        const s = knowledgeMemoryStringList[roleIndex];
        if (!s) return;

        const memoryMap: { [id: string]: MemoryItem } = {}
        const segs = s.split(/\n-{3,}\n/);
        for (const seg of segs) {
            if (!seg.trim()) continue;

            const lines = seg.split('\n');
            if (lines.length === 0) continue;

            const m = new MemoryItem();
            for (let i = 0; i < lines.length; i++) {
                const match = lines[i].match(/^\s*?(ID|用户|群聊|关键词|图片|内容)\s*?[:：](.*)/);
                if (!match) {
                    continue;
                }
                const type = match[1];
                const value = match[2].trim();
                switch (type) {
                    case 'ID': {
                        m.id = value;
                        break;
                    }
                    case '用户': {
                        m.userList = value.split(/[,，]/).map(s => {
                            const segs = s.split(/[:：]/).map(s => s.trim()).filter(s => s);
                            if (segs.length < 2) return null;
                            const name = value.replace(/[:：].*$/, '').trim();
                            const id = segs[segs.length - 1];
                            if (!name || !id) return null;
                            return { isPrivate: true, id, name };
                        }).filter(ui => ui) as UserInfo[];
                        break;
                    }
                    case '群聊': {
                        m.groupList = value.split(/[,，]/).map(s => {
                            const segs = s.split(/[:：]/).map(s => s.trim()).filter(s => s);
                            if (segs.length < 2) return null;
                            const name = value.replace(/[:：].*$/, '').trim();
                            const id = segs[segs.length - 1];
                            if (!name || !id) return null;
                            return { isPrivate: false, id, name };
                        }).filter(ui => ui) as GroupInfo[];
                        break;
                    }
                    case '关键词': {
                        m.tags = value.split(/[,，]/).map(kw => kw.trim()).filter(kw => kw);
                        break;
                    }
                    case '图片': {
                        const { localImagePathMap } = Config.image;

                        m.images = value.split(/[,，]/).map(id => id.trim()).map(id => {
                            if (localImagePathMap.hasOwnProperty(id)) {
                                const image = new Image();
                                image.file = localImagePathMap[id];
                                return image;
                            }
                            logger.error(`图片${id}不存在`);
                            return null;
                        }).filter(img => img);
                        break;
                    }
                    case '内容': {
                        m.content = lines.slice(i).join('\n').trim().replace(/^内容[:：]/, '');
                        break;
                    }
                    default: continue;
                }
            }

            if (!m.id && !m.content) continue;

            memoryMap[m.id] = m;
        }

        const now = Math.floor(Date.now() / 1000);
        await Promise.all(Object.values(memoryMap).map(async m => {
            if (this.memoryMap.hasOwnProperty(m.id)) {
                const m2 = this.memoryMap[m.id];
                m.vector = m2.vector;
                if (m2.content !== m.content) await m.updateVector();
                m.createAt = m2.createAt;
                m.lastAccessedAt = m2.lastAccessedAt;
                m.weight = m2.weight;
            } else {
                await m.updateVector();
                m.createAt = now;
                m.lastAccessedAt = now;
                m.weight = 5;
            }
        }))

        this.memoryMap = memoryMap;
        this.save();
    }

    // wip
    buildKnowledgeMemory(memoryList: MemoryItem[]) {
        const { showNumber } = Config.message;
        const { knowledgeMemorySingleShowTemplate } = Config.memory;
        if (memoryList.length === 0) return '';

        let prompt = '';
        if (memoryList.length === 0) {
            prompt = '无';
        } else {
            prompt = memoryList
                .map((m, i) => {
                    return knowledgeMemorySingleShowTemplate({
                        "序号": i + 1,
                        "记忆ID": m.id,
                        "用户列表": m.userList.map(u => u.name + (showNumber ? `(${u.id.replace(/^.+:/, '')})` : '')).join(';'),
                        "群聊列表": m.groupList.map(g => g.name + (showNumber ? `(${g.id.replace(/^.+:/, '')})` : '')).join(';'),
                        "关键词": m.tags.join(';'),
                        "记忆内容": m.content
                    });
                }).join('\n');
        }

        return prompt;
    }

    // wip
    async buildKnowledgeMemoryPrompt(roleIndex: number, text: string, ui: UserInfo, gi: GroupInfo): Promise<string> {
        await this.updateKnowledgeMemory(roleIndex);
        if (this.memoryIds.length === 0) return '';

        const { knowledgeMemoryShowNumber } = Config.memory;
        const memoryList = await this.search(text, {
            topK: knowledgeMemoryShowNumber,
            userIdList: ui ? [ui] : [],
            groupIdList: gi ? [gi] : [],
            tags: [],
            includeImages: false,
            method: 'score'
        });

        return this.buildKnowledgeMemory(memoryList);
    }
}