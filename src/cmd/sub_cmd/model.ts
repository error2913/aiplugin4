// .ai model：查看/设置当前会话使用的模型（按会话覆盖）
import Model from "../../model/model";
import { aliasToCmd } from "../../utils/utils";
import { U } from "../privilege";
import { SubCmd, SubCmdContext } from "../root_cmd";

export function registerCmdModel() {
    const cmd = new SubCmd('model');
    cmd.desc = '查看/设置当前会话使用的模型';
    cmd.help = `帮助:
【.ai model】查看当前会话模型
【.ai model <模型名称>】设置当前会话模型
【.ai model clr】清除当前会话模型设置，使用全局默认`;
    cmd.priv = { priv: U };
    cmd.solve = (scc: SubCmdContext) => {
        const { ctx, msg, cmdArgs, session, ret } = scc;
        const val2 = cmdArgs.getArgN(2);

        if (!val2) {
            const model = Model.getChatModel('chat', session.setting.modelName);
            seal.replyToSender(ctx, msg, `当前模型: ${session.setting.modelName || (model ? model.name : '未配置')}`);
            return ret;
        }

        if (aliasToCmd(val2) === 'clear') {
            session.setting.modelName = '';
            session.save();
            seal.replyToSender(ctx, msg, '已清除当前会话的模型设置');
            return ret;
        }

        const exists = Model.chatModels.some(m => m.name === val2);
        if (!exists) {
            seal.replyToSender(ctx, msg, `模型 ${val2} 不存在，可用的对话模型: ${Model.chatModels.map(m => m.name).join('、')}`);
            return ret;
        }

        session.setting.modelName = val2;
        session.save();
        seal.replyToSender(ctx, msg, `已设置当前会话模型为 ${val2}`);
        return ret;
    }
}
