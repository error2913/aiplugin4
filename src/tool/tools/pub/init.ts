// pub（公开会话）工具注册统一入口：pub_read / pub_send（分类：公开会话）
import Tool from "../../tool";

import { registerPubRead, registerPubSend } from "./tool_pub";

export function registerPubToolSet() {
    Tool.withCategory('公开会话', () => {
        registerPubRead();
        registerPubSend();
    });
}
