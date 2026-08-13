# 图片用例（image）

权限：U=任意成员；I=邀请者/管理/群主/白名单/骰主；M=骰主。

| ID | 指令 | 权限 | 预期关键字 | 备注 |
|---|---|---|---|---|
| IMG-01 | `.ai img` | U | `帮助` | |
| IMG-02 | `.ai img list lcl` | M | `暂无本地图片` 或 `本地图片` | 本地图片路径未配置可能报错 → SKIP(env) |
| IMG-03 | `.ai img itt` | M | `请附带图片` 或帮助文本 | 无图片错误路径 |
| IMG-04 | `.ai img itt [CQ:image,file=<公开图片URL>]` | M | `CQ:image` | 依赖「图片模型」配置（use=image-understanding）；未配置则 SKIP(env) |
| IMG-05 | `.ai img find` | I | `查找图片` | 无参数错误路径 |
| IMG-06 | `.ai img find 不存在的ID` | I | `未找到该图片` | |

说明：

- 4.15.0 起已删除偷图功能（`.ai img list stl` / `.ai img stl` / 随机发图），不再测试。
- `itt` 的真实识别依赖「模型」页签的「图片模型」配置（use=image-understanding）且「是否开启图片模型」开关打开；无配置时只测错误路径。
