import { logger } from "../logger";
import { updateInfo } from "../update";
import { ConfigManager, VERSION } from "../config/config";

/**
 * 比较两个版本号的大小。
 * @param {string} version1 - 第一个版本号，格式为 "x.y.z"。
 * @param {string} version2 - 第二个版本号，格式为 "x.y.z"。
 * @returns {number} - 如果 version1 大于 version2，返回 1；如果 version1 小于 version2，返回 -1；如果两个版本号相等，返回 0。
 * @throws {Error} - 如果版本号格式不正确，抛出错误。
 */
export function compareVersions(version1: string, version2: string): number {
    const v1 = version1.split('.').map(Number).filter(part => !isNaN(part));
    const v2 = version2.split('.').map(Number).filter(part => !isNaN(part));

    if (v1.length !== 3 || v2.length !== 3) {
        throw new Error('Invalid version format');
    }

    for (let i = 0; i < 3; i++) {
        if (v1[i] > v2[i]) {
            return 1;
        }
        if (v1[i] < v2[i]) {
            return -1;
        }
    }

    return 0;
}

export function checkUpdate() {
    const oldVersion = ConfigManager.ext.storageGet("version") || "0.0.0";

    try {
        if (compareVersions(oldVersion, VERSION) < 0) {
            ConfigManager.ext.storageSet("version", VERSION);
            let info = [];
            for (const v in updateInfo) {
                if (compareVersions(oldVersion, v) >= 0) {
                    break;
                }
                info.unshift(`${v}：\n${updateInfo[v]}`);
            }
            logger.warning(`更新到${VERSION}版本，更新内容：\n\n${info.join("\n\n")}`);
        }
    } catch (error) {
        logger.error(`版本校验失败：${error}`);
    }
}