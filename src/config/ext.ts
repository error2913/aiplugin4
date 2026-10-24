// SealDice 扩展句柄（叶子模块）：只依赖 seal 全局与 static_config 常量。
// 从 config/config.ts 拆出的原因：configs/* 与大量业务模块都要 ext，若都从 config.ts 取，
// 就会把「配置总线」整个拉进来，形成 config ↔ configs 的注册环（config.ts 需要 import 全部 configs）。
import { AUTHOR, NAME, VERSION } from "./static_config";

export const ext: seal.ExtInfo = (() => {
    let e = seal.ext.find(NAME);
    if (!e) {
        e = seal.ext.new(NAME, AUTHOR, VERSION);
        seal.ext.register(e);
    }
    return e;
})();
