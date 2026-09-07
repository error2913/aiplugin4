// pub（公开会话）工具注册统一入口：pub_read / pub_send
import { registerPubRead, registerPubSend } from "./tool_pub";

export function registerPubToolSet() {
    registerPubRead();
    registerPubSend();
}
