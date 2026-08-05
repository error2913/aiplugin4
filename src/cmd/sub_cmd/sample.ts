// .ai sample：查看示例智能体（示例命令，未注册到根命令，仅作开发参考）
import Agent from "../../agent/agent";
import { U } from "../privilege";
import { SubCmd, SubCmdContext } from "../root_cmd";

// 示例命令：展示示例智能体（sample_agent）的设定
export function registerCmdSample() {
    const cmd = new SubCmd('sample');
    cmd.desc = '查看示例智能体';
    cmd.help = '【.ai sample】查看示例智能体';
    cmd.priv = { priv: U };
    cmd.solve = (scc: SubCmdContext) => {
        const { ctx, msg, ret } = scc;
        const sampleAgent = Agent.get('sample_agent');
        seal.replyToSender(ctx, msg, `示例智能体:\n${sampleAgent.description}\n设定: ${sampleAgent.instruction}`);
        return ret;
    }
}
