// 指令别名归一（叶子模块）：按用途域解析（命令名 / 参数动词 / 触发模式），避免 `p` 之类冲突。
// 表结构见 config/static_config/alias.ts；本文件只做转发，保持旧 import 路径兼容。
import { aliasToCmd, resolveCmdChain } from "../config/static_config";

export { aliasToCmd, resolveCmdChain };
