// .ai subagent：面向用户的子代理管理（查看/停止/清理）
import { initSubAgentService, sweepSubagentParent } from "../../agent/subagent/wiring";
import { SubCmd, SubCmdContext } from "../root_cmd";

function text(scc: SubCmdContext, content: string) {
    seal.replyToSender(scc.ctx, scc.msg, content);
    return scc.ret;
}

export function registerCmdSubAgent() {
    const cmd = new SubCmd('subagent');
    cmd.desc = '查看/管理子代理（后台任务）';
    cmd.help = [
        '【.ai subagent】查看本会话子代理运行情况',
        '【.ai subagent list】列出子代理：ID / 用途 / 状态',
        '【.ai subagent stop <ID>】停止指定子代理（all=全部）',
        '【.ai subagent clean】清理已结束/已停止的记录',
    ].join('\n');
    cmd.solve = (scc: SubCmdContext) => {
        try {
            const action = (scc.cmdArgs.getArgN(2) || '').toLowerCase();
            const id = (scc.cmdArgs.getArgN(3) || '').replace(/^#/, '');
            const scope = scc.session.subagentDepth > 0 ? scc.session.parentSessionId || scc.session.sessionId : scc.session.sessionId;
            const svc = initSubAgentService();

            if (action === '' || action === 'list') {
                sweepSubagentParent(scope); // 查看前先收敛（父上下文已遗忘/遗留未绑定的清理）
                const records = svc.listByParent(scope);
                if (records.length === 0) return text(scc, '当前没有子代理任务');
                const lines = [`[子代理] 共 ${records.length} 条`];
                for (const r of records) {
                    const tail = r.lastResult ? ` · ${r.lastResult.stopReason}` : '';
                    lines.push(`  ${r.childId}\t${r.label}\t${r.status}${tail}`);
                }
                lines.push('停止：.ai subagent stop <ID>   全部停止：.ai subagent stop all');
                return text(scc, lines.join('\n'));
            }
            if (action === 'clean') {
                const n = svc.cleanTerminated(scope);
                return text(scc, n > 0 ? `已清理 ${n} 条记录` : '没有可清理的已结束记录');
            }
            if (action === 'stop') {
                if (id === 'all') {
                    const n = svc.abortByParent(scc.session.sessionId);
                    return text(scc, n > 0 ? `已停止 ${n} 个子代理` : '没有正在运行的子代理');
                }
                if (id === '') return text(scc, '用法：.ai subagent stop <ID|all>');
                svc.interrupt(id, scc.session.sessionId);
                return text(scc, `已请求停止 ${id}`);
            }
            return text(scc, `未知操作：${action}\n${cmd.help}`);
        } catch (e) {
            const detail = e instanceof Error ? e.message : String(e);
            return text(scc, `操作失败：${detail}`);
        }
    };
}
