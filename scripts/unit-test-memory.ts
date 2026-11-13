// 单元测试入口（拆分自 scripts/unit-test-entry.ts）：memory 域，16 个用例。
// 用例顺序与拆分前一致；随 scripts/test-unit.cjs 打包后加载运行，不会启动 SealDice/QQ。
// @ts-nocheck
import {
    Agent, MAX_MENTAL_MODELS, MAX_OBSERVATIONS, OBSERVATION_STALE_DAYS,
    Session, SessionService, SubCmd, assert,
    buildNativeNoticeText, buildNoticeText, buildRequestText, createCtx,
    ext, getPlatform, isGroupId, isNoticeInWhitelist,
    makeGroupId, makeTestMentalModel, makeTestObservation, makeUserId,
    normalizeGroupId, normalizeTargetId, normalizeUserId, parseNoticeWhitelist,
    parseOccurredAt, platformOf, registerCmdOff, registerCmdStatus,
    registerContextEditTools, resolveEndpointId, selectInjectionCandidates, toolMap,
} from './unit-test-helpers';

export const tests: Record<string, () => void | Promise<void>> = {
/** E1/E2 注入候选筛选：scopeTags 全局放行/严格命中、stale 90 天剔除、观察 20 / 心智模型 5 上限按更新时间倒序 */
    testSelectInjectionCandidates(): void {
        const now = 1800000000000; // 固定 now（毫秒）
        const nowSec = Math.floor(now / 1000);
        const staleCutoff = nowSec - OBSERVATION_STALE_DAYS * 86400;
        const mkObs = (id: string, text: string, scopeTags: string[], updatedAt: number, lastVerifiedAt?: number) =>
            makeTestObservation(id, text, scopeTags, updatedAt, lastVerifiedAt);
        const mkMM = (id: string, question: string, answer: string, scopeTags: string[], updatedAt: number) =>
            makeTestMentalModel(id, question, answer, scopeTags, updatedAt);

        // scopeTags 过滤：空=全局放行；任一标签命中即注入；完全不命中才剔除（放宽 all_strict）
        const sel = selectInjectionCandidates(
            [mkMM('mm_other', '他人模型', 'C', ['user:QQ:2'], nowSec - 30), mkMM('mm_match', '命中模型', 'B', ['user:QQ:1'], nowSec - 20), mkMM('mm_global', '全局模型', 'A', [], nowSec - 10)],
            [mkObs('o_other', '他人观察', ['user:QQ:2'], nowSec - 30), mkObs('o_multi', '多标签观察', ['user:QQ:1', 'vis:public'], nowSec - 40), mkObs('o_match', '命中观察', ['user:QQ:1'], nowSec - 20), mkObs('o_global', '全局观察', [], nowSec - 10)],
            ['user:QQ:1'],
            now
        );
        assert.deepEqual(sel.observations.map(o => o.id).sort(), ['o_global', 'o_match', 'o_multi'], '任一 scopeTag 命中即注入，空 scopeTags 全局放行，完全不匹配剔除');
        assert.deepEqual(sel.mentalModels.map(m => m.id).sort(), ['mm_global', 'mm_match']);

        // stale 剔除：lastVerifiedAt 距今超过 90 天剔除；缺省 lastVerifiedAt 回退 updatedAt
        const sel2 = selectInjectionCandidates(
            [],
            [mkObs('o_stale', '过期观察', [], staleCutoff - 1, staleCutoff - 1), mkObs('o_fresh', '新鲜观察', [], staleCutoff + 1, staleCutoff + 1), mkObs('o_noverify', '无验证时间', [], staleCutoff + 1, undefined)],
            [],
            now
        );
        assert.deepEqual(sel2.observations.map(o => o.id), ['o_fresh', 'o_noverify'], '过期观察应剔除，缺验证时间按 updatedAt 判断');

        // 条数上限：观察最多 20、心智模型最多 5，按 updatedAt 倒序取最新
        const manyObs = [];
        for (let i = 0; i < 25; i++) manyObs.push(mkObs('o_' + i, '观察' + i, [], nowSec - 1000 + i * 10));
        const manyMM = [];
        for (let i = 0; i < 8; i++) manyMM.push(mkMM('mm_' + i, '问题' + i, '答案' + i, [], nowSec - 100 + i));
        const sel4 = selectInjectionCandidates(manyMM, manyObs, [], now);
        assert.equal(sel4.observations.length, MAX_OBSERVATIONS, '观察应截断到上限');
        assert.equal(sel4.mentalModels.length, MAX_MENTAL_MODELS, '心智模型应截断到上限');
        assert.equal(sel4.observations[0].id, 'o_24', '观察应按更新时间倒序取最新');
        assert.equal(sel4.observations[MAX_OBSERVATIONS - 1].id, 'o_5');
        assert.equal(sel4.mentalModels[0].id, 'mm_7', '心智模型应按更新时间倒序取最新');
        assert.equal(sel4.mentalModels[MAX_MENTAL_MODELS - 1].id, 'mm_3');
    }
,

    /** E3 事件时间解析：ISO/中文日期/秒级/毫秒级时间戳；非法输入返回 undefined */
    testParseOccurredAt(): void {
        const iso = Math.floor(new Date(2026, 7, 30).getTime() / 1000);
        assert.equal(parseOccurredAt('2026-08-30'), iso, 'YYYY-MM-DD 应解析为秒级时间戳');
        assert.equal(parseOccurredAt('2026年8月30日'), iso, '中文日期应解析为秒级时间戳');
        assert.equal(parseOccurredAt('1770000000'), 1770000000, '秒级时间戳应原样返回');
        assert.equal(parseOccurredAt('1770000000000'), 1770000000, '毫秒级时间戳应转为秒');
        assert.equal(parseOccurredAt(''), undefined, '空字符串应返回 undefined');
        assert.equal(parseOccurredAt('not-a-date'), undefined, '非法字符串应返回 undefined');
        assert.equal(parseOccurredAt(123), undefined, '非字符串应返回 undefined');
    }
,

    

    

    

    

    

    

    

    

    

    

    

    

    

    /** 通知事件白名单解析：逗号/换行/空行/大小写容错 */
    testParseNoticeWhitelist(): void {
        const set = parseNoticeWhitelist(['group_ban, group_admin', 'lucky_king', '', ' group_upload,', 'Group_Whole_Mute']);
        assert.equal(set.has('group_ban'), true);
        assert.equal(set.has('group_admin'), true);
        assert.equal(set.has('lucky_king'), true);
        assert.equal(set.has('group_upload'), true);
        assert.equal(set.has('group_whole_mute'), true, '应统一转小写');
        assert.equal(set.has(''), false, '空项不应入白名单');
        assert.equal(set.has('nope'), false);
    }
,

    /** isNoticeInWhitelist：notify 子类型精确匹配；其余按 notice_type/sub_type 匹配 */
    testNoticeWhitelistGate(): void {
        // notify 大类：只加 notify 不收录任何子类型（避免 gray_tip/input_status 等噪音）
        let set = parseNoticeWhitelist(['notify']);
        assert.equal(isNoticeInWhitelist('notify', 'lucky_king', set), false, '仅加 notify 不收录其子类型');
        assert.equal(isNoticeInWhitelist('notify', 'input_status', set), false);
        assert.equal(isNoticeInWhitelist('notify', '', set), false, 'notify 无子类型不收录');

        // notify 子类型单独加白名单后才收录
        set = parseNoticeWhitelist(['notify', 'lucky_king', 'honor']);
        assert.equal(isNoticeInWhitelist('notify', 'lucky_king', set), true);
        assert.equal(isNoticeInWhitelist('notify', 'honor', set), true);
        assert.equal(isNoticeInWhitelist('notify', 'group_name', set), false, '未单独加的子类型不收录');

        // 非 notify 类：按 notice_type 收录，也兼容按 sub_type 收录
        set = parseNoticeWhitelist(['group_ban', 'group_card', 'group_decrease']);
        assert.equal(isNoticeInWhitelist('group_ban', 'ban', set), true, '按 notice_type 收录');
        assert.equal(isNoticeInWhitelist('group_card', '', set), true, '按 notice_type 收录（无子类型）');
        assert.equal(isNoticeInWhitelist('group_decrease', 'leave', set), true, 'notice_type 命中即收录');

        // 仅加 sub_type（如 kick）也能收录对应事件
        set = parseNoticeWhitelist(['kick']);
        assert.equal(isNoticeInWhitelist('group_decrease', 'kick', set), true, '按 sub_type 收录');
        assert.equal(isNoticeInWhitelist('group_decrease', 'leave', set), false, '未加 group_decrease 时 leave 不收录');
        assert.equal(isNoticeInWhitelist('', 'ban', set), false, '空 notice_type 不收录');
    }
,

    /** ob11 通知事件文本：禁言/管理员/文件上传/运气王/荣誉/poke/群名与头衔/资料点赞/名片/精华/表情回应/解散群/未知类型 */
    testBuildNoticeText(): void {
        assert.equal(buildNoticeText({ notice_type: 'group_ban', sub_type: 'ban', user_id: 1001, operator_id: 1002, duration: 60 }, 'QQ'), 'Group event: QQ:1002 muted QQ:1001 for 60 seconds.');
        assert.equal(buildNoticeText({ notice_type: 'group_ban', sub_type: 'lift_ban', user_id: 1001, operator_id: 1002 }, 'QQ'), 'Group event: QQ:1002 unmuted QQ:1001.');
        assert.equal(buildNoticeText({ notice_type: 'group_admin', sub_type: 'set', user_id: 1001 }, 'QQ'), 'Group event: QQ:1001 was set as admin.');
        assert.equal(buildNoticeText({ notice_type: 'group_admin', sub_type: 'unset', user_id: 1001 }, 'QQ'), 'Group event: QQ:1001 was removed as admin.');
        assert.equal(buildNoticeText({ notice_type: 'group_upload', user_id: 1001, file: { name: '规则.pdf', size: 2048 } }, 'QQ'), 'Group event: QQ:1001 uploaded file "规则.pdf" (2.0KB).');
        assert.equal(buildNoticeText({ notice_type: 'group_upload', user_id: 1001, file: { name: '小文件.txt', size: 512 } }, 'QQ'), 'Group event: QQ:1001 uploaded file "小文件.txt" (512B).');
        assert.equal(buildNoticeText({ notice_type: 'notify', sub_type: 'lucky_king', user_id: 1001 }, 'QQ'), 'Group event: QQ:1001 won the lucky king red packet.');
        assert.equal(buildNoticeText({ notice_type: 'notify', sub_type: 'honor', user_id: 1001, honor_type: 'talkative' }, 'QQ'), 'Group event: QQ:1001 received group honor "talkative".');
        assert.equal(buildNoticeText({ notice_type: 'notify', sub_type: 'poke', user_id: 1001 }, 'QQ'), '', 'poke 由原生 onPoke 处理，不应生成事件文本');
        assert.equal(buildNoticeText({ notice_type: 'notify', sub_type: 'group_name', name_new: '新群名' }, 'QQ'), 'Group event: group name changed to "新群名".');
        assert.equal(buildNoticeText({ notice_type: 'notify', sub_type: 'title', user_id: 1001, title: '群主' }, 'QQ'), `Group event: QQ:1001's title changed to "群主".`);
        assert.equal(buildNoticeText({ notice_type: 'notify', sub_type: 'profile_like', operator_id: 1002, operator_nick: '小明', times: 2 }, 'QQ'), 'Profile event: QQ:1002 liked your profile (x2).');
        assert.equal(buildNoticeText({ notice_type: 'notify', sub_type: 'profile_like', operator_nick: '小明', times: 1 }, 'QQ'), 'Profile event: 小明 liked your profile.', '无 operator_id 时回退昵称');
        assert.equal(buildNoticeText({ notice_type: 'notify', sub_type: 'input_status', user_id: 1001 }, 'QQ'), '', 'input_status 纯噪音不收录');
        assert.equal(buildNoticeText({ notice_type: 'group_card', user_id: 1001, card_old: '旧名片', card_new: '新名片' }, 'QQ'), `Group event: QQ:1001's group card changed from "旧名片" to "新名片".`);
        assert.equal(buildNoticeText({ notice_type: 'essence', sub_type: 'add', sender_id: 1001, operator_id: 1002 }, 'QQ'), `Group event: QQ:1002 set QQ:1001's message as essence.`);
        assert.equal(buildNoticeText({ notice_type: 'essence', sub_type: 'delete', sender_id: 1001, operator_id: 1002 }, 'QQ'), `Group event: QQ:1002 removed QQ:1001's message from essence.`);
        assert.equal(buildNoticeText({ notice_type: 'group_msg_emoji_like', user_id: 1001, likes: [{ emoji_id: '14', count: 3 }], is_add: true }, 'QQ'), 'Group event: QQ:1001 added emoji reaction "微笑"(x3) on a message.');
        assert.equal(buildNoticeText({ notice_type: 'group_msg_emoji_like', user_id: 1001, likes: [{ emoji_id: '14', count: 1 }, { emoji_id: '21', count: 1 }], is_add: false }, 'QQ'), 'Group event: QQ:1001 removed emoji reaction "微笑", "可爱" on a message.');
        assert.equal(buildNoticeText({ notice_type: 'group_decrease', sub_type: 'disband' }, 'QQ'), 'Group event: this group was disbanded.');
        assert.equal(buildNoticeText({ notice_type: 'unknown_type', user_id: 1001 }, 'QQ'), '', '未知类型返回空');
    }
,

    /** ob11 请求事件文本：好友/入群申请（含备注截断） */
    testBuildRequestText(): void {
        assert.equal(buildRequestText({ request_type: 'friend', user_id: 1001, comment: '我是小明' }, 'QQ'), 'Friend request: QQ:1001 wants to add you as a friend: 我是小明 (full event data: read_raw kind=event; needed to handle the request)');
        assert.equal(buildRequestText({ request_type: 'group', sub_type: 'add', user_id: 1001, group_id: 2001, comment: '想进群' }, 'QQ'), 'Group join request: QQ:1001 requests to join group QQ-Group:2001: 想进群 (full event data: read_raw kind=event; needed to handle the request)');
        assert.equal(buildRequestText({ request_type: 'group', sub_type: 'invite', user_id: 1001, group_id: 2001 }, 'QQ'), 'Group join request: QQ:1001 invites you to join group QQ-Group:2001 (full event data: read_raw kind=event; needed to handle the request)');
        assert.equal(buildRequestText({ request_type: 'unknown', user_id: 1001 }, 'QQ'), '');
    }
,

    /** 原生海豹回调事件文本（Phase 3 统一入口） */
    testBuildNativeNoticeText(): void {
        assert.equal(buildNativeNoticeText({ noticeType: 'group_joined' }), 'Group event: this bot joined the group.');
        assert.equal(buildNativeNoticeText({ noticeType: 'group_increase', userId: 'QQ:1001' }), 'Group event: QQ:1001 joined this group.');
        assert.equal(buildNativeNoticeText({ noticeType: 'group_decrease', subType: 'kick', userId: 'QQ:1001', operatorId: 'QQ:1002' }), 'Group event: QQ:1002 removed QQ:1001 from this group.');
        assert.equal(buildNativeNoticeText({ noticeType: 'group_decrease', subType: 'kick_me' }), 'Group event: this bot was removed from the group.');
        assert.equal(buildNativeNoticeText({ noticeType: 'group_decrease', userId: 'QQ:1001' }), 'Group event: QQ:1001 left this group.');
        assert.equal(buildNativeNoticeText({ noticeType: 'group_recall', userId: 'QQ:1001' }), 'Group event: QQ:1001 recalled a message.');
        assert.equal(buildNativeNoticeText({ noticeType: 'friend_recall', userId: 'QQ:1001' }), 'Friend event: QQ:1001 recalled a message.');
        assert.equal(buildNativeNoticeText({ noticeType: 'friend_add', userId: 'QQ:1001' }), 'Friend event: now friends with QQ:1001.');
        assert.equal(buildNativeNoticeText({ noticeType: 'nope' }), '');
    }
,

    /** target_id 平台无关：QQ 行为不变，其它平台按 adaptor 格式保留；裸 ID 必须带 platformHint，绝不默认 QQ */
    testTargetIdPlatformAgnostic(): void {
        // QQ：带前缀行为与旧版一致，裸数字 ID + QQ hint 补全为 QQ:xxx
        assert.equal(normalizeUserId('QQ:123'), 'QQ:123');
        assert.equal(normalizeUserId('QQ:abc'), null, 'QQ 用户 ID 必须为纯数字');
        assert.equal(normalizeUserId('123', 'QQ'), 'QQ:123');
        assert.equal(normalizeUserId('abc', 'QQ'), null, 'QQ 裸 ID 仍要求纯数字');
        assert.equal(normalizeUserId(123, 'QQ'), 'QQ:123');
        assert.equal(normalizeGroupId('QQ-Group:123'), 'QQ-Group:123');
        assert.equal(normalizeGroupId('QQ-Group:abc'), null, 'QQ 群 ID 必须为纯数字');
        assert.equal(normalizeGroupId('123', 'QQ'), 'QQ-Group:123');
        assert.equal(normalizeGroupId('QQ:123'), null, '用户前缀不能当群 ID');
        assert.equal(normalizeUserId('QQ-Group:123'), null, '群 ID 不能当用户 ID');
        // 非 QQ 平台：带前缀原样保留（如 Discord 字母 ID）
        assert.equal(normalizeUserId('DISCORD:user_abc'), 'DISCORD:user_abc');
        assert.equal(normalizeGroupId('DISCORD-Group:chan_1'), 'DISCORD-Group:chan_1');
        assert.equal(normalizeUserId('DISCORD-Group:chan_1'), null);
        assert.equal(normalizeGroupId('DISCORD:user_abc'), null);
        // 裸 ID + 非 QQ hint：按平台补全
        assert.equal(normalizeUserId('user_abc', 'DISCORD'), 'DISCORD:user_abc');
        assert.equal(normalizeGroupId('chan_1', 'DISCORD'), 'DISCORD-Group:chan_1');
        // OpenQQ 群同样走 -Group: 标记
        assert.equal(normalizeGroupId('OpenQQ-Group:123456'), 'OpenQQ-Group:123456');
        // 无 hint 的裸 ID：绝不默认 QQ，返回 null
        assert.equal(normalizeUserId('123'), null, '裸 ID 无 hint 不得默认 QQ');
        assert.equal(normalizeGroupId('123'), null, '裸群 ID 无 hint 不得默认 QQ');
        assert.equal(normalizeTargetId('123'), null, '裸目标 ID 无法判断类型，无 hint 返回 null');
        // normalizeTargetId：按 -Group: 标记区分用户/群
        assert.equal(normalizeTargetId('QQ:123'), 'QQ:123');
        assert.equal(normalizeTargetId('QQ-Group:123'), 'QQ-Group:123');
        assert.equal(normalizeTargetId('DISCORD:user_abc'), 'DISCORD:user_abc');
        assert.equal(normalizeTargetId('DISCORD-Group:chan_1'), 'DISCORD-Group:chan_1');
        // getPlatform / isGroupId / makeUserId / makeGroupId
        assert.equal(getPlatform('QQ:123'), 'QQ');
        assert.equal(getPlatform('QQ-Group:123'), 'QQ');
        assert.equal(getPlatform('DISCORD:user_abc'), 'DISCORD');
        assert.equal(getPlatform('DISCORD-Group:chan_1'), 'DISCORD');
        assert.equal(isGroupId('QQ-Group:123'), true);
        assert.equal(isGroupId('DISCORD-Group:chan_1'), true);
        assert.equal(isGroupId('QQ:123'), false);
        assert.equal(makeUserId('QQ', '123'), 'QQ:123');
        assert.equal(makeGroupId('DISCORD', 'chan_1'), 'DISCORD-Group:chan_1');
        // platformOf：优先 endPoint.platform，其次从 endPoint.userId 前缀解析
        assert.equal(platformOf({ endPoint: { platform: 'QQ', userId: 'QQ:10000' } }), 'QQ');
        assert.equal(platformOf({ endPoint: { userId: 'QQ:10000' } }), 'QQ');
        assert.equal(platformOf({ endPoint: { userId: 'DISCORD:user_abc' } }), 'DISCORD');
        assert.equal(platformOf({ endPoint: { platform: 'OpenQQ', userId: 'OpenQQ-Group:123' } }), 'OpenQQ');
        assert.equal(platformOf({ endPoint: { platform: '  QQ  ' } }), 'QQ', 'platform 应 trim');
        assert.equal(platformOf(null), '', '空 ctx 返回空平台');
        assert.equal(platformOf({ endPoint: {} }), '', '无平台信息返回空');
    }
,

    /** buildNoticeText/buildRequestText：prefix 由调用方传入，非 QQ 平台输出对应 UNI-ID；QQ 输出不变 */
    testBuildNoticeTextNonQQPrefix(): void {
        assert.equal(
            buildNoticeText({ notice_type: 'group_ban', sub_type: 'ban', user_id: 1001, operator_id: 1002, duration: 60 }, 'DISCORD'),
            'Group event: DISCORD:1002 muted DISCORD:1001 for 60 seconds.'
        );
        assert.equal(
            buildNoticeText({ notice_type: 'group_upload', user_id: 1001, file: { name: '规则.pdf', size: 2048 } }, 'DISCORD'),
            'Group event: DISCORD:1001 uploaded file "规则.pdf" (2.0KB).'
        );
        assert.equal(
            buildRequestText({ request_type: 'group', sub_type: 'add', user_id: 1001, group_id: 2001, comment: '想进群' }, 'DISCORD'),
            'Group join request: DISCORD:1001 requests to join group DISCORD-Group:2001: 想进群 (full event data: read_raw kind=event; needed to handle the request)'
        );
        // QQ 回归：与既有 QQ 前缀输出完全一致
        assert.equal(
            buildNoticeText({ notice_type: 'group_ban', sub_type: 'ban', user_id: 1001, operator_id: 1002, duration: 60 }, 'QQ'),
            'Group event: QQ:1002 muted QQ:1001 for 60 seconds.'
        );
        assert.equal(
            buildRequestText({ request_type: 'friend', user_id: 1001 }, 'QQ'),
            'Friend request: QQ:1001 wants to add you as a friend (full event data: read_raw kind=event; needed to handle the request)'
        );
    }
,

    /** resolveEndpointId：按 self_id 反查平台端点（QQ 与非 QQ 均可），匹配不到返回空串 */
    testResolveEndpointId(): void {
        const origGetEndPoints = (globalThis as any).seal.getEndPoints;
        (globalThis as any).seal.getEndPoints = () => [
            { userId: 'QQ:10000' },
            { userId: 'DISCORD:10001' },
            { userId: 'OpenQQ-Group:20002' }
        ];
        try {
            assert.equal(resolveEndpointId('10000'), 'QQ:10000');
            assert.equal(resolveEndpointId('10001'), 'DISCORD:10001');
            assert.equal(resolveEndpointId('20002'), 'OpenQQ-Group:20002');
            assert.equal(resolveEndpointId('99999'), '', '未匹配端点应返回空串');
            assert.equal(resolveEndpointId(10000), 'QQ:10000', '数字 self_id 应兼容');
        } finally {
            (globalThis as any).seal.getEndPoints = origGetEndPoints;
        }
    }
,

    /** resolveEndpointId：同号双端点（直连+桥）仍返回该 QQ epId；已连接端点优先（回归保障） */
    testResolveEndpointIdOnDuplicateUserIdPrefersConnected(): void {
        const origGetEndPoints = (globalThis as any).seal.getEndPoints;
        (globalThis as any).seal.getEndPoints = () => [
            { userId: 'QQ:10000', state: 0 },
            { userId: 'QQ:10000', state: 1 },
            { userId: 'DISCORD:10001', state: 1 }
        ];
        try {
            assert.equal(resolveEndpointId('10000'), 'QQ:10000', '同号双端点仍应反查到该 QQ epId');
            assert.equal(resolveEndpointId('10001'), 'DISCORD:10001');
            assert.equal(resolveEndpointId('99999'), '', '未匹配端点应返回空串');
        } finally {
            (globalThis as any).seal.getEndPoints = origGetEndPoints;
        }
    }
,

    /** createCtx：同号双端点（直连+桥）优先已连接（state=1）端点；全部不在线时回退首个匹配端点 */
    testCreateCtxPrefersConnectedEndpointOnDuplicateUserId(): void {
        const origGetEndPoints = (globalThis as any).seal.getEndPoints;
        const origCreateTempCtx = (globalThis as any).seal.createTempCtx;
        let used: any = null;
        (globalThis as any).seal.createTempCtx = (ep: any, msg: any) => {
            used = ep;
            return {
                endPoint: ep,
                player: { userId: ep.userId, name: '' },
                group: null,
                isPrivate: msg?.messageType === 'private'
            };
        };
        const msg = (globalThis as any).seal.newMessage();
        try {
            (globalThis as any).seal.getEndPoints = () => [
                { id: 'bridge', userId: 'QQ:10000', state: 0 },
                { id: 'direct', userId: 'QQ:10000', state: 1 }
            ];
            used = null;
            const ctx = createCtx('QQ:10000', msg);
            assert.equal(used?.id, 'direct', '同号双端点应优先选择已连接（state=1）的端点');
            assert.equal(ctx?.endPoint.id, 'direct', '返回的 ctx 应绑定已连接端点');

            (globalThis as any).seal.getEndPoints = () => [
                { id: 'bridge', userId: 'QQ:10000', state: 0 },
                { id: 'direct', userId: 'QQ:10000', state: 0 }
            ];
            used = null;
            const fallbackCtx = createCtx('QQ:10000', msg);
            assert.equal(used?.id, 'bridge', '全部不在线时应回退到第一个匹配端点（旧行为）');
            assert.equal(fallbackCtx?.endPoint.id, 'bridge');

            (globalThis as any).seal.getEndPoints = () => [{ userId: 'QQ:10000' }];
            used = null;
            const legacyCtx = createCtx('QQ:10000', msg);
            assert.equal(used?.userId, 'QQ:10000', '无 state 字段的历史端点应兼容回退');
            assert.equal(legacyCtx?.endPoint.userId, 'QQ:10000');
        } finally {
            (globalThis as any).seal.getEndPoints = origGetEndPoints;
            (globalThis as any).seal.createTempCtx = origCreateTempCtx;
        }
    }
,

    /** SessionService 会话类型判定：-Group: 标记判群，其余为私聊用户（QQ 行为不变，且支持非 QQ 平台） */
    testSessionServicePlatformAgnosticType(): void {
        const svc = new SessionService();
        try {
            assert.equal(svc.getSession('QQ:abc').sessionType, 'user', 'QQ 私聊仍为 user');
            assert.equal(svc.getSession('QQ-Group:123').sessionType, 'group', 'QQ 群仍为 group');
            assert.equal(svc.getSession('DISCORD:user_abc').sessionType, 'user', '非 QQ 私聊为 user');
            assert.equal(svc.getSession('DISCORD-Group:chan_1').sessionType, 'group', '非 QQ 群为 group');
            assert.equal(svc.getSession('OpenQQ-Group:123456').sessionType, 'group', 'OpenQQ 群为 group');
        } finally {
            for (const key of Object.keys(svc.sessionMap)) delete svc.sessionMap[key];
        }
    }
,
    /**
     * 回归：`.ai off` 遇到未知 flag 必须如实回报，不能回复"AI已关闭："造成已生效的错觉。
     * 旧实现 switch 无 default，`--standb` 这类拼写错误被静默忽略但照旧回复关闭文案。
     */
    async testCmdOffUnknownFlag(): Promise<void> {
        const origReply = (globalThis as any).seal.replyToSender;
        const origOff = SubCmd.map['off'];
        let replied = '';
        (globalThis as any).seal.replyToSender = (_ctx: any, _msg: any, text: string) => { replied = String(text); };
        try {
            registerCmdOff();
            const session = new Session();
            session.sessionId = 'QQ:10000';
            session.sessionType = 'user';
            session.setting.aiEnabled = true;

            const runOff = async (kwargs: { name: string }[]) => {
                replied = '';
                await SubCmd.map['off'].solve({
                    ctx: { endPoint: { userId: 'QQ:10000' }, player: { userId: 'QQ:10000', name: '测试员' } } as any,
                    msg: {} as any,
                    cmdArgs: { kwargs, getArgN: () => '' } as any,
                    epId: 'QQ:10000', uid: 'QQ:10000', gid: '', sid: 'QQ:10000',
                    session, page: 1, ret: {} as any
                });
            };

            // 拼错的 flag：不得声称已关闭，且状态不得改变
            session.setting.aiEnabled = true;
            await runOff([{ name: 'standb' }]);
            assert.ok(!replied.startsWith('AI已关闭：'), `未知 flag 不应回复"AI已关闭："，实际: ${replied}`);
            assert.ok(replied.includes('--standb'), `应回显未识别的参数名，实际: ${replied}`);
            assert.equal(session.setting.aiEnabled, true, '未知 flag 不应改动任何状态');

            // 合法 flag 仍正常生效（--sb 已随待机概念删除，这里用 --r）
            session.setting.regexTrigger = true;
            await runOff([{ name: 'r' }]);
            assert.ok(replied.includes('AI已关闭：'), `合法 flag 应正常关闭，实际: ${replied}`);
            assert.ok(replied.includes('非指令正则触发'), '应列出被关闭的模式');
            assert.equal(session.setting.regexTrigger, false, '--r 应真正关闭正则触发');

            // 混合：合法 + 非法 → 生效并提示忽略了哪些
            session.setting.regexTrigger = true;
            await runOff([{ name: 'r' }, { name: 'nope' }]);
            assert.equal(session.setting.regexTrigger, false, '合法项应生效');
            assert.ok(replied.includes('已忽略未识别的参数'), `应提示忽略了非法项，实际: ${replied}`);
            assert.ok(replied.includes('--nope'), `应回显非法项名，实际: ${replied}`);
        } finally {
            (globalThis as any).seal.replyToSender = origReply;
            if (origOff) SubCmd.map['off'] = origOff; else delete SubCmd.map['off'];
        }
    }
,

    /**
     * 回归：context_edit_replace 的三道防线
     *  - S3 跨会话写入必须先确认目标会话存在（否则 getSession 会凭空建会话并落盘）
     *  - M4 count 非法值要报参数错，不能被当成"没匹配上"
     *  - M5 scope 无法解析/越界要报 scope 错，且越界收敛要显式告知
     */
    async testContextEditGuards(): Promise<void> {
        const origGet = ext.storageGet;
        const origSet = ext.storageSet;
        const store: Record<string, string> = {};
        const sid = 'QQ-Group:1001';
        const svc: any = Agent.get('*').sessionService;
        const origSession = svc.sessionMap[sid];
        try {
            (ext as any).storageGet = (k: string) => store[k] ?? '';
            (ext as any).storageSet = (k: string, v: string) => { store[k] = v; };

            if (!toolMap['context_edit_replace']) registerContextEditTools();
            const replace = toolMap['context_edit_replace'] as any;
            assert.ok(replace, 'context_edit_replace 应已注册');
            assert.equal(replace.sensitive, true, 'context_edit_replace 必须是敏感工具');

            // 工具内部走 getSession(sid)，必须让会话服务返回同一个实例
            const session: any = new Session();
            session.sessionId = sid;
            session.sessionType = 'group';
            session.context.messages = [
                { role: 'user', contentItems: [{ text: 'hello world' }] },
                { role: 'assistant', contentItems: [{ text: 'hi there' }] },
            ];
            session.save = () => { /* 不落盘 */ };
            svc.sessionMap[sid] = session;

            const run = (args: any) => replace.solve({} as any, {} as any, session, args);

            // --- M4：非法 count 必须报参数错，而不是"未命中" ---
            let out = String(await run({ search: 'hello', replacement: 'X', count: 'abc' }));
            assert.ok(out.includes('count 参数非法'), `count=abc 应报参数错，实际: ${out}`);
            assert.ok(!out.includes('未命中'), 'count 非法不得误报为未命中');

            out = String(await run({ search: 'hello', replacement: 'X', count: 0 }));
            assert.ok(out.includes('count 参数非法'), `count=0 应报参数错，实际: ${out}`);

            out = String(await run({ search: 'hello', replacement: 'X', count: -3 }));
            assert.ok(out.includes('count 参数非法'), `count=-3 应报参数错，实际: ${out}`);

            // 合法 count 正常工作
            out = String(await run({ search: 'hello', replacement: 'X', count: 1 }));
            assert.ok(out.includes('已完成上下文替换'), `count=1 应正常执行，实际: ${out}`);

            // --- M5：scope 诊断 ---
            out = String(await run({ search: 'X', replacement: 'Y', scope: 'idx:abc' }));
            assert.ok(out.includes('idx 写法非法'), `idx:abc 应报写法非法，实际: ${out}`);

            out = String(await run({ search: 'X', replacement: 'Y', scope: 'idx:99' }));
            assert.ok(out.includes('idx 越界'), `idx:99 越界应显式报错，实际: ${out}`);
            assert.ok(!out.includes('未命中'), 'scope 越界不得误报为未命中');

            // 越界区间会被收敛（不是错误），且必须显式告知收敛后的范围
            session.context.messages = [{ role: 'user', contentItems: [{ text: 'hello world' }] }];
            out = String(await run({ search: 'hello', replacement: 'Z', scope: 'idx:0-99' }));
            assert.ok(out.includes('已完成上下文替换'), `越界区间应可执行，实际: ${out}`);
            assert.ok(out.includes('注意') && out.includes('收敛'), `越界区间应提示收敛，实际: ${out}`);

            out = String(await run({ search: 'Z', replacement: 'Z', scope: 'nonsense' }));
            assert.ok(out.includes('无法解析的 scope'), `未知 scope 应报错，实际: ${out}`);

            // --- S3：不存在的会话必须拒绝，且不得落盘 ---
            const beforeKeys = Object.keys(store).length;
            out = String(await run({ search: 'a', replacement: 'b', session_id: 'QQ-Group:999999' }));
            assert.ok(out.includes('不存在'), `不存在的会话应拒绝写入，实际: ${out}`);
            assert.equal(Object.keys(store).length, beforeKeys, '被拒绝的写入不得在存储里凭空建会话');

            // 当前会话（sid 与目标一致）不受影响
            session.context.messages = [{ role: 'assistant', contentItems: [{ text: 'hi there' }] }];
            out = String(await run({ search: 'hi there', replacement: 'hello' }));
            assert.ok(out.includes('已完成上下文替换'), `当前会话应正常可写，实际: ${out}`);
        } finally {
            (ext as any).storageGet = origGet;
            (ext as any).storageSet = origSet;
            if (origSession) svc.sessionMap[sid] = origSession; else delete svc.sessionMap[sid];
            delete toolMap['context_edit_replace'];
            delete toolMap['context_edit_list'];
        }
    }
,

    /** .ai status：输出平台（QQ 与非 QQ 均按 adaptor 平台展示） */
    testCmdStatusShowsPlatform(): void {
        const origReply = (globalThis as any).seal.replyToSender;
        const origStatus = SubCmd.map['status'];
        let replied = '';
        (globalThis as any).seal.replyToSender = (_ctx: any, _msg: any, text: string) => { replied = text; };
        try {
            registerCmdStatus(); // 注册到 SubCmd.map（幂等覆盖）
            const qqSession = new Session();
            qqSession.sessionId = 'QQ:10000';
            qqSession.sessionType = 'user';
            SubCmd.map['status'].solve({
                ctx: { endPoint: { userId: 'QQ:10000' }, player: { userId: 'QQ:10000', name: '测试员' } } as any,
                msg: {} as any,
                cmdArgs: {} as any,
                epId: 'QQ:10000',
                uid: 'QQ:10000',
                gid: '',
                sid: 'QQ:10000',
                session: qqSession,
                page: 1,
                ret: {} as any
            });
            assert.ok(replied.includes('平台: QQ'), `QQ 会话应显示平台 QQ，实际: ${replied}`);

            const discordSession = new Session();
            discordSession.sessionId = 'DISCORD:user_abc';
            discordSession.sessionType = 'user';
            SubCmd.map['status'].solve({
                ctx: { endPoint: { userId: 'DISCORD:user_abc' }, player: { userId: 'DISCORD:user_abc', name: '测试员' } } as any,
                msg: {} as any,
                cmdArgs: {} as any,
                epId: 'DISCORD:user_abc',
                uid: 'DISCORD:user_abc',
                gid: '',
                sid: 'DISCORD:user_abc',
                session: discordSession,
                page: 1,
                ret: {} as any
            });
            assert.ok(replied.includes('平台: DISCORD'), `非 QQ 会话应按 adaptor 显示平台，实际: ${replied}`);
        } finally {
            (globalThis as any).seal.replyToSender = origReply;
            if (origStatus) SubCmd.map['status'] = origStatus; else delete SubCmd.map['status'];
        }
    }
};
