// 会话/用户/群类型定义
export interface State {
    description: string; // 自定义描述
    impression: string; // ai可修改的印象
    [key: string]: any;
}

export type SessionType = 'user' | 'group';
export interface GroupInfo {
    isPrivate: false;
    id: string;
    name: string;
}

export interface UserInfo {
    isPrivate: true;
    id: string;
    name: string;
}

export type SessionInfo = GroupInfo | UserInfo;
