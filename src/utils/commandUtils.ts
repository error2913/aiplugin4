import { Config } from "./configUtils";

export class Command {
    static cmdArgs: seal.CmdArgs = null;

    static HandleCommands(ctx: seal.MsgContext, msg: seal.Message, commands: string[]) {
        if (commands.length !== 0) {
            Config.printLog(`AI命令:`, JSON.stringify(commands));
        }

        if (this.cmdArgs == null) {
            Config.printLog(`暂时无法使用AI命令，请先使用任意指令`);
        }

        if (commands.length > 10) {
            console.error(`AI命令数量过多，请限制在10个以内`);
            return;
        }

        const commandMap = commands.reduce((acc: { [key: string]: string }, item: string) => {
            const match = item.match(/(.+)#.*/);
            if (match !== null) {
                const key = match[1];
                acc[key] = item.replace(/.*#/, '');
            } else {
                acc[item] = '';
            }
            return acc;
        }, {})

        for (const cmd of Object.keys(commandMap)) {
            const arg = commandMap[cmd];
            switch (cmd) {
                case 'deck': {
                    this.draw(ctx, msg, arg);
                    break;
                }
                case 'rename': {
                    this.setGroupCard(ctx, msg, arg);
                    break;
                }
                case '随机模组': {
                    this.modu_roll(ctx, msg);
                    break;
                }
                case '查询模组': {
                    this.modu_search(ctx, msg, arg);
                    break;
                }
                case '检定': {
                    this.ra(ctx, msg, arg);
                    break;
                }
                case 'show': {
                    this.st_show(ctx, msg);
                    break;
                }
                case '今日人品': {
                    this.jrrp(ctx, msg);
                    break;
                }
                case 'face': {
                    this.face(ctx, msg, arg);
                    break;
                }
                default: {
                    console.error(`AI命令${cmd}不存在`);
                    break;
                }
            }
        }
    }

    static draw(ctx: seal.MsgContext, msg: seal.Message, name: string) {
        const dr = seal.deck.draw(ctx, name, true);
        if (!dr.exists) {
            console.error(`牌堆${name}不存在:${dr.err}`);
        }

        const result = dr.result;
        if (result == null) {
            console.error(`牌堆${name}结果为空:${dr.err}`);
        }

        seal.replyToSender(ctx, msg, result);
    }

    static setGroupCard(ctx: seal.MsgContext, msg: seal.Message, name: string) {
        try {
            seal.setPlayerGroupCard(ctx, name);
            seal.replyToSender(ctx, msg, `已将<${ctx.player.name}>的群名片设置为<${name}>`);
        } catch (e) {
            console.error(e);
        }
    }

    static modu_roll(ctx: seal.MsgContext, msg: seal.Message) {
        this.cmdArgs.command = 'modu';
        this.cmdArgs.args = ['roll'];
        this.cmdArgs.kwargs = [];
        this.cmdArgs.at = [];
        this.cmdArgs.rawArgs = 'roll';
        this.cmdArgs.amIBeMentioned = false;
        this.cmdArgs.amIBeMentionedFirst = false;
        this.cmdArgs.cleanArgs = 'roll';

        const ext = seal.ext.find('story');
        ext.cmdMap['modu'].solve(ctx, msg, this.cmdArgs);
    }

    static modu_search(ctx: seal.MsgContext, msg: seal.Message, name: string) {
        this.cmdArgs.command = 'modu';
        this.cmdArgs.args = ['search', name];
        this.cmdArgs.kwargs = [];
        this.cmdArgs.at = [];
        this.cmdArgs.rawArgs = `search ${name}`;
        this.cmdArgs.amIBeMentioned = false;
        this.cmdArgs.amIBeMentionedFirst = false;
        this.cmdArgs.cleanArgs = `search ${name}`;

        const ext = seal.ext.find('story');
        ext.cmdMap['modu'].solve(ctx, msg, this.cmdArgs);
    }

    static ra(ctx: seal.MsgContext, msg: seal.Message, name: string) {
        this.cmdArgs.command = 'ra';
        this.cmdArgs.args = [name];
        this.cmdArgs.kwargs = [];
        this.cmdArgs.at = [];
        this.cmdArgs.rawArgs = name;
        this.cmdArgs.amIBeMentioned = false;
        this.cmdArgs.amIBeMentionedFirst = false;
        this.cmdArgs.cleanArgs = name;

        const ext = seal.ext.find('coc7');
        ext.cmdMap['ra'].solve(ctx, msg, this.cmdArgs);
    }

    static st_show(ctx: seal.MsgContext, msg: seal.Message) {
        this.cmdArgs.command = 'st';
        this.cmdArgs.args = ['show'];
        this.cmdArgs.kwargs = [];
        this.cmdArgs.at = [];
        this.cmdArgs.rawArgs = 'show';
        this.cmdArgs.amIBeMentioned = false;
        this.cmdArgs.amIBeMentionedFirst = false;
        this.cmdArgs.cleanArgs = 'show';

        const ext = seal.ext.find('coc7');
        ext.cmdMap['st'].solve(ctx, msg, this.cmdArgs);
    }

    static jrrp(ctx: seal.MsgContext, msg: seal.Message) {
        this.cmdArgs.command = 'jrrp';
        this.cmdArgs.args = [];
        this.cmdArgs.kwargs = [];
        this.cmdArgs.at = [];
        this.cmdArgs.rawArgs = '';
        this.cmdArgs.amIBeMentioned = false;
        this.cmdArgs.amIBeMentionedFirst = false;
        this.cmdArgs.cleanArgs = '';

        const ext = seal.ext.find('fun');
        ext.cmdMap['jrrp'].solve(ctx, msg, this.cmdArgs);
    }

    static face(ctx: seal.MsgContext, msg: seal.Message, name: string) {
        const { localImages } = Config.getLocalImageConfig();
        if (localImages.hasOwnProperty(name)) {
            seal.replyToSender(ctx, msg, `[CQ:image,file=${localImages[name]}]`);
        } else {
            console.error(`本地图片${name}不存在`);
        }
    }
}