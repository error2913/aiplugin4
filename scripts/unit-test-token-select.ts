// token 预算选择纯函数单测（方案 §11.5）：空 / 超长 / 最新必留 / budget<=0 / 估算单调 / 顺序稳定。
import assert from 'node:assert/strict';

import { selectByTokenBudget } from '../src/utils/token_select';

export const tests: Record<string, () => void | Promise<void>> = {
    /** 空输入 / budget<=0 / 非法 budget → 空数组（0 = 不选，不是「无限」） */
    testTokenSelectEmptyAndZeroBudget() {
        assert.deepEqual(selectByTokenBudget([], () => 1, 100), []);
        assert.deepEqual(selectByTokenBudget(['a', 'b'], () => 1, 0), [], 'budget=0 应返回空');
        assert.deepEqual(selectByTokenBudget(['a', 'b'], () => 1, -5), [], '负预算应返回空');
        assert.deepEqual(selectByTokenBudget(['a', 'b'], () => 1, Number.NaN), [], 'NaN 预算按 0 处理');
        assert.deepEqual(selectByTokenBudget(['a', 'b'], () => 1, Number.POSITIVE_INFINITY), [], 'Infinity 不是有限值，按 0 处理');
    },

    /** 顺序稳定：入参按时间升序（旧→新），返回值必须保持升序，不能因内部倒序选择而反转 */
    testTokenSelectKeepsAscendingOrder() {
        const items = ['旧1', '旧2', '新3'];
        assert.deepEqual(selectByTokenBudget(items, () => 1, 100), items);
        assert.deepEqual(selectByTokenBudget(items, item => item.length, 100), items);
    },

    /** 从最新往前累加：装不下的条目处即停，不跳过它去选更旧的 */
    testTokenSelectAccumulatesFromNewest() {
        const items = ['a', 'b', 'c', 'd'];
        // 每条 10 token：budget 25 → 选 d(10)+c(20)，b 装不下即停（不回头选 a）
        assert.deepEqual(selectByTokenBudget(items, () => 10, 25), ['c', 'd']);
        assert.deepEqual(selectByTokenBudget(items, () => 10, 20), ['c', 'd'], '恰好装下两条');
        assert.deepEqual(selectByTokenBudget(items, () => 10, 19), ['d'], '装不下第二条时只留最新');
        assert.deepEqual(selectByTokenBudget(items, () => 10, 10), ['d']);
    },

    /** 超长条目：默认最新必留；显式 alwaysKeepLatest=false 时严格按预算（可返回空） */
    testTokenSelectOversizedLatest() {
        const items = ['old-small', 'new-huge'];
        const estimate = (item: string): number => (item === 'new-huge' ? 1000 : 1);
        assert.deepEqual(selectByTokenBudget(items, estimate, 10), ['new-huge'], '最新一条自身超预算时默认仍保留');
        assert.deepEqual(
            selectByTokenBudget(items, estimate, 10, { alwaysKeepLatest: false }),
            [],
            '严格预算（alwaysKeepLatest=false）时最新超预算应返回空',
        );
        // 最新装得下、次新超预算：只保留最新，不跳过次新去选更旧的
        const second = ['oldest', 'new-medium', 'new-small'];
        const estimateSecond = (item: string): number => (item === 'new-medium' ? 1000 : 1);
        assert.deepEqual(selectByTokenBudget(second, estimateSecond, 10), ['new-small']);
    },

    /** 估算器防呆：抛异常 / 非数值 / 负数 → 该条按 0 计；估算器非函数 → 全部按 0 计 */
    testTokenSelectEstimatorDefensive() {
        const throwing = (): number => { throw new Error('estimator boom'); };
        assert.deepEqual(selectByTokenBudget(['a', 'b'], throwing, 1), ['a', 'b'], '估算器抛错按 0，不影响选择');
        assert.deepEqual(selectByTokenBudget(['a', 'b'], () => Number.NaN, 1), ['a', 'b'], 'NaN 按 0');
        assert.deepEqual(selectByTokenBudget(['a', 'b'], () => -1, 1), ['a', 'b'], '负数按 0');
        // 非函数估算器（调用方漏传）也按 0 防呆，不抛异常
        assert.deepEqual(selectByTokenBudget(['a', 'b'], undefined as unknown as (item: string) => number, 1), ['a', 'b']);
    },

    /** 估算单调：预算增大 → 选中条数不减少，且更大预算的结果包含更小预算的结果 */
    testTokenSelectBudgetMonotonic() {
        const items = Array.from({ length: 20 }, (_, i) => i);
        const estimate = (i: number): number => (i % 5) + 1;   // 1..5
        let previous: number[] = [];
        for (let budget = 0; budget <= 80; budget += 3) {
            const picked = selectByTokenBudget(items, estimate, budget);
            assert.ok(picked.length >= previous.length, `预算 ${budget} 不应比更小预算选得少`);
            for (const value of previous) {
                assert.ok(picked.includes(value), `预算 ${budget} 应包含更小预算已选的 ${value}`);
            }
            const sorted = picked.slice().sort((a, b) => a - b);
            assert.deepEqual(picked, sorted, '结果必须保持升序');
            if (picked.length > 1) {
                assert.ok(picked.reduce((sum, value) => sum + estimate(value), 0) <= budget, '多条时总量不应超预算');
            }
            previous = picked;
        }
    },

    /** from 选项：目前只支持 'newest'；缺省/显式值行为一致 */
    testTokenSelectFromOption() {
        const items = ['a', 'b'];
        assert.deepEqual(selectByTokenBudget(items, () => 1, 10, { from: 'newest' }), ['a', 'b']);
        assert.deepEqual(selectByTokenBudget(items, () => 1, 10, {}), ['a', 'b']);
    },
};
