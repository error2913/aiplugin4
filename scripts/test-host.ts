// 单测用 HostSeam 实现：存储复用 seal 桩（保持既有用例语义），时钟/网络走真实实现。
// 测试入口以副作用方式 `import "./test-host"` 即自动注入；需要自定义时再调用 setHost。
import { ext } from "../src/config/ext";
import { setHost } from "../src/core/host";

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
}

installTestHost();
