# 图片用例（image）

权限：U=任意成员；I=邀请者/管理/群主/白名单/骰主；M=骰主。

| ID | 指令 | 权限 | 预期关键字 | 备注 |
|---|---|---|---|---|
| IMG-01 | `.ai img` | U | `帮助` | |
| IMG-02 | `.ai img list stl` | U | `暂无偷取图片` 或 `偷取图片` | |
| IMG-03 | `.ai img list lcl` | M | `暂无本地图片` 或 `本地图片` | 本地图片路径未配置可能报错 → SKIP(env) |
| IMG-04 | `.ai img stl` | I | `图片偷取状态` | 快照：记录偷图开关与数量 |
| IMG-05 | `.ai img stl on` | I | `图片偷取已开启` | |
| IMG-06 | `.ai img stl off` | I | `图片偷取已关闭` | |
| IMG-07 | `.ai img stl f` | I | `偷取图片已遗忘` | 自清理 |
| IMG-08 | `.ai img itt ran` | M | `请附带图片` | 源码中 `ran` 未特殊处理，走无图片错误路径 |
| IMG-09 | `.ai img itt [CQ:image,file=<公开图片URL>]` | M | `CQ:image` | 依赖视觉模型配置；未配置则 SKIP(env) |
| IMG-10 | `.ai img find` | I | `查找图片` | 无参数错误路径 |
| IMG-11 | `.ai img find 不存在的ID` | I | `未找到该图片` | |

说明：

- 偷图闭环（开偷图 → 群内发图 → `list stl` 计数增加）依赖"是否接收图片"配置与 ob11 连接，环境满足时可加测。
- `itt` 的真实识别依赖"图片大模型URL"配置；无配置时只测错误路径。
- IMG-04~07 结束后按快照恢复偷图开关状态。
