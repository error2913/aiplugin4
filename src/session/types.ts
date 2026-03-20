export interface State {
    description: string; // 自定义描述
    impression: string; // ai可修改的印象
    [key: string]: any;
}

export type SessionType = 'user' | 'group';