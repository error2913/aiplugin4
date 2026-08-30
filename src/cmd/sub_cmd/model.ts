// .ai model：查看/设置当前会话使用的模型（按会话覆盖）
import Model from "../../model/model";
import { aliasToCmd } from "../../utils/utils";
import { U } from "../privilege";
import { SubCmd, SubCmdContext } from "../root_cmd";

/**
 * 可选用作对话的模型列表：纯文本模型全部 + 多模态模型中 use 含 chat（或未指定用途）的条目；
 * 同名去重（纯文本模型优先，命中时按纯文本处理），多模态条目标注（多模态）。
 */
function listChatModels(): { name: string, multimodal: boolean }[] {
    const list: { name: string, multimodal: boolean }[] = [];
    const seen = new Set<string>();
    for (const m of Model.chatModels) {
        if (seen.has(m.name)) continue;
        seen.add(m.name);
        list.push({ name: m.name, multimodal: false });
    }
    for (const m of Model.multimodalModels) {
        if (!(m.use.includes('chat') || m.use.length === 0)) continue;
        if (seen.has(m.name)) continue;
        seen.add(m.name);
        list.push({ name: m.name, multimodal: true });
    }
    return list;
}

export function registerCmdModel() {
    const cmd = new SubCmd('model');
    cmd.desc = '查看/设置当前会话使用的模型';
    cmd.help = `帮助:
【.ai model】查看当前会话模型与可用模型列表
【.ai model <模型名称>】设置当前会话模型
【.ai model clr】清除当前会话模型设置，使用全局默认`;
    cmd.priv = { priv: U };
    cmd.solve = (scc: SubCmdContext) => {
        const { ctx, msg, cmdArgs, session, ret } = scc;
        const val2 = cmdArgs.getArgN(2);

        if (!val2) {
            const candidates = listChatModels();
            const model = Model.getChatModel('chat', session.setting.modelName);
            const currentName = session.setting.modelName || (model ? model.name : '');
            const currentSuffix = model && model.isMultimodal ? '（多模态）' : '';
            const currentText = currentName ? `${currentName}${currentSuffix}` : '未配置';
            const listText = candidates.length === 0
                ? '（未配置任何纯文本模型）'
                : candidates.map((c, i) => `${i + 1}. ${c.name}${c.multimodal ? '（多模态）' : ''}${c.name === currentName ? '（当前）' : ''}`).join('\n');
            seal.replyToSender(ctx, msg, `当前模型: ${currentText}\n可用纯文本模型:\n${listText}`);
            return ret;
        }

        if (aliasToCmd(val2) === 'clear') {
            session.setting.modelName = '';
            session.save();
            seal.replyToSender(ctx, msg, '已清除当前会话的模型设置');
            return ret;
        }

        const candidates = listChatModels();
        const target = candidates.find(c => c.name === val2);
        if (!target) {
            const listText = candidates.map(c => c.multimodal ? `${c.name}（多模态）` : c.name).join('、');
            seal.replyToSender(ctx, msg, `模型 ${val2} 不存在，可用的纯文本模型: ${listText}`);
            return ret;
        }

        session.setting.modelName = val2;
        session.save();
        seal.replyToSender(ctx, msg, `已设置当前会话模型为 ${val2}${target.multimodal ? '（多模态）' : ''}`);
        return ret;
    }
}
