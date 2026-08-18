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
