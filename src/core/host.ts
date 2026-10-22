// 宿主端口（HostSeam）：把宿主能力收敛为可注入接口，核心逻辑不再直接摸全局 seal / ext。
//
// 分层：本文件属于 L0 基础层（eslint 禁止它 import 任何上层模块），因此只声明接口 + 注册表。
// 装配：产品入口 src/index.ts 先调用 setHost(createSealHost())；
//       测试入口 scripts/test-host.ts 注入内存实现，单测无需加载海豹运行时。
export interface HostStorage {
    get(key: string): string | null;
    set(key: string, value: string): void;
}

export interface HostClock {
    now(): number;
}

export interface HostFetcher {
    (url: string, init?: any): Promise<any>;
}

export interface Host {
    storage: HostStorage;
    clock: HostClock;
    fetch: HostFetcher;
    /** 海豹插件句柄；迁移期仍有模块直接使用 ext，端口留出引用便于后续统一 */
    ext: seal.ExtInfo;
}

let currentHost: Host | null = null;

/** 注入宿主实现（测试用内存实现；传 null 可清空） */
export function setHost(host: Host | null): void {
    currentHost = host;
}

/** 是否已注入宿主（测试断言/兜底判断用） */
export function hasHost(): boolean {
    return currentHost !== null;
}

/** 取宿主实现；未初始化时抛错，避免静默调用到不存在的运行时能力 */
export function getHost(): Host {
    if (!currentHost) {
        throw new Error(
            'HostSeam 未初始化：产品入口需先调用 setHost(createSealHost())；单测请用 scripts/test-host.ts 的 installTestHost()'
        );
    }
    return currentHost;
}
