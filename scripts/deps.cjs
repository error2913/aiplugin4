// 完整包依赖插件清单（build-release.js 会读取本文件并下载到 sealpack-full/scripts/）
// url:      依赖插件 JS 的原始地址（raw 链接），支持 http/https
// filename: 打包后的文件名（可省略，默认取 URL 文件名，只保留 .js 后缀的合法文件名）
// name:     仅用于日志展示
//
// 示例（取消注释并按实际地址填写）：
// {
//   name: "ob11 网络连接依赖",
//   url: "https://raw.githubusercontent.com/owner/repo/main/ob11.js",
//   filename: "ob11.js"
// }
module.exports = {
  dependencies: []
};
