// 后端配置（JSON v1）单元测试：纯解析 + 运行时映射。
// 运行：npm run test:unit（由 scripts/test-unit.cjs 打包）
import assert from 'node:assert/strict';

import Config from '../src/config/config';
import { BACKEND_NAMES, DEFAULT_BACKENDS, parseBackendConfig, resolveBackendEndpoints } from '../src/config/domain/backend';

Config.registerConfig();

const TC = (globalThis as any).__TEST_CONFIG__;

function resetConfigCache(): void {
    (Config as any).cache = {};
}

function setBackendConfig(text: string): void {
    TC.stringConfigs['后端配置'] = text;
    resetConfigCache();
}

function clearBackendConfig(): void {
    delete TC.stringConfigs['后端配置'];
    resetConfigCache();
}

const DEFAULTS = {
    STREAM: 'http://localhost:3010',
    STREAM_TOKEN: '',
    IMAGE_TO_BASE64: 'http://127.0.0.1:46678',
    IMAGE_TO_BASE64_TOKEN: '',
    IMAGE_HOST: '',
    IMAGE_HOST_PUBLIC_URL: '',
    IMAGE_HOST_TOKEN: '',
    MEDIA_FETCH: 'http://127.0.0.1:46679',
    MEDIA_FETCH_TOKEN: '',
    USAGE_CHART: 'http://127.0.0.1:3009',
    USAGE_CHART_TOKEN: '',
    CORE_BRIDGE_WS_URL: 'ws://127.0.0.1:46880/plugin',
    CORE_BRIDGE_TOKEN: '',
};

