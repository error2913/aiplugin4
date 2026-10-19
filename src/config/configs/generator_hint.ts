/** 配置生成器统一提示文案：所有可由 aiplugin4-config 生成的配置项共用，避免各写各的。 */
export const GENERATOR_CONFIG_HINT =
    '推荐用配置生成器生成后粘贴：https://error2913.github.io/aiplugin4-config/　修改后需重载 JS 生效。';

/** 后端配置由 aiplugin4-backends 启动器生成，不走 aiplugin4-config。 */
export const BACKEND_CONFIG_HINT =
    '在 aiplugin4-backends 的 WebUI 点「复制后端配置」生成后粘贴（已设置的各后端 token 会一并带出，请勿公开分享；设/改 token 后需重启该后端再重新复制）；修改后约 60 秒生效。';
