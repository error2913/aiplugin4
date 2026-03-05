import { ConfigManager } from "../config/configManager";
import { logger } from "../logger";
import { revive, TypeDescriptor } from "../utils/utils";
import { Context } from "./context";
import { MemoryService } from "./memory";

export class State {
    [key: string]: any;
}

export class Session {
    static validKeysMap: { [key in keyof Session]?: TypeDescriptor<Session[key]> } = {
        isPrivate: 'boolean',
        sessionId: 'string',
        state: 'any',
        context: Context,
        memory: MemoryService,
        // tool: ToolState; wip
        ignoredUserIdList: { array: 'string' },
    }
    isPrivate: boolean;
    sessionId: string;
    state: State;
    context: Context;
    memory: MemoryService;
    // tool: ToolState; wip
    ignoredUserIdList: string[];

    constructor() {
        this.isPrivate = false;
        this.sessionId = '';
        this.state = {};
        this.context = new Context();
        this.memory = new MemoryService();
        // this.tool = new ToolState();
        this.ignoredUserIdList = [];
    }
}

export class SessionService {
    sessionMap: { [key: string]: Session };

    constructor() {
        this.sessionMap = {};
    }

    getSession(sessionId: string): Session {
        if (!this.sessionMap.hasOwnProperty(sessionId)) {
            let session = new Session();
            try {
                const data = JSON.parse(ConfigManager.ext.storageGet(`session_${sessionId}`) || '{}');
                session = revive(Session, data);
            } catch (error) {
                logger.error(`加载会话${sessionId}失败: ${error}`);
            }
            this.sessionMap[sessionId] = session;
        }
        return this.sessionMap[sessionId];
    }
}