export const tests: Record<string, () => void | Promise<void>> = {
    testEmptyConfigUsesFactoryDefaults() {
        clearBackendConfig();
        assert.deepEqual(Config.backend, DEFAULTS);
    },

    testEmptyTextNoConfigNoIssues() {
        const result = parseBackendConfig('');
        assert.equal(result.config, null);
        assert.deepEqual(result.issues, []);
        assert.deepEqual(result.warnings, []);
    },

    testFullConfigMapsToRuntime() {
        setBackendConfig(JSON.stringify({
            version: 1,
            backends: {
                'stream-output': { url: 'http://stream:3010/', token: 'stream-token' },
                'image-url-to-base64': { url: 'http://i2b64:46678', token: 'i2b64-token' },
                'image-host': {
                    url: 'http://127.0.0.1:46680',
                    publicUrl: 'http://192.168.1.10:46680/',
                    token: ' host-token ',
                },
                'media-fetch': { url: 'http://media:46679', token: ' media-token ' },
                'usage-chart': { url: 'http://chart:3009', token: 'chart-token' },
                'ob11-core-bridge': { url: 'ws://bridge:46880/plugin', token: 'bridge-token' },
            },
        }));
        assert.deepEqual(Config.backend, {
            STREAM: 'http://stream:3010',
            STREAM_TOKEN: 'stream-token',
            IMAGE_TO_BASE64: 'http://i2b64:46678',
            IMAGE_TO_BASE64_TOKEN: 'i2b64-token',
            IMAGE_HOST: 'http://127.0.0.1:46680',
            IMAGE_HOST_PUBLIC_URL: 'http://192.168.1.10:46680',
            IMAGE_HOST_TOKEN: 'host-token',
            MEDIA_FETCH: 'http://media:46679',
            MEDIA_FETCH_TOKEN: 'media-token',
            USAGE_CHART: 'http://chart:3009',
            USAGE_CHART_TOKEN: 'chart-token',
            CORE_BRIDGE_WS_URL: 'ws://bridge:46880/plugin',
            CORE_BRIDGE_TOKEN: 'bridge-token',
        });
    },

    /** 图床 publicUrl：协议端/模型访问地址；回环时忽略并 warning，非图床后端出现则视为未知字段 */
    testImageHostPublicUrl() {
        const ok = parseBackendConfig(JSON.stringify({
            version: 1,
            backends: { 'image-host': { url: 'http://127.0.0.1:46680', publicUrl: 'https://img.example.com/' } },
        }));
        assert.ok(ok.config, JSON.stringify(ok.issues));
        assert.equal(ok.config!.backends['image-host']!.publicUrl, 'https://img.example.com');

        const loopback = parseBackendConfig(JSON.stringify({
            version: 1,
            backends: { 'image-host': { url: '', publicUrl: 'http://127.0.0.1:46680' } },
        }));
        assert.ok(loopback.config);
        assert.equal(loopback.config!.backends['image-host']!.publicUrl, '');
        assert.ok(loopback.warnings.some(w => w.path.endsWith('.publicUrl')), '回环 publicUrl 应 warning');

        const badScheme = parseBackendConfig(JSON.stringify({
            version: 1,
            backends: { 'image-host': { url: '', publicUrl: 'ftp://img.example.com' } },
        }));
        assert.equal(badScheme.config, null);
        assert.ok(badScheme.issues.some(i => i.path.endsWith('.publicUrl')));

        const onOther = parseBackendConfig(JSON.stringify({
            version: 1,
            backends: { 'stream-output': { url: 'http://stream:3010', publicUrl: 'http://x:1' } },
        }));
        assert.ok(onOther.config);
        assert.equal(onOther.config!.backends['stream-output']!.publicUrl, undefined);
        assert.ok(onOther.warnings.some(w => w.path.endsWith('.publicUrl')));
    },

    testPartialConfigFillsDefaults() {
        setBackendConfig(JSON.stringify({
            version: 1,
            backends: { 'stream-output': { url: 'http://only-stream:3010' } },
        }));
        assert.equal(Config.backend.STREAM, 'http://only-stream:3010');
        assert.equal(Config.backend.IMAGE_TO_BASE64, DEFAULTS.IMAGE_TO_BASE64);
        assert.equal(Config.backend.IMAGE_HOST, '');
        assert.equal(Config.backend.CORE_BRIDGE_WS_URL, DEFAULTS.CORE_BRIDGE_WS_URL);
    },

    testOptionalEmptyUrlDisables() {
        setBackendConfig(JSON.stringify({
            version: 1,
            backends: {
                'image-host': { url: '' },
                'media-fetch': { url: '' },
            },
        }));
        assert.equal(Config.backend.IMAGE_HOST, '');
        assert.equal(Config.backend.MEDIA_FETCH, '');
    },

    testOptionalUrlMayBeOmitted() {
        const result = parseBackendConfig(JSON.stringify({
            version: 1,
            backends: { 'image-host': { token: 'only-token' } },
        }));
        assert.ok(result.config, JSON.stringify(result.issues));
        assert.equal(result.config!.backends['image-host']!.url, '');
        assert.equal(result.config!.backends['image-host']!.token, 'only-token');
    },

    testEmptyBackendsObjectUsesDefaults() {
        setBackendConfig('{"version":1,"backends":{}}');
        assert.deepEqual(Config.backend, DEFAULTS);
    },

    testUnknownBackendNameWarnsAndIgnores() {
        const result = parseBackendConfig(JSON.stringify({
            version: 1,
            backends: {
                'stream-output': { url: 'http://stream:3010' },
                'some-mcp-server': { type: 'http', url: 'http://x/mcp' },
            },
        }));
        assert.ok(result.config);
        assert.deepEqual(Object.keys(result.config!.backends), ['stream-output']);
        assert.equal(result.warnings.length, 1);
        assert.match(result.warnings[0].path, /some-mcp-server/);
    },

    testUnknownEntryFieldWarns() {
        const result = parseBackendConfig(JSON.stringify({
            version: 1,
            backends: { 'image-host': { url: 'http://host:46680', platform: ['QQ'] } },
        }));
        assert.ok(result.config);
        assert.equal(result.warnings.length, 1);
        assert.match(result.warnings[0].path, /platform/);
    },

    testVersionRequired() {
        for (const bad of [{}, { version: 2 }, { version: '1' }]) {
            const result = parseBackendConfig(JSON.stringify({ ...bad, backends: {} }));
            assert.equal(result.config, null);
            assert.ok(result.issues.some(i => i.path === '$.version'));
        }
    },

    testRequiredUrlCannotBeEmpty() {
        for (const name of ['stream-output', 'image-url-to-base64', 'usage-chart', 'ob11-core-bridge']) {
            const result = parseBackendConfig(JSON.stringify({ version: 1, backends: { [name]: { url: '' } } }));
            assert.equal(result.config, null, name);
            assert.ok(result.issues.some(i => i.path === `$.backends.${name}.url`), name);
        }
    },

    testUrlSchemeCheckedPerBackend() {
        const httpAsWs = parseBackendConfig(JSON.stringify({
            version: 1,
            backends: { 'ob11-core-bridge': { url: 'http://bridge:46880/plugin' } },
        }));
        assert.equal(httpAsWs.config, null);
        const wsAsHttp = parseBackendConfig(JSON.stringify({
            version: 1,
            backends: { 'stream-output': { url: 'ws://stream:3010' } },
        }));
        assert.equal(wsAsHttp.config, null);
    },

    /** 所有后端都支持 token（4.27.0 起 token 是通用字段，不再按 image-host/ob11 白名单过滤） */
    testTokenAcceptedForAllBackends() {
        for (const name of BACKEND_NAMES) {
            const url = name === 'ob11-core-bridge'
                ? 'ws://bridge:46880/plugin'
                : (name === 'image-host' || name === 'media-fetch' ? '' : 'http://x.test:1');
            const result = parseBackendConfig(JSON.stringify({
                version: 1,
                backends: { [name]: { url, token: `t-${name}` } },
            }));
            assert.ok(result.config, `${name}: ${JSON.stringify(result.issues)}`);
            assert.equal(result.config!.backends[name]!.token, `t-${name}`, `${name} 的 token 应保留`);
            assert.equal(result.warnings.length, 0, `${name} 不应出现 token 忽略 warning`);
        }
    },

    testTokenMustBeString() {
        const result = parseBackendConfig(JSON.stringify({
            version: 1,
            backends: { 'image-host': { url: 'http://host:46680', token: 123 } },
        }));
        assert.equal(result.config, null);
    },

    testInvalidJsonFallsBackToDefaults() {
        setBackendConfig('{"version":1,"backends":');
        assert.deepEqual(Config.backend, DEFAULTS);
    },

    testTrailingCommasAndBomAccepted() {
        setBackendConfig('\uFEFF{\n  "version": 1,\n  "backends": {\n    "stream-output": { "url": "http://stream:3010", },\n  },\n}');
        assert.equal(Config.backend.STREAM, 'http://stream:3010');
    },

    testNoLegacyCompatibility() {
        // 不迁移、不兼容：旧键即使有自定义值，空的新配置也只使用出厂默认
        TC.stringConfigs['流式输出'] = 'http://legacy-stream:3010';
        TC.stringConfigs['图床'] = 'http://legacy-host:46680';
        TC.stringConfigs['图床Token'] = 'legacy-token';
        try {
            clearBackendConfig();
            assert.deepEqual(Config.backend, DEFAULTS);
        } finally {
            delete TC.stringConfigs['流式输出'];
            delete TC.stringConfigs['图床'];
            delete TC.stringConfigs['图床Token'];
            resetConfigCache();
        }
    },

    testNewConfigWinsOverOldKeys() {
        TC.stringConfigs['流式输出'] = 'http://legacy-stream:3010';
        try {
            setBackendConfig(JSON.stringify({
                version: 1,
                backends: { 'stream-output': { url: 'http://new-stream:3010' } },
            }));
            assert.equal(Config.backend.STREAM, 'http://new-stream:3010');
        } finally {
            delete TC.stringConfigs['流式输出'];
            clearBackendConfig();
        }
    },

    testResolveBackendEndpointsOrderAndDefaults() {
        const endpoints = resolveBackendEndpoints(null);
        assert.deepEqual(Object.keys(endpoints), BACKEND_NAMES);
        for (const name of BACKEND_NAMES) {
            assert.deepEqual(endpoints[name as keyof typeof endpoints], DEFAULT_BACKENDS[name as keyof typeof DEFAULT_BACKENDS]);
        }
    },

    testForumConfigMovedOutOfBackend() {
        TC.stringConfigs['论坛地址'] = 'https://forum.test';
        resetConfigCache();
        try {
            assert.equal(Config.forum.FORUM_URL, 'https://forum.test');
            assert.equal('FORUM_URL' in Config.backend, false, '论坛配置不应再出现在 Config.backend');
            assert.equal(Config.backend.STREAM, DEFAULTS.STREAM);
        } finally {
            delete TC.stringConfigs['论坛地址'];
            resetConfigCache();
        }
    },
};
