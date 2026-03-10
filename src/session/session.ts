import Agent from "../agent/agent";
import { Config } from "../config/config";
import { logger } from "../logger";
import { toolMap, ToolName, ToolState } from "../tool/tool";
import { ToolListen } from "../tool/types";
import { revive, TypeDescriptor } from "../utils/utils";
import { Context } from "./context";
import { MemoryService } from "./memory";
import { RequestMessage, SessionType, State } from "./types";

export class Session {
    static validKeysMap: { [key in keyof Session]?: TypeDescriptor<Session[key]> } = {
        sessionId: 'string',
        sessionType: 'string',
        agentName: 'string',
        state: 'any',
        context: Context,
        tool: {
            object: {
                state: { objectValue: 'boolean' }
            }
        },
        ignoredUserIdList: { array: 'string' },
    }
    sessionId: string;
    sessionType: SessionType;
    agentName: string;
    state: State;
    context: Context;
    tool: {
        state: ToolState,
        callCount: number, // 单次触发调用函数计数
        listen: ToolListen // 监听调用函数发送的内容
    }
    ignoredUserIdList: string[];

    constructor() {
        this.sessionId = '';
        this.sessionType = 'group';
        this.agentName = '';
        this.state = {};
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
        sessionMap: { objectValue: Session },
    }
    agentName: string;
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
}