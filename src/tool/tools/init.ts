// 工具注册统一入口：OB11 消息发送由 call_ob11_api 统一处理。
// 各 register* 函数内部用 Tool.withCategory 标注内置分类（.ai tool 组概览与组开关用）。
import { registerContextTools } from "./context/init";
import { registerCoreTools } from "./core/init";
import { registerImageTools } from "./image/init";
import { registerManageTools } from "./manage/init";
import { registerMcpToolSet } from "./mcp/init";
import { registerMediaTools } from "./media/init";
import { registerKnowledgeTools, registerMemoryTools } from "./memory/init";
import { registerOb11Tools } from "./ob11/init";
import { registerPubToolSet } from "./pub/init";
import { registerRawToolSet } from "./raw/init";
import { registerResourceTools } from "./resource/init";
import { registerSealTools } from "./seal/init";
import { registerSubagentTools } from "./subagent/init";
import { registerWebTools } from "./web/init";

export function registerTools() {
    registerImageTools();
    registerOb11Tools();
    registerSealTools();
    registerRawToolSet();
    registerMemoryTools();
    registerKnowledgeTools();
    registerResourceTools();
    registerMediaTools();
    registerCoreTools();
    registerWebTools();
    registerManageTools();
    registerPubToolSet();
    registerSubagentTools();
    registerContextTools();
    registerMcpToolSet();
}
