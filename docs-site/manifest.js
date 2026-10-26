// 文档清单单一事实源：docs-site/build-site-src.js 与 check-manifest.js 共用。
// 新增 / 删除文档时必须同步本清单（CI 的 docs:manifest 会校验与磁盘一致，并核对 mkdocs nav）。
// 说明：
// - KB_FILES：docs/<name>.md → 站点 kb/<name>.md（开发者知识库）
// - REF_FILES：ccdocs/<name>.md → 站点 reference/<name>.md（第三方参考存档）
// - guide 用户手册固定为仓库根 README.md，无需登记
const KB_FILES = [
  '01-项目概览',
  '02-架构设计',
  '03-核心模块详解',
  '04-工具系统',
  '05-命令与配置',
  '06-数据存储',
  '07-开发指南',
  '08-相关后端项目',
  '09-注意事项与常见问题',
  '10-TODO',
  '11-ob11-core-bridge-使用指南',
  '12-配置JSON化方案',
  '13-记忆系统',
  '16-图片生命周期与图床方案',
  '17-图片引用标准与AI图库交互方案',
  '18-系统提示词重构与英文化方案',
];

const REF_FILES = [
  'amazon-bedrock',
  'google-vertex-ai',
  'hooks',
  'mcp',
  'settings-reference',
  'third-party-integrations',
];

module.exports = { KB_FILES, REF_FILES };
