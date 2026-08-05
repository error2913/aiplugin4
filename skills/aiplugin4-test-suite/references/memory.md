# 记忆用例（memory）

权限：U=任意成员；I=邀请者/管理/群主/白名单/骰主；S=骰主（会话权限≥1 时为邀请者）。

| ID | 指令 | 权限 | 预期关键字 | 备注 |
|---|---|---|---|---|
| MEM-01 | `.ai memo` | U | `帮助` | 帮助文本 |
| MEM-02 | `.ai memo status` | U | `长期记忆开启状态`、`短期记忆` | 快照命令 |
| MEM-03 | `.ai memo p st 测试设定` | U | `设定已修改` | 设置个人设定 |
| MEM-04 | `.ai memo p st clr` | U | `设定已清除` | 自清理 |
| MEM-05 | `.ai memo p st 一二三四五六七八九十一二三四五六七八九十一` | U | `设定过长，请控制在20字以内` | 21 字错误路径 |
| MEM-06 | `.ai memo p list` | U | `无记忆` 或 `记忆` | 清理后为空 |
| MEM-07 | `.ai memo p clr` | U | `个人记忆已清除` | 自清理 |
| MEM-08 | `.ai memo g st 测试群设定` | I | `设定已修改` | 群聊设定 |
| MEM-09 | `.ai memo g st clr` | I | `设定已清除` | 自清理 |
| MEM-10 | `.ai memo g list` | I | `无记忆` 或 `记忆` | |
| MEM-11 | `.ai memo g clr` | I | `群聊记忆已清除` | 自清理 |
| MEM-12 | `.ai memo short on` | S | `短期记忆已开启` | |
| MEM-13 | `.ai memo short off` | S | `短期记忆已关闭` | |
| MEM-14 | `.ai memo short list` | S | `短期记忆为空` 或 `当前页码` | |
| MEM-15 | `.ai memo short clr` | S | `短期记忆已清除` | 自清理 |
| MEM-16 | `.ai memo sum` | S | `当前页码` | 依赖 LLM 总结；报错则记 FAIL 并排查记忆配置 |
| MEM-17 | `.ai memo sum clr` | S | `总结记忆已清除` | 自清理 |
| MEM-18 | `.ai memo p del` | U | `参数缺失` | 无参数错误路径 |
| MEM-19 | `.ai memo g del` | I | `参数缺失` | 无参数错误路径 |
| MEM-20 | `.ai memo short` | S | `帮助` 或 `参数缺失` | 无参数错误路径 |

说明：

- 个人记忆按发送者（控制器 QQ）存储，群聊记忆按群存储；测试数据按用例顺序自清理。
- `memo p del`/`memo g del` 的真实删除需要先存在记忆条目（由 AI 通过 `add_memory` 工具产生），默认只测参数缺失错误路径。
- MEM-12~15 结束后恢复快照中的短期记忆开关状态。
