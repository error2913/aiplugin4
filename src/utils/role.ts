// 角色设定解析（L2 叶子）：按 $gSYSPROMPT（角色名/序号）选择当前角色，供消息构建与提示词组装复用。
import Config from "../config/config";

/** 解析当前生效的角色：名称优先，其次序号，缺省第 0 个。 */
export function getRoleSetting(ctx: seal.MsgContext) {
    const { ROLE_NAMES, ROLE_SETTINGS, INSTRUCTIONS } = Config.role;
    const [roleName, exists] = seal.vars.strGet(ctx, "$gSYSPROMPT");
    let roleIndex = 0;
    if (exists && roleName !== '' && ROLE_NAMES.includes(roleName)) {
        roleIndex = ROLE_NAMES.indexOf(roleName);
        if (roleIndex < 0 || roleIndex >= INSTRUCTIONS.length) roleIndex = 0;
    } else {
        const [roleIndex2, exists2] = seal.vars.intGet(ctx, "$gSYSPROMPT");
        if (exists2 && roleIndex2 >= 0 && roleIndex2 < INSTRUCTIONS.length) roleIndex = roleIndex2;
    }
    return { roleName, roleIndex, roleSetting: ROLE_SETTINGS[roleIndex] || '' };
}
