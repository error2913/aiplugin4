import { U } from "../privilege";
import { SubCmd, SubCmdContext } from "../root";

export function registerCmdSample() {
    const cmd = new SubCmd('sample');
    cmd.help = '';
    cmd.priv = { priv: U };
    cmd.solve = (scc: SubCmdContext) => {
        const { ctx, msg, cmdArgs, epId, uid, gid, sid, ai, page, ret } = scc;
        ctx; msg; cmdArgs; epId; uid; gid; sid; ai; page; ret;
        return ret;
    }
}
