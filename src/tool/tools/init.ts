// 工具注册统一入口：OB11 消息发送由 call_ob11_api 统一处理。
import { registerCoreTools } from "./core/init";
import { registerImageTools } from "./image/init";
import { registerManageTools } from "./manage/init";
import { registerMemoryTools } from "./memory/init";
import { registerOb11Tools } from "./ob11/init";
import { registerPubToolSet } from "./pub/init";
import { registerRawToolSet } from "./raw/init";
import { registerResourceTools } from "./resource/init";
import { registerSealTools } from "./seal/init";
import { registerWebTools } from "./web/init";

export function registerTools() {
    registerImageTools();
    registerOb11Tools();
    registerSealTools();
    registerRawToolSet();
    registerMemoryTools();
    registerResourceTools();
    registerCoreTools();
    registerWebTools();
    registerManageTools();
    registerPubToolSet();
}
