// 正则类配置：启动解析一次、重载 JS 才生效（模块级缓存）。
// 放在叶子模块中，供 configs/* 直接引用，避免它们为了一个解析函数反向依赖 config/config。
import Logger from "../logger";

const regexConfigCache: { [key: string]: RegExp } = {};

export function getRegexConfig(ext: seal.ExtInfo, key: string): RegExp {
    if (regexConfigCache[key]) return regexConfigCache[key];
    const patterns = seal.ext.getTemplateConfig(ext, key).filter(x => x);
    const pattern = patterns.join('|');
    let regex: RegExp;
    if (pattern) {
        try {
            regex = new RegExp(pattern);
        } catch (e) {
            Logger.error(`正则表达式错误，内容:${pattern}，错误信息:${e instanceof Error ? e.message : String(e)}`);
            regex = /(?!)/;
        }
    } else {
        regex = /(?!)/;
    }
    regexConfigCache[key] = regex;
    return regex;
}
