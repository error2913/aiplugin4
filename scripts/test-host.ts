// 单测用 HostSeam 实现：存储复用 seal 桩（保持既有用例语义），时钟/网络走真实实现。
// 测试入口以副作用方式 `import "./test-host"` 即自动注入；需要自定义时再调用 setHost。
// 同时装配配置应用钩子（与 src/index.ts 的组合根职责对齐），否则测试里 Config.model 不会应用到 Model。
import { installAuxLlm } from "../src/agent/aux_llm_impl";
import { registerConfigAppliers } from "../src/config/apply";
import { ext } from "../src/config/ext";
import { setHost } from "../src/core/host";
import { installPromptMemorySource } from "../src/prompt/memory_source_impl";

export function installTestHost(): void {
    setHost({
        storage: {
            get: (key) => ext.storageGet(key) ?? null,
            set: (key, value) => { ext.storageSet(key, value); },
        },
        clock: { now: () => Date.now() },
        fetch: (url, init) => fetch(url, init),
        ext,
    });
    registerConfigAppliers();
    installAuxLlm();
    installPromptMemorySource();
}

installTestHost();
