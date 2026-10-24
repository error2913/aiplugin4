// 短随机 ID 生成（叶子模块）。
export function generateId() {
    const timestamp = Date.now().toString(36); // 将时间戳转换为36进制字符串
    const random = Math.random().toString(36).substring(2, 6); // 随机数部分
    return (timestamp + random).slice(-6); // 截取最后6位
}
