// Seal API 工具注册统一入口
import Tool from "../../tool";

import { registerAttrSeal } from "./tool_attr";

/** 注册 Seal API 工具（分类：属性） */
export function registerSealTools() {
    Tool.withCategory('属性', registerAttrSeal);
}
