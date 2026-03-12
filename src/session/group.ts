import { Config } from "../config/config";
import { logger } from "../logger";
import { revive, TypeDescriptor } from "../utils/utils";
export default class Group {
    static validKeysMap: { [key in keyof Group]?: TypeDescriptor<Group[key]> } = {
        groupId: 'string',
        groupName: 'string',
        role: 'string',
        owner: 'string',
        adminList: { array: 'string' },
        memberList: { array: 'string' }
    }
    groupId: string;
    groupName: string;
    role: 'owner' | 'admin' | 'member'; // 自己的角色
    owner: string; // 群主id
    adminList: string[]; // 管理员id列表
    memberList: string[]; // 普通成员id列表

    static groupMap: { [key: string]: Group };

    static get(groupId: string): Group {
        if (!this.groupMap.hasOwnProperty(groupId)) {
            let group = new Group();
            try {
                const data = JSON.parse(Config.ext.storageGet(`group_${groupId}`) || '{}');
                group = revive(Group, data);
            } catch (error) {
                logger.error(`加载群${groupId}失败: ${error}`);
            }
            group.groupId = groupId;
            this.groupMap[groupId] = group;
        }
        return this.groupMap[groupId];
    }
    static save(group: Group) {
        Config.ext.storageSet(`group_${group.groupId}`, JSON.stringify(group));
    }
}
