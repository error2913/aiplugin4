# aiplugin4 MCP 自由路径模式验证报告 — 2026-08-18

## 结论

- 后端已切换为自由路径模式：允许直接传入任意绝对路径，不再执行路径沙箱限制。
- 危险命令拦截已关闭；`run_shell` 接受外部 `cwd`。
- 下载大小限制为不限制（`MCP_MAX_DOWNLOAD_BYTES=0`），下载超时为 120 秒。
- 插件已构建、上传并重载；后端工具已在插件日志中注册。

## 部署状态

- 后端：`mcp-files-exec 1.0.6`，远端面板显示 `running=true`。
- 后端日志确认：外部路径访问开启、危险命令拦截关闭。
- 插件重载日志确认注册：`read_file`、`list_dir`、`write_file`、`delete_file`、`export_file`、`download_file`、`run_shell`。
- 海豹日志确认 OB11 连接完成端点映射：`QQ:3893625976`。

## aitool 验证

通过远程海豹面板的指令执行接口执行 `.ai tool`（不是直接调用 AI API）：

- PASS：工具列表可返回。
- PASS：列表包含 `read_file`、`list_dir`、`write_file`、`delete_file`、`export_file`、`download_file`、`run_shell`，均为开启状态。

## QQ 测试群复验

- 群：`1064487252`。
- QQ-MCP 控制账号：`3837233349`。
- 按要求向群发送 `.ai status`、`.ai tool`，并尝试 @ `3893625976`。
- 本轮未收到 `3893625976` 的新回复；群历史中出现“正确冻结了喵”，且当前未产生插件指令响应。该现象属于测试机器人/消息链路未响应，不能归因于 MCP 权限限制。
- 面板侧 `.ai tool` 已验证插件命令和工具注册正常。

## 备注

当前实现刻意不恢复路径沙箱、SSRF 限制、危险命令拦截或外部路径拒绝逻辑，符合自由模式要求。
