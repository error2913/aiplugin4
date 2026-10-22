// 模型上下文窗口探测缓存（P2-3）：把"上下文超长报错里解析出的窗口大小"按模型名持久化，
// 让结果跨会话/跨重启复用，而不是每次都要先撞一次超长报错才知道窗口有多大。
//
// 设计要点：
// - 单键 JSON（`modelContextWindows` = `{ [modelName]: windowTokens }`），与 usageMap 同样的做法：
//   海豹 storage 是叠加式，分多键反而多占空间，且这份数据整体很小。
// - **纯缓存**：读写失败一律按"没有"处理，绝不抛给调用方、绝不影响主流程。
// - 读写函数与纯计算（resolveEffectiveMaxTokens）分离在 api_error.ts，便于单元测试。
import { getHost } from "../core/host";
import { logger } from "../logger";

const MODEL_WINDOW_KEY = 'modelContextWindows';

function loadWindowCache(): { [model: string]: number } {
    try {
        const raw = getHost().storage.get(MODEL_WINDOW_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === 'object' ? parsed as { [model: string]: number } : {};
    } catch {
        // key 不存在时海豹会抛异常，属正常情况
        return {};
    }
}

/** 取已探测到的模型窗口（未探测过/无效返回 undefined） */
export function getProbedContextWindow(modelName: string): number | undefined {
    if (!modelName) return undefined;
    const n = loadWindowCache()[modelName];
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
}

/** 记录探测到的模型窗口（只写变化，避免每次报错都重写这份 JSON） */
export function rememberProbedContextWindow(modelName: string, windowTokens: number): void {
    if (!modelName || !Number.isFinite(windowTokens) || windowTokens <= 0) return;
    try {
        const cache = loadWindowCache();
        if (cache[modelName] === windowTokens) return;
        cache[modelName] = windowTokens;
        getHost().storage.set(MODEL_WINDOW_KEY, JSON.stringify(cache));
    } catch (e) {
        // 缓存写失败不影响主流程
        logger.warning('记录模型窗口缓存失败: ' + (e instanceof Error ? e.message : String(e)));
    }
}

/** 列出所有已探测到的模型窗口（`.ai ctx` 展示用） */
export function listProbedContextWindows(): { [model: string]: number } {
    return loadWindowCache();
}
