// 工具执行器：统一函数调用与提示词工程两种工具执行路径，并记录调用审计日志
import Logger from "../logger";
import { Session } from "../session/session";

import Tool from "./tool";
import { ToolCall, ToolCallResult } from "./types";

export class ToolRunner {
    /** 函数调用模式：直接执行模型返回的 tool_calls */
    static async executeFunctionCalls(ctx: seal.MsgContext, msg: seal.Message, session: Session, toolCalls: ToolCall[]): Promise<ToolCallResult[]> {
        const { result } = await Tool.handleToolCalls(ctx, msg, session, toolCalls);
        ToolRunner.audit(session, result);
        return result;
    }

    /** 提示词工程模式：解析 <function> 文本并执行 */
    static async executePromptCalls(ctx: seal.MsgContext, msg: seal.Message, session: Session, toolCallStr: string): Promise<ToolCallResult[]> {
        const { result } = await Tool.handlePromptToolCalls(ctx, msg, session, toolCallStr);
        ToolRunner.audit(session, result);
        return result;
    }

    /** 工具调用审计：记录会话、工具与结果摘要，便于排查与风控 */
    private static audit(session: Session, results: ToolCallResult[]) {
        for (const r of results) {
            const summary = r.content.length > 120 ? r.content.slice(0, 120) + '…' : r.content;
            Logger.info(`[tool] session=${session.sessionId} call=${r.tool_call_id} content=${summary}`);
        }
    }
}
