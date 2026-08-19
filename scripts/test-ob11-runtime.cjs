/* Pure OB11 runtime simulation. It never starts SealDice, connects QQ, or calls a real endpoint. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

const repo = path.resolve(__dirname, '..');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiplugin4-ob11-'));
const bundle = path.join(outDir, 'runtime.cjs');
const sent = [];
const templateConfig = {
    '本地图片路径': ['/virtual/avatar.png'],
    '本地语音路径': ['voice=/virtual/voice.mp3'],
    '本地文件路径': ['book=/virtual/book.pdf'],
    '本地视频路径': ['clip=/virtual/clip.mp4']
};

// Minimal SealDice surface used by module initialization and the native fallback.
globalThis.seal = {
    ext: {
        find: () => undefined,
        new: () => ({}),
        register: () => undefined,
        registerBoolConfig: () => undefined,
        registerIntConfig: () => undefined,
        registerFloatConfig: () => undefined,
        registerStringConfig: () => undefined,
        registerOptionConfig: () => undefined,
        registerTemplateConfig: () => undefined,
        getTemplateConfig: (_ext, key) => {
            if (['对话模型', '图片模型', '嵌入模型'].includes(key)) return [];
            return templateConfig[key] || [''];
        },
        getBoolConfig: () => true,
        getIntConfig: () => 10,
        getFloatConfig: () => 0,
        getStringConfig: () => '/virtual/sealdice',
        getOptionConfig: () => '信息',
        storageGet: () => '',
        storageSet: () => undefined
    },
    replyToSender: (ctx, msg, content) => sent.push({ ctx, msg, content }),
    newMessage: () => ({ sender: {}, messageType: 'group' }),
    getEndPoints: () => [],
    createTempCtx: () => ({})
};

(async () => {
    await esbuild.build({
        entryPoints: [path.join(repo, 'scripts/ob11-runtime-test-entry.ts')],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        outfile: bundle,
        logLevel: 'silent'
    });

    const runtime = require(bundle);
    assert.equal(runtime.getActionCapability('send_group_msg'), 'either');
    assert.equal(runtime.getActionCapability('get_group_member_list'), 'network');

    // Model literal \n escapes are rendered as real line breaks; \f remains untouched for message splitting.
    assert.equal(runtime.decodeEscapedNewlines('第一行\\n第二行'), '第一行\n第二行');
    assert.equal(runtime.decodeEscapedNewlines('第一行\\r\\n第二行'), '第一行\n第二行');
    assert.equal(runtime.decodeEscapedNewlines('第一条\\f第二条'), '第一条\\f第二条');

    const context = {
        endpointId: '10000',
        ctx: {
            endPoint: { userId: '10000' },
            group: { groupId: 'QQ-Group:123456', groupName: '模拟群' },
            player: { userId: 'QQ:20000', name: '模拟用户', role: 'member' }
        },
        msg: { messageType: 'group' }
    };

    // No ob11 dependency: native send preserves special segments as CQ content.
    delete globalThis.net;
    sent.length = 0;
    const nativeSend = await runtime.dispatchOb11Api(context, 'send_group_msg', {
        group_id: '123456',
        message: [
            { type: 'text', data: { text: 'hello' } },
            { type: 'image', data: { file: '/virtual/avatar.png' } },
            { type: 'record', data: { file: '/virtual/voice.mp3' } },
            { type: 'video', data: { file: '/virtual/clip.mp4' } },
            { type: 'file', data: { file: '/virtual/book.pdf', name: 'book.pdf' } },
            { type: 'at', data: { qq: '20000' } },
            { type: 'reply', data: { id: '88' } },
            { type: 'json', data: { data: '{"app":"demo"}' } },
            { type: 'markdown', data: { content: '# demo' } },
            { type: 'music', data: { type: 'qq', id: '99' } },
            { type: 'poke', data: { qq: '20000' } },
            { type: 'dice', data: {} },
            { type: 'rps', data: {} }
        ]
    });
    assert.equal(nativeSend.ok, true);
    assert.equal(nativeSend.backend, 'seal-native');
    assert.equal(sent.length, 1);
    for (const marker of ['[CQ:image', '[CQ:record', '[CQ:video', '[CQ:file', '[CQ:at', '[CQ:reply', '[CQ:json', '[CQ:markdown', '[CQ:music', '[CQ:poke', '[CQ:dice]', '[CQ:rps]']) {
        assert.match(sent[0].content, new RegExp(marker.replace(/[\[\]]/g, '\\$&')));
    }

    const nativeGroupInfo = await runtime.dispatchOb11Api(context, 'get_group_info', { group_id: '123456' });
    assert.equal(nativeGroupInfo.ok, true);
    assert.equal(nativeGroupInfo.backend, 'seal-native');

    for (const action of ['get_group_member_list', 'upload_group_file', 'totally_unknown_action']) {
        const unavailable = await runtime.dispatchOb11Api(context, action, {});
        assert.equal(unavailable.ok, false);
        assert.equal(unavailable.error.code, 'OB11_DEPENDENCY_REQUIRED');
    }

    const unsupportedNative = await runtime.dispatchOb11Api(context, 'send_group_msg', {
        group_id: '123456',
        message: [{ type: 'node', data: { user_id: '1', content: [{ type: 'text', data: { text: 'node' } }] } }]
    });
    assert.equal(unsupportedNative.ok, false);
    assert.equal(unsupportedNative.error.code, 'NATIVE_SEND_ERROR');

    // With a mocked ob11 dependency: all actions use callApi, while file uploads use sendFile.
    const calls = [];
    globalThis.net = {
        callApi: async (epId, action, params) => {
            calls.push({ kind: 'callApi', epId, action, params });
            return { message_id: 501, action };
        },
        sendFile: async (epId, scene, peerId, file, name, folderId) => {
            calls.push({ kind: 'sendFile', epId, scene, peerId, file, name, folderId });
            return { message_id: 502 };
        }
    };
    const remoteSend = await runtime.dispatchOb11Api(context, 'send_private_msg', {
        user_id: '20000',
        message: [{ type: 'image', data: { file: 'resource:avatar' } }]
    });
    assert.equal(remoteSend.ok, true);
    assert.equal(remoteSend.backend, 'ob11-net');
    assert.equal(remoteSend.message_id, 501);
    assert.equal(calls[0].kind, 'callApi');
    assert.equal(calls[0].params.message[0].data.file, '/virtual/avatar.png');

    const upload = await runtime.dispatchOb11Api(context, 'upload_group_file', {
        group_id: '123456', file: 'resource:book', name: 'book.pdf', folder_id: 'folder'
    });
    assert.equal(upload.ok, true);
    assert.equal(upload.message_id, 502);
    assert.equal(calls[1].kind, 'sendFile');
    assert.equal(calls[1].scene, 'group');
    assert.equal(calls[1].peerId, '123456');
    assert.equal(calls[1].file, '/virtual/book.pdf');

    console.log('OB11 runtime simulation passed: native fallback, dependency errors, special segments, resource references, net calls, and file uploads.');
})().finally(() => fs.rmSync(outDir, { recursive: true, force: true })).catch(error => {
    console.error(error);
    process.exitCode = 1;
});

