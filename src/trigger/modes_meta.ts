// 单触发模式视图（L2）：只是 config/static_config/trigger_meta 的再导出门面，禁止在这里定义第二份数据。
//
// 消费方：trigger/index、cmd/sub_cmd/trg_modes、status/help 生成。保留本文件是为了让
// 「触发域」内部只依赖 trigger/ 目录，而不是散落各处 import config/static_config。
export {
    DEFAULT_ON_MODES,
    MODES,
    MODE_TOKENS,
    TRIGGER_CONFIG_KEYS,
    isModeOrderAlphabetical,
    modeByToken,
    triggerConfigName,
} from "../config/static_config/trigger_meta";
export type { ModeMeta, ModeToken, TriggerConfigKey, TriggerConfigKeyMeta } from "../config/static_config/trigger_meta";
