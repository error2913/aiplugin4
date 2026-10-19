// 后端服务地址：单一 JSON（v1），在 aiplugin4-backends 的 WebUI 点「复制后端配置」后粘贴。
//
// 不迁移、不兼容：旧的 8 个独立键（流式输出/图片转base64/图床/图床Token/媒体转base64/
// 用量图表/核心桥WS地址/核心桥Token）不再注册、也不再读取。
// 空文本 = 全部使用出厂默认地址（不报错）；校验失败整份拒绝并回退出厂默认。
import Logger from "../../logger";
import { ext } from "../config";
import { parseBackendConfig, resolveBackendEndpoints } from "../domain/backend";

import { BACKEND_CONFIG_HINT } from "./generator_hint";

export const BACKEND_CONFIG_KEY = '后端配置';

function readText(): string {
    try {
        return seal.ext.getStringConfig(ext, BACKEND_CONFIG_KEY) ?? '';
    } catch (e) {
        Logger.error(`读取配置项「${BACKEND_CONFIG_KEY}」失败: ${e instanceof Error ? e.message : String(e)}`);
        return '';
    }
}

function readEndpoints() {
    const text = readText();
    // 空文本：什么都不做，直接使用出厂默认地址（不报错）
    if (!text.trim()) return resolveBackendEndpoints(null);

    const result = parseBackendConfig(text);
    for (const warning of result.warnings) Logger.warning(`  ${warning.path} ${warning.msg}`);
    if (!result.config) {
        Logger.error(`「${BACKEND_CONFIG_KEY}」校验失败（共 ${result.issues.length} 处），本次按出厂默认地址处理：`);
        for (const item of result.issues) Logger.error(`  ${item.path} ${item.msg}`);
        Logger.error('提示：在 aiplugin4-backends 的 WebUI 点「复制后端配置」后整段粘贴。');
        return resolveBackendEndpoints(null);
    }
    return resolveBackendEndpoints(result.config);
}

export default class BackendConfig {
    static register() {
        seal.ext.registerStringConfig(ext, BACKEND_CONFIG_KEY, '', BACKEND_CONFIG_HINT, "后端");
    }

    static get() {
        const endpoints = readEndpoints();
        return {
            STREAM: endpoints['stream-output'].url,
            STREAM_TOKEN: endpoints['stream-output'].token,
            IMAGE_TO_BASE64: endpoints['image-url-to-base64'].url,
            IMAGE_TO_BASE64_TOKEN: endpoints['image-url-to-base64'].token,
            IMAGE_HOST: endpoints['image-host'].url,
            IMAGE_HOST_PUBLIC_URL: endpoints['image-host'].publicUrl || '',
            IMAGE_HOST_TOKEN: endpoints['image-host'].token,
            MEDIA_FETCH: endpoints['media-fetch'].url,
            MEDIA_FETCH_TOKEN: endpoints['media-fetch'].token,
            USAGE_CHART: endpoints['usage-chart'].url,
            USAGE_CHART_TOKEN: endpoints['usage-chart'].token,
            CORE_BRIDGE_WS_URL: endpoints['ob11-core-bridge'].url,
            CORE_BRIDGE_TOKEN: endpoints['ob11-core-bridge'].token,
        }
    }
}
