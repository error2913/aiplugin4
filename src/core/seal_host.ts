// HostSeam 的 SealDice 适配器：把全局 seal / ext 包成 Host 接口。
// 这是唯一允许直接读 ext 的宿主实现（eslint 边界规则只对 core/host.ts 生效，本文件是受控的例外）。
// 迁移进度见 docs/02 与 .dev/refactor-plan.md：storage / clock / fetch 已有端口，其余能力逐步收敛。
import { ext } from "../config/ext";

import type { Host } from "./host";

export function createSealHost(): Host {
    return {
        storage: {
            get: (key) => ext.storageGet(key) ?? null,
            set: (key, value) => { ext.storageSet(key, value); },
        },
        clock: { now: () => Date.now() },
        fetch: (url, init) => fetch(url, init),
        ext,
    };
}
