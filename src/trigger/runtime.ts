// 触发域运行时单例（L2）：规则库与 delay 挂起槽的唯一实例，供 L2/L3/L4 共享。
//
// 为什么放在 L2：工具层（L3）需要创建/删除规则，命令层（L4）需要展示规则，
// 编排层（L4 pipeline/trigger_rule）需要求值；实例若放在 L4，L3 工具就会反向依赖 L4。
// knownEvents 在此注入（event 同属 L2），保证规则校验与事件白名单一致。
import { EVENT_TRIGGER_KNOWN_EVENTS } from "../event/trigger";

import { PendingDelays } from "./pending";
import { TriggerRuleStore } from "./store";

let storeInstance: TriggerRuleStore | null = null;

/** 规则库单例（懒加载；测试用 resetTriggerRuntimeForTest 重置） */
export function getRuleStore(): TriggerRuleStore {
    if (!storeInstance) {
        storeInstance = new TriggerRuleStore({ knownEvents: EVENT_TRIGGER_KNOWN_EVENTS });
    }
    return storeInstance;
}

/** delay 挂起槽单例（内存；payload 由调用方决定） */
export const pendingDelays = new PendingDelays<unknown>();

/** 仅测试：重置规则库与挂起槽 */
export function resetTriggerRuntimeForTest(): void {
    storeInstance = null;
    pendingDelays.clear();
}
