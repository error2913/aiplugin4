// Context v2 配置语义单测：默认值/范围校验/中文键映射/保留预算。
import assert from 'node:assert/strict';

import {
    DEFAULT_CONTEXT_V2_SETTINGS,
    normalizeContextV2Settings,
    retainedBudgetTokens,
    settingsFromConfigValues,
} from '../src/context/config';

export const tests: Record<string, () => void | Promise<void>> = {
    testContextConfigDefaults() {
        const normalized = normalizeContextV2Settings({});
        assert.deepEqual(normalized.settings, DEFAULT_CONTEXT_V2_SETTINGS);
        assert.deepEqual(normalized.warnings, []);
        assert.equal(normalized.settings.summaryWatermarkTokens, 6000);
        assert.equal(normalized.settings.retainPercent, 40);
        assert.equal(normalized.settings.retainDays, 0);
    },

    testContextConfigChineseKeys() {
        const { settings, warnings } = settingsFromConfigValues({
            '上下文预算': 128000,
            '保留强度': 30,
            '摘要水位': 8000,
            '原文保留天数': 0,
            '待机入库配额': 20,
            '每小时后台压缩上限': 3,
            '原文保留页数上限': 100,
        });
        assert.equal(warnings.length, 0);
        assert.equal(settings.budgetTokens, 128000);
        assert.equal(settings.retainPercent, 30);
        assert.equal(settings.summaryWatermarkTokens, 8000);
        assert.equal(settings.standbyIngestQuota, 20);
        assert.equal(settings.hourlyCompactCap, 3);
        assert.equal(settings.maxRetainedPages, 100);
    },

    testContextConfigClampsAndWarns() {
        const { settings, warnings } = normalizeContextV2Settings({
            budgetTokens: -1,
            retainPercent: 0,
            summaryWatermarkTokens: -5,
            retainDays: -2,
            standbyIngestQuota: -3,
            hourlyCompactCap: -4,
            maxRetainedPages: -5,
        });
        assert.equal(settings.budgetTokens, 0);
        assert.equal(settings.retainPercent, 40);
        assert.equal(settings.summaryWatermarkTokens, 0);
        assert.equal(settings.retainDays, 0);
        assert.equal(settings.standbyIngestQuota, 0);
        assert.equal(settings.hourlyCompactCap, 0);
        assert.equal(settings.maxRetainedPages, 0);
        assert.equal(warnings.length, 7);
        const tooHigh = normalizeContextV2Settings({ retainPercent: 150 });
        assert.equal(tooHigh.settings.retainPercent, 40);
        assert.ok(tooHigh.warnings.length > 0);
    },

    testContextConfigRetainedBudget() {
        const s = normalizeContextV2Settings({ retainPercent: 40 }).settings;
        assert.equal(retainedBudgetTokens(s, 10000), 4000);
        assert.equal(retainedBudgetTokens(s, 0), 0);
        assert.equal(retainedBudgetTokens(s, 1), 1);
        const high = normalizeContextV2Settings({ retainPercent: 100 }).settings;
        assert.equal(retainedBudgetTokens(high, 5000), 5000);
    },
};
