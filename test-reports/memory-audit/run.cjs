// 记忆实验运行器：安装 seal 桩后加载打包产物
const path = require('node:path');
const { installSealEnv } = require(path.resolve(__dirname, '../../scripts/harness/seal-env.cjs'));
installSealEnv({ preset: 'unit', base64Prefix: '/tmp/aiplugin4-memory-audit-' });
require('./experiments.cjs');
