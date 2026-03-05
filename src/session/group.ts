import { ConfigManager } from "../config/configManager";
import { logger } from "../logger";
import { revive, TypeDescriptor } from "../utils/utils";
import { MemoryService } from "./memory";
import { State } from "./session";

export class Group {
    static validKeysMap: { [key in keyof Group]?: TypeDescriptor<Group[key]> } = {
        groupId: 'string',
        groupName: 'string',
        owner: 'string',
        adminList: { array: 'string' },
        memberList: { array: 'string' },
        description: 'string',
        impression: 'string',
        state: 'any',
        memory: MemoryService
    }
    groupId: string;
    groupName: string;
    owner: string;
    adminList: string[];
    memberList: string[];
    description: string; // 自定义描述
    impression: string; // ai可修改的印象

    state: State; //储存状态信息
    memory: MemoryService;
}

export class GroupManager {
    static groupMap: { [key: string]: Group };

    static getGroup(groupId: string): Group {
        if (!this.groupMap.hasOwnProperty(groupId)) {
            let group = new Group();
            try {
                const data = JSON.parse(ConfigManager.ext.storageGet(`group_${groupId}`) || '{}');
                group = revive(Group, data);
            } catch (error) {
                logger.error(`加载群${groupId}失败: ${error}`);
            }
            this.groupMap[groupId] = group;
        }
        return this.groupMap[groupId];
    }
}
