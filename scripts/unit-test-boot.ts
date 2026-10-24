// 启动装配回归测试入口（独立 bundle，不与 unit-test-entry 共享模块实例）。
// 目的：模拟 src/index.ts 的 main() 首段真实顺序（test-host 注入宿主/钩子 → Config.registerConfig()），
// 断言「配置注册完成后模型配置应用钩子必须已执行、Model 注册表非空」。
// 背景：Phase 2b 把配置解析与应用拆开后，预热路径若绕过 getCache 就会导致 Model 为空（首条消息失败），
// 而既有单测都在用例里手动 Model.bootstrap/手动读 Config.model，掩盖过该 P0。
import assert from "node:assert/strict";

import "./test-host";

import Config from "../src/config/config";
import Model from "../src/model/model";

export const tests: Record<string, () => void | Promise<void>> = {
    /** 只按生产装配顺序：注册配置后 Model 必须有可用模型（预热 → 缓存访问器 → 配置应用钩子 → Model.bootstrap） */
    testRegisterConfigWarmsModelRegistry(): void {
        Config.registerConfig();
        const chatModels = Model.listModelsForUse('chat');
        assert.ok(
            chatModels.length > 0,
            'Config.registerConfig() 后 Model.chat 模型列表不应为空：模型配置应用钩子没有被触发（预热必须走 getCache）'
        );
    },
};
