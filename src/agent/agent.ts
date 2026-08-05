// 智能体（Agent）：角色配置 + 会话服务，chat() 按 use 选择模型发起对话
import Config from "../config/config";
import { logger } from "../logger";
import { SessionService } from "../session/session_service";
import { ToolName } from "../tool/tool";
import { revive, TypeDescriptor } from "../utils/utils";
import Model from "../model/model";
import { ChatModelUse } from "../model/types";
import Tool from "../tool/tool";
import { ToolInfo } from "../tool/types";
import ChatModel from "../model/chat";
import { streamService } from "./stream";
import { Session } from "../session/session";

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
    tools: ToolName[];
    subAgents: string[];

    constructor() {
        this.name = "";
        this.description = "";
        this.instruction = "";
        this.use = "chat";
        this.sessionService = new SessionService();
        this.sessionService.agentName = this.name;
        this.tools = [];
        this.subAgents = [];
    }

    getRequestTools(session?: Session): ToolInfo[] | null {
        if (session) return Tool.getToolsInfo(session);
        return null;
    }

    async chat(prompt: string): Promise<string> {
        const model = Model.getChatModel(this.use) as ChatModel;
        if (!model) return '';
        const messages: { role: string, content: string }[] = [];
        if (this.instruction) {
            messages.push({
                role: 'system',
                content: typeof this.instruction === 'function' ? this.instruction(this.sessionService) : this.instruction
            });
        }
        messages.push({ role: 'user', content: prompt });
        const { content } = await streamService.sendChatRequest(messages, null, 'none');
        return content;
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
            agent.sessionService.agentName = name;
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
