import Agent from "../agent/agent";
import { Config } from "../config/config";
import { logger } from "../logger";
import { toolMap, ToolName, ToolState } from "../tool/tool";
import { ToolListen } from "../tool/types";
import { revive, TypeDescriptor } from "../utils/utils";
import { Context } from "../context/context";
import { MemoryService } from "../memory/memory";
import { RequestMessage, SessionType, State } from "./types";
import KnowledgeService from "../memory/knowledge";
import SessionMemoryService from "../memory/session_memory";
import Group from "./group";
import User from "./user";

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
        }
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

    constructor() {
        this.agentName = '';
        this.sessionId = '';
        this.sessionType = 'group';
        this.state = {
            description: '',
            impression: '',
        };
        this.context = new Context();
        this.memory = new SessionMemoryService();
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
    }

    get agent(): Agent {
        return Agent.get(this.agentName);
    }
    get user(): User | null {
        return this.sessionType === 'user' ? User.get(this.sessionId) : null;
    }
    get group(): Group | null {
        return this.sessionType === 'group' ? Group.get(this.sessionId) : null;
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

    // wip
    getMessages(): RequestMessage[] {
        return [];
    }

    // wip
    getImageMessages(): RequestMessage[] {
        return [];
    }

    checkIgnoredUserId(userId: string): boolean {
        return this.sessionType === 'group' && Group.get(this.sessionId).ignoredUserIdList.includes(userId);
    }
}