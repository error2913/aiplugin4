// 用户档案：存储与读取
import { getHost } from "../core/host";
import Logger from "../logger";
import { revive, TypeDescriptor } from "../utils/revive";

export default class User {
    static validKeysMap: { [key in keyof User]?: TypeDescriptor<User[key]> } = {
        userId: 'string',
        userName: 'string'
    }
    userId: string;
    userName: string;
    constructor() {
        this.userId = '';
        this.userName = '';
    }

    static userMap: { [key: string]: User } = {};

    static get(userId: string): User {
        if (!Object.prototype.hasOwnProperty.call(this.userMap, userId)) {
            let user = new User();
            try {
                const data = JSON.parse(getHost().storage.get(`user_${userId}`) || '{}');
                user = revive(User, data);
            } catch (error) {
                Logger.error(`加载用户${userId}失败: ${error}`);
            }
            user.userId = userId;
            this.userMap[userId] = user;
        }
        return this.userMap[userId];
    }
    static save(user: User) {
        getHost().storage.set(`user_${user.userId}`, JSON.stringify(user));
    }
}
