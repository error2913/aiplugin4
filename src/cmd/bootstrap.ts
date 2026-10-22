// 命令装配入口：只被 src/index.ts 调用。
// 拆分前 root_cmd.ts 直接 import 全部 31 个子命令，而子命令又 import 回 SubCmd 类，
// 形成「根命令 ↔ 子命令」的注册副作用环（31 个模块）。现在装配在入口完成，root_cmd 只保留分发。
import { CmdPriv, defaultCmdPriv } from "./privilege";
import { registerCmd, SubCmd } from "./root_cmd";
import { registerCmdBalance } from "./sub_cmd/balance";
import { registerCmdBlock } from "./sub_cmd/block";
import { registerCmdCtx } from "./sub_cmd/ctx";
import { registerCmdCtxn } from "./sub_cmd/ctxn";
import { registerCmdCtxSet } from "./sub_cmd/ctxset";
import { registerCmdForget } from "./sub_cmd/forget";
import { registerCmdIgnore } from "./sub_cmd/ignore";
import { registerCmdImage } from "./sub_cmd/image";
import { registerCmdKb } from "./sub_cmd/kb";
import { registerCmdLive } from "./sub_cmd/live";
import { registerCmdMcp } from "./sub_cmd/mcp";
import { registerCmdMedia } from "./sub_cmd/media";
import { registerCmdMemory } from "./sub_cmd/memory";
import { registerCmdModel } from "./sub_cmd/model";
import { registerCmdOff } from "./sub_cmd/off";
import { registerCmdOn } from "./sub_cmd/on";
import { registerCmdPrivilege } from "./sub_cmd/privilege";
import { registerCmdPrompt } from "./sub_cmd/prompt";
import { registerCmdPub } from "./sub_cmd/pub";
import { registerCmdRole } from "./sub_cmd/role";
import { registerCmdSkill } from "./sub_cmd/skill";
import { registerCmdStandby } from "./sub_cmd/standby";
import { registerCmdStatus } from "./sub_cmd/status";
import { registerCmdStop } from "./sub_cmd/stop";
import { registerCmdSubAgent } from "./sub_cmd/subagent";
import { registerCmdTimer } from "./sub_cmd/timer";
import { registerCmdToken } from "./sub_cmd/token";
import { registerCmdTool } from "./sub_cmd/tool";
import { registerCmdTti } from "./sub_cmd/tti";
import { registerCmdTts } from "./sub_cmd/tts";

/**
 * 注册全部 .ai 子命令 → 汇总子命令权限 → 注册根命令 .ai。
 * 顺序不可调换：根命令的 help 与 defaultCmdPriv.ai.args 都依赖 SubCmd.map 已填满。
 */
export function registerAllCmds(): void {
    registerCmdPrivilege();
    registerCmdPrompt();
    registerCmdPub();
    registerCmdStatus();
    registerCmdCtx();
    registerCmdCtxSet();
    registerCmdLive();
    registerCmdCtxn();
    registerCmdTimer();
    registerCmdOn();
    registerCmdStandby();
    registerCmdOff();
    registerCmdForget();
    registerCmdRole();
    registerCmdImage();
    registerCmdMemory();
    registerCmdTool();
    registerCmdSkill();
    registerCmdKb();
    registerCmdMcp();
    registerCmdIgnore();
    registerCmdToken();
    registerCmdStop();
    registerCmdModel();
    registerCmdBalance();
    registerCmdBlock();
    registerCmdSubAgent();
    registerCmdTts();
    registerCmdTti();
    registerCmdMedia();

    defaultCmdPriv.ai.args = Object.values(SubCmd.map).reduce((acc: CmdPriv, sc) => {
        acc[sc.name] = sc.priv;
        return acc;
    }, {});

    registerCmd();
}
