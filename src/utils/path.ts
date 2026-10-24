// 本地路径解析（叶子模块）：相对路径按海豹核心目录拼绝对路径，file:// 与 URI 特殊处理。
import Config from "../config/config";
/** 判断字符串是否为 URI（Windows 盘符 C:\\foo 不算 URI）。 */
function hasUriScheme(value: string): boolean {
    return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) && !/^[a-zA-Z]:[\\/]/.test(value);
}

/** 将 file:// URI 转回当前进程可使用的本地路径。 */
function fileUriToLocalPath(value: string): string {
    if (!/^file:\/\//i.test(value)) return value;

    const withoutScheme = value.replace(/^file:\/\//i, '');
    // file://server/share/file 是 UNC 路径；file:///C:/file 是 Windows 盘符路径。
    const slashValue = withoutScheme.replace(/\\/g, '/');
    try {
        const decoded = decodeURIComponent(slashValue);
        if (/^[^/]+\//.test(decoded) && !/^[a-zA-Z]:\//.test(decoded)) {
            return `\\\\${decoded.replace(/\//g, '\\')}`;
        }
        if (/^\/[a-zA-Z]:\//.test(decoded)) return decoded.slice(1).replace(/\//g, '\\');
        if (/^[a-zA-Z]:\//.test(decoded)) return decoded.replace(/\//g, '\\');
        return decoded.startsWith('/') ? decoded : `/${decoded}`;
    } catch (_e) {
        // URI 编码不合法时保留原字符串，避免发送工具因解析异常直接崩溃。
        return slashValue;
    }
}

/**
 * 规范化本地路径，但不依赖 Node 的 path/fs 模块（插件运行在海豹 JS 环境）。
 * 覆盖盘符、UNC、POSIX 绝对路径和相对 SealDice 路径，避免字符串拼接造成
 * 双分隔符、`.`/`..` 残留以及 UNC 路径被误判为相对路径。
 */
function normalizeLocalPath(value: string): string {
    const original = value;
    const slashValue = value.replace(/\\/g, '/');
    const windowsStyle = /^[a-zA-Z]:\//.test(slashValue) || slashValue.startsWith('//');
    let root = '';
    let rest = slashValue;

    const drive = slashValue.match(/^([a-zA-Z]:)\//);
    if (drive) {
        root = `${drive[1]}/`;
        rest = slashValue.slice(root.length);
    } else if (slashValue.startsWith('//')) {
        const uncParts = slashValue.slice(2).split('/').filter(Boolean);
        if (uncParts.length >= 2) {
            root = `//${uncParts[0]}/${uncParts[1]}/`;
            rest = uncParts.slice(2).join('/');
        } else {
            root = '//';
            rest = uncParts.join('/');
        }
    } else if (slashValue.startsWith('/')) {
        root = '/';
        rest = slashValue.slice(1);
    }

    const parts: string[] = [];
    for (const part of rest.split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') {
            if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop();
            else if (!root) parts.push(part);
            continue;
        }
        parts.push(part);
    }

    let normalized = `${root}${parts.join('/')}`;
    if (!normalized) normalized = root || (original ? '.' : '');
    if (windowsStyle) normalized = normalized.replace(/\//g, '\\');
    return normalized;
}

/**
 * 将资源配置/工具参数中的路径解析为 SealDice 进程可使用的路径。
 * 相对路径相对 Config.base.SEALDICE_PATH；mcp://、http:// 等远端 URI 不应被
 * 拼接到 SealDice 目录，原样交给上层的资源桥处理。
 */
export function resolveLocalPath(p: string): string {
    const value = String(p || '').trim();
    if (!value) return value;
    if (/^file:\/\//i.test(value)) return normalizeLocalPath(fileUriToLocalPath(value));
    if (hasUriScheme(value)) return value;

    const normalized = normalizeLocalPath(value);
    const isAbsolute = /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(normalized);
    if (isAbsolute) return normalized;

    const { SEALDICE_PATH } = Config.base;
    if (!SEALDICE_PATH) return normalized;
    return normalizeLocalPath(`${String(SEALDICE_PATH).replace(/[\\/]$/, '')}/${normalized}`);
}
