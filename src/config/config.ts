import { setLoggerConfigProvider } from "../logger";

import BackendConfig from "./configs/backend";
import BaseConfig from "./configs/base";
import ContextConfig from "./configs/context";
import ErrorConfig from "./configs/error";
import EventConfig from "./configs/event";
import ForumConfig from "./configs/forum";
import ImageConfig from "./configs/image";
import KnowledgeBaseConfig from "./configs/knowledge_base";
import McpConfig from "./configs/mcp";
import MemoryConfig from "./configs/memory";
import ModelConfig from "./configs/model";
import ReceivedConfig from "./configs/received";
import ReplyConfig from "./configs/reply";
import ResourceConfig from "./configs/resource";
import RoleConfig from "./configs/role";
import SkillsConfig from "./configs/skills";
import SubAgentConfig from "./configs/subagent";
import ToolConfig from "./configs/tool";
import TriggerConfig from "./configs/trigger";
import WebConfigStore from "./configs/web";
import { runConfigHook } from "./hooks";
import { CONFIG_CACHE_TTL } from "./static_config";

// 宿主句柄与正则配置已下沉到叶子模块，configs/* 直接引用它们，不再经本文件（拆掉 config ↔ configs 环）。
// 这里保留 re-export，兼容既有 import { ext } from "config/config" 的调用方。
export { ext } from "./ext";
export { getRegexConfig } from "./regex";
// 注册顺序 = 配置页签顺序；「错误处理」固定放到最后（模型新配置紧随基础）
const configMap = {
    base: BaseConfig,
    model: ModelConfig,
    role: RoleConfig,
    context: ContextConfig,
    received: ReceivedConfig,
    trigger: TriggerConfig,
    reply: ReplyConfig,
    tool: ToolConfig,
    web: WebConfigStore,
    mcp: McpConfig,
    skills: SkillsConfig,
    subagent: SubAgentConfig,
    memory: MemoryConfig,
    knowledgeBase: KnowledgeBaseConfig,
    image: ImageConfig,
    backend: BackendConfig,
    forum: ForumConfig,
    event: EventConfig,
    resource: ResourceConfig,
    error: ErrorConfig,
} as const;

type ConfigMap = typeof configMap;
type ConfigKey = keyof ConfigMap;
type ConfigProps = { [K in ConfigKey]: ReturnType<ConfigMap[K]["get"]> };
type ConfigProp = ConfigProps[ConfigKey];

interface ConfigCache {
    timestamp: number,
    data: ConfigProp
}

class _Config {
    static cache: { [K in ConfigKey]?: ConfigCache } = {}

    static registerConfig() {
        for (const k of Object.keys(configMap) as ConfigKey[]) {
            configMap[k].register();
            Object.defineProperty(this, k, {
                get: () => this.getCache(k, configMap[k].get)
            })
        }
        this.warmup();
    }

    /**
     * 启动预热（目前是模型配置）：必须走 getCache 访问器而不是直接调 configs/model.get()，
     * 否则分区钩子（runConfigHook → 如 Model.bootstrap）不会执行，Model 注册表为空。
     * 这也是「配置解析（configs）与配置应用（apply）分离」后唯一保证应用时机的入口。
     */
    static warmup() {
        this.getCache('model', ModelConfig.get);
    }

    /** 让指定分区的配置缓存失效（.ai xxx refresh 使用） */
    static invalidate(...keys: ConfigKey[]) {
        for (const key of keys) delete this.cache[key];
    }

    static getCache(key: ConfigKey, getFunc: () => ConfigProp): ConfigProp {
        const timestamp = Date.now()
        if (this.cache?.[key] && timestamp - this.cache[key].timestamp < CONFIG_CACHE_TTL) {
            return this.cache[key].data;
        }
        // 配置段只负责解析；依赖实现的「应用/派生」由组合根注册的钩子完成（拆掉 config ↔ 实现环）
        const data = runConfigHook(key, getFunc());
        this.cache[key] = {
            timestamp: timestamp,
            data: data
        }
        return data;
    }

}

const Config = _Config as typeof _Config & ConfigProps;
export default Config;

// 日志开关提供者：logger 不 import config（拆掉 config ↔ logger 循环依赖），改由这里注入。
// provider 读 Config.base（带 60s TTL 缓存），保持「面板改日志级别后在缓存周期内生效」的原语义；
// 配置尚未注册时返回空对象，logger 会回退出厂默认值。
setLoggerConfigProvider(() => {
    const base = (Config as any).base;
    if (!base) return {};
    return {
        level: base.LOG_LEVEL,
        shortPrint: base.LOG_SHORT_PRINT,
        messageContent: base.LOG_MESSAGE_CONTENT,
    };
});

