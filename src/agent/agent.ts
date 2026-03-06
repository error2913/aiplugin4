import { ConfigManager } from "../config/configManager";
import { logger } from "../logger";
import { SessionService } from "../session/session";
import { revive, TypeDescriptor } from "../utils/utils";

export class Agent {
    static validKeysMap: { [key in keyof Agent]?: TypeDescriptor<Agent[key]> } = {
        name: 'string',
        description: 'string',
        instruction: 'string',
        sessionService: SessionService,
        tool: { array: 'string' },
    }
    name: string;
    description: string;
    instruction: string;
    sessionService: SessionService;
    tool: string[];

    constructor() {
        this.description = "";
        this.instruction = "";
        this.sessionService = new SessionService();
        this.tool = [];
    }

    // wip
    getTools() {
    }

    async chat() {

    }
}

export class AgentManager {
    static agentMap: { [key: string]: Agent } = {};

    static getAgent(name: string): Agent {
        if (!this.agentMap.hasOwnProperty(name)) {
            let agent = new Agent();
            try {
                const data = JSON.parse(ConfigManager.ext.storageGet(`agent_${name}`) || '{}');
                agent = revive(Agent, data);
            } catch (error) {
                logger.error(`加载智能体${name}失败: ${error}`);
            }
            agent.name = name;
            this.agentMap[name] = agent;
        }
        return this.agentMap[name];
    }

    static save() {

    }
}