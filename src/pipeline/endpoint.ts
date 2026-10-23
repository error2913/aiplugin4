// 通信端点解析（叶子）：按机器人自身 ID 反查匹配端点。
// 从 pipeline.ts 拆出，供事件分发（pipeline/events）与管线共用，避免 events ↔ pipeline 循环依赖。
/** 按机器人自身 ID 反查匹配的通信端点；匹配不到返回空串（调用方跳过）。
 *  双连接冗余下同一 QQ 可能有直连与桥两个端点：优先返回已连接（state=1）的端点，
 *  全部不在线时回退到第一个匹配端点。 */
export function resolveEndpointId(selfId: string | number): string {
    const suffix = `:${selfId}`;
    const eps = seal.getEndPoints();
    let fallback = '';
    for (const ep of eps) {
        if (!ep.userId.endsWith(suffix)) continue;
        if (ep.state === 1) return ep.userId;
        if (!fallback) fallback = ep.userId;
    }
    return fallback;
}
