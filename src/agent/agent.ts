import { Config } from "../config/config";
import { logger } from "../logger";
import { SessionService } from "../session/session";
import { revive, TypeDescriptor } from "../utils/utils";
import Model from "./model";
import { ChatModelUse, ModelUse } from "./types";

export default class Agent {
    static validKeysMap: { [key in keyof Agent]?: TypeDescriptor<Agent[key]> } = {
        sessionService: SessionService,
        tools: { array: 'string' },
        subAgents: { array: 'string' }
    }

    name: string;
    description: string;
    instruction: string | ((sessionService: SessionService) => string);
    use: ChatModelUse;

    sessionService: SessionService;
    tools: string[];
    subAgents: string[];

    constructor() {
        this.name = "";
        this.description = "";
        this.instruction = "";
        this.use = "chat";
        this.sessionService = new SessionService();
        this.tools = [];
        this.subAgents = [];
    }

    // wip
    getRequestTools() {
    }

    async chat(prompt: string): Promise<string> {
        const model = Model.getChatModel(this.use);
    }

    static agentMap: { [key: string]: Agent } = {};

    static get(name: string): Agent {
        if (!this.agentMap.hasOwnProperty(name)) {
            let agent = new Agent();
            try {
                const data = JSON.parse(Config.ext.storageGet(`agent_${name}`) || '{}');
                agent = revive(Agent, data);
            } catch (error) {
                logger.error(`加载智能体${name}失败: ${error}`);
            }
            agent.name = name;
            this.agentMap[name] = agent;
        }
        return this.agentMap[name];
    }

    static save(agent: Agent) {
        Config.ext.storageSet(`agent_${agent.name}`, JSON.stringify(agent));
    }

    static init() {

    }
}