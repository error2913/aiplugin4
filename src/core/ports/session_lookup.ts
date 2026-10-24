// 会话解析端口（L0 叶子）：按 sessionId 取会话，委托默认 Agent 的 SessionService。
// 目的：timer / media 等模块只需按 id 找会话，不应 import session_service（后者反过来依赖 Session，
// 会与 timer/judge 组成编排环）。
import type { Session } from "../../session/session";

import { getAgent } from "./agent_registry";

export function getSessionById(sessionId: string): Session {
    return getAgent('*').sessionService.getSession(sessionId);
}
