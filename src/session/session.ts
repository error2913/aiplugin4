import { Context } from "./context";
import { User } from "./user";

export class State {
    isPrivate: boolean;
    group: {
        groupId: string;
        groupName: string;
        owner: string;
        adminList: string[];
        memberList: string[];
        description: string; // 自定义描述
        impression: string; // ai可修改的印象
    }
    user: {
        userId: string;
        userName: string;
        description: string; // 自定义描述
        impression: string; // ai可修改的印象
    }
    tool: {}
    [key: string]: any;
}

export class Session {
    sessionId: string;
    state: { //储存状态信息
        groupId: string;
        userIdArray: string[];
        [key: string]: any;
    }
    context: Context;
    memory: Memory;
    image;
}

export class SessionService {
    sessionMap: { [key: string]: Session };
    userMap: { [key: string]: User };

    constructor() {

    }
}