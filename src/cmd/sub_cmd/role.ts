import { ConfigManager } from "../../config/configManager";
import { getRoleSetting } from "../../utils/utils_message";
import { I } from "../privilege";
import { SubCmd, SubCmdContext } from "../root";

export function registerCmdRole() {
    const cmd = new SubCmd('role');
    cmd.desc = '切换角色设定';
    cmd.help = '';
    cmd.priv = { priv: I };
    cmd.solve = (scc: SubCmdContext) => {
        const { ctx, msg, cmdArgs, ret } = scc;

        const { roleSettingNames, roleSettingTemplate } = ConfigManager.message;
        const { roleName } = getRoleSetting(ctx);
        const val2 = cmdArgs.getArgN(2);
        if (!val2) {
            seal.replyToSender(ctx, msg, `当前角色设定名称为[${roleName}]，名称有:\n${roleSettingNames.join('、')}`);
            return ret;
        }
        if (!roleSettingNames.includes(val2)) {
            seal.replyToSender(ctx, msg, `【.ai role <名称>】切换角色设定\n角色设定名称错误，名称有:\n${roleSettingNames.join('、')}`);
            return ret;
        }
        const roleSettingIndex = roleSettingNames.indexOf(val2);
        if (roleSettingIndex < 0 || roleSettingIndex >= roleSettingTemplate.length) {
            seal.replyToSender(ctx, msg, `角色设定名称[${val2}]没有对应的角色设定`);
        }
        seal.vars.strSet(ctx, "$gSYSPROMPT", val2);
        seal.replyToSender(ctx, msg, `角色设定已切换到[${val2}]`);
        return ret;
    }
}