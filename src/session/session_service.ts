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