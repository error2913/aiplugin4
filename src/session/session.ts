import Agent from "../agent/agent";
import { Config } from "../config/config";
import { logger } from "../logger";
import { toolMap, ToolName, ToolState } from "../tool/tool";
import { ToolListen } from "../tool/types";
import { revive, TypeDescriptor } from "../utils/utils";
import { Context } from "./context";
import { MemoryService } from "../memory/memory";
import { RequestMessage, SessionType, State } from "./types";
import KnowledgeService from "../memory/knowlege";
import SessionMemoryService from "../memory/session_memory";

export class Session {
    static validKeysMap: { [key in keyof Session]?: TypeDescriptor<Session[key]> } = {
        agentName: 'string',
        sessionId: 'string',
        sessionType: 'string',
        state: {
            object: {
                description: 'string',
                impression: 'string',
            },
            objectValue: 'any'
        },
        context: Context,
        memory: SessionMemoryService,
        tool: {
            object: {
                state: { objectValue: 'boolean' }
            },
            objectValue: 'default'
        },
        ignoredUserIdList: { array: 'string' },
    }
    agentName: string;
    sessionId: string;
    sessionType: SessionType;
    state: State;
    context: Context;
    memory: SessionMemoryService;
    tool: {
        state: ToolState,
        callCount: number, // 单次触发调用函数计数
        listen: ToolListen // 监听调用函数发送的内容
    }
    ignoredUserIdList: string[];

    constructor() {
        this.agentName = '';
        this.sessionId = '';
        this.sessionType = 'group';
        this.state = {
            description: '',
            impression: '',
        };
        this.context = new Context();
        this.tool = {
            state: Object.keys(toolMap).reduce((acc, key) => {
                acc[key as ToolName] = false;
                return acc;
            }, {} as ToolState),
            callCount: 0,
            listen: {
                timeoutId: null,
                resolve: null,
                reject: null,
                cleanup: () => {
                    if (this.tool.listen.timeoutId) clearTimeout(this.tool.listen.timeoutId);
                    this.tool.listen.timeoutId = null;
                    this.tool.listen.resolve = null;
                    this.tool.listen.reject = null;
                }
            }
        }
        this.ignoredUserIdList = [];
    }

    // wip
    getMessages(): RequestMessage[] {
        return [];
    }

    // wip
    getImageMessages(): RequestMessage[] {
        return [];
    }

    get toolState(): ToolState {
        const { BLOCKED, DEFAULT_CLOSED } = Config.tool;
        const tools = Agent.get(this.agentName).tools;
        const state: ToolState = {};
        tools.forEach(tool => {
            if (BLOCKED.includes(tool)) return;
            if (!this.state.hasOwnProperty(tool)) this.state[tool] = !DEFAULT_CLOSED.includes(tool);
            state[tool] = this.state[tool];
        })
        return this.tool.state;
    }
}

export class SessionService {
    static validKeysMap: { [key in keyof SessionService]?: TypeDescriptor<SessionService[key]> } = {
        agentName: 'string',
        memory: MemoryService,
        sessionMap: { objectValue: Session }
    }
    agentName: string;
    memory: MemoryService; // 全局记忆服务
    sessionMap: { [key: string]: Session };

    constructor() {
        this.agentName = '';
        this.sessionMap = {};
    }

    getSession(sessionId: string): Session {
        if (!this.sessionMap.hasOwnProperty(sessionId)) {
            let session = new Session();
            try {
                const data = JSON.parse(Config.ext.storageGet(`session_${sessionId}`) || '{}');
                session = revive(Session, data);
            } catch (error) {
                logger.error(`加载会话${sessionId}失败: ${error}`);
            }
            session.sessionId = sessionId;
            if (sessionId.startsWith('QQ:')) session.sessionType = 'user';
            session.agentName = this.agentName;
            this.sessionMap[sessionId] = session;
        }
        return this.sessionMap[sessionId];
    }

    get knowledge(): KnowledgeService {
        if (!knowledgeServiceMap.hasOwnProperty(this.agentName)) return knowledgeServiceMap['*'];
        return knowledgeServiceMap[this.agentName];
    }
}