import { Config } from "../config/config";
import { logger } from "../logger";
import { revive, TypeDescriptor } from "../utils/utils";
import { MemoryService } from "./memory";
import { State } from "./session";

export default class User {
    static validKeysMap: { [key in keyof User]?: TypeDescriptor<User[key]> } = {
        userId: 'string',
        userName: 'string',
        description: 'string',
        impression: 'string',
        state: 'any',
        memory: MemoryService
    }
    userId: string;
    userName: string;
    description: string;
    impression: string; // ai可修改的印象

    state: State; //储存状态信息
    memory: MemoryService;


    static userMap: { [key: string]: User };

    static get(userId: string): User {
        if (!this.userMap.hasOwnProperty(userId)) {
            let user = new User();
            try {
                const data = JSON.parse(Config.ext.storageGet(`user_${userId}`) || '{}');
                user = revive(User, data);
            } catch (error) {
                logger.error(`加载用户${userId}失败: ${error}`);
            }
            user.userId = userId;
            this.userMap[userId] = user;
        }
        return this.userMap[userId];
    }
    static save(user: User) {
        Config.ext.storageSet(`user_${user.userId}`, JSON.stringify(user));
    }
}