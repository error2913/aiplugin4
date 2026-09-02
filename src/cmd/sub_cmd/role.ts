// .ai role：切换角色设定
import Config from "../../config/config";
import { getRoleSetting } from "../../utils/message";
import { I } from "../privilege";
import { SubCmd, SubCmdContext } from "../root_cmd";

export function registerCmdRole() {
    const cmd = new SubCmd('role');
    cmd.desc = '切换角色设定';
    cmd.help = `帮助:
【.ai role】查看当前角色设定
【.ai role <名称>】切换角色设定（以 . 开头的名称为隐藏角色，不显示在列表中）`;
    cmd.priv = { priv: I };
    cmd.solve = (scc: SubCmdContext) => {
        const { ctx, msg, cmdArgs, ret } = scc;

        const { ROLE_NAMES: roleSettingNames, INSTRUCTIONS: roleSettingTemplate } = Config.role;
        const { roleName } = getRoleSetting(ctx);
        // 以 . 开头的角色设定为隐藏角色：不出现在列表中，但可通过 .ai role 直接切换
        const visibleNames = roleSettingNames.filter(name => !name.startsWith('.'));
        const val2 = cmdArgs.getRestArgsFrom(2).trim();
        if (!val2) {
            seal.replyToSender(ctx, msg, `当前角色设定名称为[${roleName}]，名称有:\n${visibleNames.join('、')}`);
            return ret;
        }
        if (!roleSettingNames.includes(val2)) {
            seal.replyToSender(ctx, msg, `【.ai role <名称>】切换角色设定\n角色设定名称错误，名称有:\n${visibleNames.join('、')}`);
            return ret;
        }
        const roleSettingIndex = roleSettingNames.indexOf(val2);
        if (roleSettingIndex < 0 || roleSettingIndex >= roleSettingTemplate.length) {
            seal.replyToSender(ctx, msg, `角色设定名称[${val2}]没有对应的角色设定`);
            return ret;
        }
        seal.vars.strSet(ctx, "$gSYSPROMPT", val2);
        seal.replyToSender(ctx, msg, `角色设定已切换到[${val2}]`);
        return ret;
    }
}
