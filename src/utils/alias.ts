// 指令别名归一（叶子模块）。
import { ALIAS_MAP } from "../config/static_config";
export function aliasToCmd(val: string) {
    return ALIAS_MAP[val as keyof typeof ALIAS_MAP] || val;
}

