/**
 * OB11 action 能力目录。
 *
 * native 表示没有 ob11 网络依赖时仍可由 SealDice 原生输出或上下文完成；
 * network 表示必须通过 ob11-net 执行；
 * either 表示优先走 ob11-net，没有依赖时交给 native handler。
 */
export type Ob11ActionCapability = "native" | "network" | "either";

const NATIVE_ACTIONS = new Set([
    "send_private_msg",
    "send_group_msg"
]);

const CONTEXT_ACTIONS = new Set([
    "get_login_info",
    "get_status",
    "get_version_info",
    "get_group_info",
    "get_group_member_info",
    "get_stranger_info"
]);

/** 这些动作需要通过远端协议读取历史、列表或管理状态。 */
const NETWORK_ACTIONS = new Set([
    "get_msg",
    "get_forward_msg",
    "get_friend_list",
    "get_group_list",
    "get_group_member_list",
    "get_group_msg_history",
    "get_friend_msg_history",
    "set_group_kick",
    "set_group_ban",
    "set_group_anonymous_ban",
    "set_group_whole_ban",
    "set_group_admin",
    "set_group_anonymous",
    "set_group_card",
    "set_group_name",
    "set_group_leave",
    "set_group_special_title",
    "set_friend_add_request",
    "set_group_add_request",
    "send_like",
    "set_essence_msg",
    "delete_essence_msg",
    "get_essence_msg_list",
    "send_group_sign",
    "set_group_sign",
    "get_group_shut_list",
    "upload_group_file",
    "upload_private_file",
    "get_group_file_url",
    "get_group_root_files",
    "get_group_files_by_folder",
    "create_group_file_folder",
    "delete_group_file",
    "delete_group_folder",
    "move_group_file",
    "rename_group_file",
    "get_private_file_url",
    "send_group_forward_msg",
    "send_private_forward_msg",
    "send_forward_msg",
    "delete_msg",
    "set_group_portrait",
    "set_qq_avatar",
    "set_qq_profile",
    "get_cookies",
    "get_csrf_token",
    "get_credentials",
    "get_record",
    "get_image",
    "can_send_image",
    "can_send_record",
    "set_restart",
    "clean_cache"
]);

export function getActionCapability(action: string): Ob11ActionCapability {
    if (NATIVE_ACTIONS.has(action)) return "either";
    if (CONTEXT_ACTIONS.has(action)) return "either";
    // 全部动作最终都走 network 透传：未列出的 action 也允许 ob11-net 原样转发给协议端，
    // 已安装依赖即可按端点能力执行；未安装依赖时由调用方返回 OB11_DEPENDENCY_REQUIRED，不能伪造结果。
    return "network";
}

export function isNativeAction(action: string): boolean {
    return NATIVE_ACTIONS.has(action) || CONTEXT_ACTIONS.has(action);
}

export function isNetworkAction(action: string): boolean {
    return getActionCapability(action) === "network";
}

export const OB11_CORE_ACTIONS = [
    ...Array.from(NATIVE_ACTIONS),
    ...Array.from(CONTEXT_ACTIONS),
    ...Array.from(NETWORK_ACTIONS)
];
