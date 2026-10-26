// 记忆配置应用：重建引擎读取新回调/上限/默认值；不要求重载插件。
import { resetMemoryEngineInstance } from "../../memory/service";

export function applyMemoryConfig(_data?: unknown): void {
    // 引擎惰性创建；清空后下一次读写按最新配置重建。
    resetMemoryEngineInstance();
}
