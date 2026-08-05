// .ai sample：查看示例智能体（受示例开关控制）
import Config from "../../config/config";
import Agent from "../../agent/agent";
import { U } from "../privilege";
import { SubCmd, SubCmdContext } from "../root_cmd";

// 示例命令：展示示例智能体（sample_agent）的设定，受 Config.sample.ENABLED 开关控制
export function registerCmdSample() {
    const cmd = new SubCmd('sample');
    cmd.desc = '查看示例智能体';
    cmd.help = '【.ai sample】查看示例智能体';
    cmd.priv = { priv: U };
    cmd.solve = (scc: SubCmdContext) => {
        const { ctx, msg, ret } = scc;
        if (!Config.sample.ENABLED) {
            seal.replyToSender(ctx, msg, '示例功能未启用');
            return ret;
        }
        const sampleAgent = Agent.get('sample_agent');
        seal.replyToSender(ctx, msg, `示例智能体:\n${sampleAgent.description}\n设定: ${sampleAgent.instruction}`);
        return ret;
    }
}
