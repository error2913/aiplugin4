// 群档案：存储与读取
import { ext } from "../config/config";
import Logger from "../logger";
import { revive, TypeDescriptor } from "../utils/utils";
export default class Group {
    static validKeysMap: { [key in keyof Group]?: TypeDescriptor<Group[key]> } = {
        groupId: 'string',
        groupName: 'string',
        role: 'string',
        owner: 'string',
        adminList: { array: 'string' },
        memberList: { array: 'string' },
        ignoredUserIdList: { array: 'string' }
    }
    groupId: string;
    groupName: string;
    role: 'owner' | 'admin' | 'member'; // 自己的角色
    owner: string; // 群主id
    adminList: string[]; // 管理员id列表
    memberList: string[]; // 普通成员id列表
    ignoredUserIdList: string[];
    constructor() {
        this.groupId = '';
        this.groupName = '';
        this.role = 'member';
        this.owner = '';
        this.adminList = [];
        this.memberList = [];
        this.ignoredUserIdList = [];
    }

    static groupMap: { [key: string]: Group } = {};

    static get(groupId: string): Group {
        if (!Object.prototype.hasOwnProperty.call(this.groupMap, groupId)) {
            let group = new Group();
            try {
                const data = JSON.parse(ext.storageGet(`group_${groupId}`) || '{}');
                group = revive(Group, data);
            } catch (error) {
                Logger.error(`加载群${groupId}失败: ${error}`);
            }
            group.groupId = groupId;
            this.groupMap[groupId] = group;
        }
        return this.groupMap[groupId];
    }
    static save(group: Group) {
        ext.storageSet(`group_${group.groupId}`, JSON.stringify(group));
    }
}
