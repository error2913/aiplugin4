// JSON 工具：宽松解析（尾逗号）与「模型输出 JSON 修复」。
// 叶子模块：只依赖 logger，供工具执行器 / 配置层直接引用（避免经 utils/string 拉进依赖环）。
import Logger from "../logger";

const log = Logger.withTag('string');

/** 解析配置 JSON，并兼容常见 JSONC 配置中的对象/数组尾逗号。 */
export function parseJSONWithTrailingCommas(text: string): any {
    try {
        return JSON.parse(text);
    } catch (firstError) {
        const normalized = removeTrailingCommas(text);
        if (normalized === text) throw firstError;
        return JSON.parse(normalized);
    }
}

function removeTrailingCommas(text: string): string {
    let result = '';
    let inString = false;
    let escaped = false;

    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (inString) {
            result += char;
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }

        if (char === '"') {
            inString = true;
            result += char;
            continue;
        }

        if (char === ',') {
            let next = i + 1;
            while (next < text.length && /\s/.test(text[next])) next++;
            if (text[next] === '}' || text[next] === ']') continue;
        }
        result += char;
    }
    return result;
}


/**
 * 修复json字符串，将其中缺少前半双引号的字符串添加前半双引号，修复失败返回空字符串
 * @param s
 * @returns
 */
export function fixJsonString(s: string): string {
    try {
        JSON.parse(s);
        return s;
    } catch (_err) {
        const patterns = [
            // 匹配键缺少前半引号: {key": 或 ,key":
            /([{,][\s\n]*)([a-zA-Z_$][a-zA-Z0-9_$]*)("[\s\n]*:)/g,
            // 匹配值缺少前半引号: :value", 或 :value"} 或
            /(:[\s\n]*)([^"]+)("[\s\n]*[,}])/g,
            // 匹配数组中的字符串缺少前半引号: [value", 或 [value"] 或 ,value", 或 ,value"]
            /([\[,][\s\n]*)([^"]+)("[\s\n]*[,\]])/g
        ];

        let fixed = s;
        let matched = false;

        for (const pattern of patterns) {
            fixed = fixed.replace(pattern, (fullMatch, prefix, content, suffix) => {
                matched = true;
                const fixedContent = `${prefix}"${content}${suffix}`;
                log.info(`修复json字符串: ${fullMatch} -> ${fixedContent}`);
                return fixedContent;
            });

            if (matched) {
                try {
                    JSON.parse(fixed);
                    return fixed;
                } catch (_err) {
                    matched = false;
                    continue;
                }
            }
        }

        if (!matched) {
            return "";
        }

        return fixed;
    }
}

