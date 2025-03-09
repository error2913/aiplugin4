# CHANGELOG

## [v4.5.14](https://github.com/error2913/aiplugin4/releases/tag/v4.5.14) - 2025-03-08 09:11:13

这是一个release

### Feature

- general:
  - 检查AI臆想多轮对话时，若角色是自己，则添加进回复中 ([905b705](https://github.com/error2913/aiplugin4/commit/905b705cff7b7d97402572d7d775899a16d659fb))
  - 对插件设置进行分区 ([3dc23f1](https://github.com/error2913/aiplugin4/commit/3dc23f111c32507dde9223a7376fcc6ab0b2de46))
  - 增加展示成员信息时的头衔展示 ([02345d7](https://github.com/error2913/aiplugin4/commit/02345d71c371502c1a1c5949243a741e2c8e30a2))
  - 增加提示词工程选项 ([74928b5](https://github.com/error2913/aiplugin4/commit/74928b537225c29b533f2efdecc7a67dd9178f8c))
  - feat ai tool timer ([0ab33f8](https://github.com/error2913/aiplugin4/commit/0ab33f8b29f5a583326fdace56b038d530ddb6c2))
  - feat ai tool ([aa29282](https://github.com/error2913/aiplugin4/commit/aa292823775050f7351dfd841ea64ffb4883158f))
  - feat ai 展示QQ号 ([4f8a8e6](https://github.com/error2913/aiplugin4/commit/4f8a8e67b686f45d8c8945f5306b2dd5ef24fc17))
  - 增加tool管理与使用 ([af7d0b9](https://github.com/error2913/aiplugin4/commit/af7d0b9b5760a61117033bbe803006442e8f9989))
  - 增加对deepseekR1的适配 ([9140cbf](https://github.com/error2913/aiplugin4/commit/9140cbffeebe8b0873fb362ed7d13f29854cc866))
  - memory Command ([1a51b14](https://github.com/error2913/aiplugin4/commit/1a51b141515916642e639d47f8cb9831dd05a570))
  - 增加记忆 ([7710047](https://github.com/error2913/aiplugin4/commit/77100473d017b1facacc0dcbbcf2c6be19cb54ad))
  - ai骰娘新增可以禁言别人 ([7b42afe](https://github.com/error2913/aiplugin4/commit/7b42afe05ddb2d7e214bbbe74c2f24573dd44923))
  - feat&fix: aiplugin4 ([ac5c2c2](https://github.com/error2913/aiplugin4/commit/ac5c2c2d0e1332ffd36216cc18989a4817a5aed9))
  - 添加牌堆可抽取名字自定义 ([207c1e1](https://github.com/error2913/aiplugin4/commit/207c1e1fbf03b72b3527330c4624350863c71636))
  - 新增了AI命令的prompt配置管理 ([63cf7d9](https://github.com/error2913/aiplugin4/commit/63cf7d9743fd6b52262304a9255a10cead7bd87b))
  - 新增复读相似度计算和对应配置项 ([37ae3b0](https://github.com/error2913/aiplugin4/commit/37ae3b054a676a53339990c5dc54f0c14ff65c0b))
  - 新增可以在示例对话，对应内容没填写的时候跳过角色 ([6b417f8](https://github.com/error2913/aiplugin4/commit/6b417f85da134aef1f797e41e6b30e4c1948b97b))
  - 新增了对话示例功能 ([7b7ebe6](https://github.com/error2913/aiplugin4/commit/7b7ebe6824df941f754a9af9e521d20ccf22c1da))
  - feat 权限展示相关 ([e683c7a](https://github.com/error2913/aiplugin4/commit/e683c7a6cc675db4fca9df8f0108715112a25b34))

- aiplugin4:
  - 实现人设切换 💯 #63 ([469a799](https://github.com/error2913/aiplugin4/commit/469a799ec077c571d66ba1b9f3f0aab838964aa0))
  - 增加token使用记录图表 #59 ([c513a99](https://github.com/error2913/aiplugin4/commit/c513a99521242d6c040fb90ebe245a3317df0986))
  - 增加删除过期token记录功能 #59 ([5804aa1](https://github.com/error2913/aiplugin4/commit/5804aa1c5de35fe5df4c69929dfb5da16cc09769))
  - 增加月份，日期记录 #59 ([0321a15](https://github.com/error2913/aiplugin4/commit/0321a1552900f5a8f7006f2c560a75997d26c06b))
  - 增加token使用记录相关 #59 ([10b7611](https://github.com/error2913/aiplugin4/commit/10b7611f9318cd166866f3941cdf4c031d8962c1))
  - 增加解析body时具体哪一项出错的显示 ([a1eab6a](https://github.com/error2913/aiplugin4/commit/a1eab6ada3438e839fe92d3407f8031331485393))
  - 增加打印日志选项 #57 ([5cbd869](https://github.com/error2913/aiplugin4/commit/5cbd869fb44767b4af072343d1d8b01f0b2c5ba4))
  - 添加自己设置触发条件的tool ([d78922e](https://github.com/error2913/aiplugin4/commit/d78922ed0bb2e0c6b8613c8e9f635bf7a49b2f65))
  - 构建messages时增加tool_call_id检查，`findxxxId`增加http检索 ([ae8e076](https://github.com/error2913/aiplugin4/commit/ae8e0763065eae917055b9e533bc6b668f2cc484))
  - 增加了展示群号，和根据群名在记忆中检索群号的功能 ([d65c736](https://github.com/error2913/aiplugin4/commit/d65c736a80f8afa81363e5cb93c29fa93d123e14))

- ai-image:
  - 添加url转base64功能 #51 ([2e3979a](https://github.com/error2913/aiplugin4/commit/2e3979aa67d1baf2dc33e2f7e3286aa02ccd0ecb))

- ai-tool:
  - 当tool_call缺少必需参数时，提示缺少的参数 ([6f2c553](https://github.com/error2913/aiplugin4/commit/6f2c553cb5ce7042f34918bcba080b16a8162c1f))
  - 增加全员禁言，查看禁言列表 ([e44c8c1](https://github.com/error2913/aiplugin4/commit/e44c8c163dc67171687c9405a2fd8b4798762be8))
  - 添加查看群头像的函数 ([277eda5](https://github.com/error2913/aiplugin4/commit/277eda5599f11dad88fd20d9005963c1ec8a6041))
  - 增加四项tool ([7dba201](https://github.com/error2913/aiplugin4/commit/7dba20175536d247b0556f6f51d84bc5b1ac0abe))
  - 增加远程调用函数的函数 ([1fad63c](https://github.com/error2913/aiplugin4/commit/1fad63ce03f285d2d92fea22f65855636c1859ae))
  - 添加查看其他对话上下文的函数 ([153169c](https://github.com/error2913/aiplugin4/commit/153169c1ba538302b6b52eb0a0b8d0076006e57e))
  - 新增了向其他对话中发送消息的功能 ([3718dbd](https://github.com/error2913/aiplugin4/commit/3718dbd0e42f32d1516cafb9f9c13fa0e6b26ef3))
  - 新增本地语音发送功能 ([291cc82](https://github.com/error2913/aiplugin4/commit/291cc82d77e5f56ef9de5149cec89114a2df9468))
  - 新增群打卡、查看个人资料的函数 ([1f085ed](https://github.com/error2913/aiplugin4/commit/1f085edb12b65bfac9ecc7c30fb84c90182b1a05))

- ai-cmd-memory:
  - 增加了查看群聊记忆的指令 ([b9e72db](https://github.com/error2913/aiplugin4/commit/b9e72dbecdcb77255c10ca5d3f74b068ec3c9b8a))

- ai-cmd-tool:
  - 新增所有函数的开关 ([ba3cc24](https://github.com/error2913/aiplugin4/commit/ba3cc24824881a8657b11ee9a2a39f3fde248d17))

### Bug Fixes

- general:
  - 修复回复引用时，有可能出现`msg.rawId`为空的情况 ([dcb2f20](https://github.com/error2913/aiplugin4/commit/dcb2f204bef69f99120cce23a622f52f56b4fdf2))
  - 修复gemini部分兼容问题 ([cfca316](https://github.com/error2913/aiplugin4/commit/cfca31632736896d2c7fd310a268d84bcce58f80))
  - 没有故乡映射表，暂不显示 ([358dd22](https://github.com/error2913/aiplugin4/commit/358dd22b2d637ee032c18689830db4af28bb5e50))
  - fix ai ([9dbfd02](https://github.com/error2913/aiplugin4/commit/9dbfd02cd3d51668224d875522b0a10a96b4f823))
  - 清除定时任务出错导致的空指针 ([89454ae](https://github.com/error2913/aiplugin4/commit/89454ae9ae5542cc1677f8a9696fbbd640bcb8f3))
  - aiplugin4记录上下文出错 ([79288c0](https://github.com/error2913/aiplugin4/commit/79288c0da93cff2e6e9c8010e111c251592b6ab2))
  - aiplugin4 ([873682d](https://github.com/error2913/aiplugin4/commit/873682da33e744edc07e04636b27e4523997e645))
  - 防止在处理tool_calls时插入user消息 ([d592684](https://github.com/error2913/aiplugin4/commit/d5926846483ec281065e268777a8aec0d4701139))
  - 修复ai调用函数失败时造成后续请求体格式出错400 ([fe1adac](https://github.com/error2913/aiplugin4/commit/fe1adaca66280e16305ccc11ea65bb7cf5f49391))
  - 复读检查 ([3d6b9f3](https://github.com/error2913/aiplugin4/commit/3d6b9f348801caf54a334c958861bdd8f27f271d))
  - 图片发送概率条件判断错误 ([1abeb57](https://github.com/error2913/aiplugin4/commit/1abeb57af2a83035c7e2321809d04295c24030fe))
  - 异常删除设定记忆 ([03fc587](https://github.com/error2913/aiplugin4/commit/03fc587099cbad6697f58b9584471da3a579aa69))
  - 默认配置项AI命令`记忆`重复 ([270b5d4](https://github.com/error2913/aiplugin4/commit/270b5d46fc53f6e2a077d26a726a8fe3208f8d6a))
  - ai骰娘：报错后没有返回导致的bug ([394d52b](https://github.com/error2913/aiplugin4/commit/394d52b2817ee85f8114d111999f6b6bd2bc79f3))
  - ai上下文缓存时间计算错误 ([01d7333](https://github.com/error2913/aiplugin4/commit/01d7333ac500876f5f22d1458d452b9cdc9f7563))
  - 图片储存上限配置项忘记注册 ([21e23b8](https://github.com/error2913/aiplugin4/commit/21e23b8fa6f6a19c2b10f02ccfaa6fc70f7614d0))
  - 模组相关指令bug ([ce7c5d6](https://github.com/error2913/aiplugin4/commit/ce7c5d628b4ce68a53a966eb7c156e7b55c267c4))
  - 杂项 ([c3ae2f4](https://github.com/error2913/aiplugin4/commit/c3ae2f4d02dfa12db655619e4eda0196f9cf231c))
  - AI指令相关注册应在配置项注册之前 ([d876ccd](https://github.com/error2913/aiplugin4/commit/d876ccdf6988281e28d00de37fd6833a3a9214d4))
  - fix ([6c55f32](https://github.com/error2913/aiplugin4/commit/6c55f32ea0a961d5c79eb08b1c24b63286a856f2))
  - 插嘴用不了 ([90a2673](https://github.com/error2913/aiplugin4/commit/90a2673223824a117c0dc9b4e26c33e4fc04a212))
  - AI命令的解析出错 ([0dd1298](https://github.com/error2913/aiplugin4/commit/0dd1298b01967fb04368035e0ac463432e78aeee))
  - fix ([8a92ccb](https://github.com/error2913/aiplugin4/commit/8a92ccbad2424a7063cbca32e8fc887d35c62364))

- aiplugin4:
  - 修复重复冗余记录定时器的问题 ([ee428dc](https://github.com/error2913/aiplugin4/commit/ee428dc8fd68ce038fe72d0603f23e72026f2f23))
  - 修复处理回复时，截断文本逻辑移到正则匹配后面的问题 ([681f733](https://github.com/error2913/aiplugin4/commit/681f733c2706b4fffd902a43118e6b8aa8ca8acf))
  - 修复清除过期记录后总数据不准的错误 ([fc02c79](https://github.com/error2913/aiplugin4/commit/fc02c7940d14f6f17651bff337ee7f427888ae1a))
  - 正则表达式书写问题，不影响使用 ([eeb7848](https://github.com/error2913/aiplugin4/commit/eeb7848473fbad61d37503f0cf9ccf6ac9bd32fd))
  - 修复token统计能被无关人士看到的问题 #59 ([3f1914d](https://github.com/error2913/aiplugin4/commit/3f1914dbdc83d03d4be594036e2abe4010388e3c))
  - 修复日志里显示忽略日志的问题 ([8ba0cba](https://github.com/error2913/aiplugin4/commit/8ba0cba21ed8ef31582c7c36cf7db134307960a4))
  - 修复无法触发的问题 ([ef1322f](https://github.com/error2913/aiplugin4/commit/ef1322f9e121b6ff64ebda7406cb253c87a8f0b6))
  - 尖括号错误写为"）" ([0ac5f58](https://github.com/error2913/aiplugin4/commit/0ac5f58fb32a60ca5e5389a8c8a2991d00abb8fd))
  - 修复ctx包含对应名字时`findxxId`函数找不到id的错误 ([410b9e3](https://github.com/error2913/aiplugin4/commit/410b9e31e18c047806ebd2a5dd85c5be0a417df9))
  - 多项修复 ([1bdbe00](https://github.com/error2913/aiplugin4/commit/1bdbe0035f45d0a6507942645678761d1c6020cd))

- ai-image:
  - 图片转base64“自动”情况下判断逻辑出错 #51 ([21f2e55](https://github.com/error2913/aiplugin4/commit/21f2e550ceadf18160448222a243faef439d26c4))

- ai-tool:
  - 修复检查必需属性逻辑错误 ([ddc0a01](https://github.com/error2913/aiplugin4/commit/ddc0a010108a769b8dfc601fed567bc868463347))
  - 修复使用get_context后，无法使用其中的图片的bug ([28269dc](https://github.com/error2913/aiplugin4/commit/28269dcf5713f873ae4de4ffd79621002ecd510a))
  - 修复`send_msg`不能发送图片的问题，修改部分函数的prompt ([674ea27](https://github.com/error2913/aiplugin4/commit/674ea27d30909395180d9e7e32b8ac1651abd577))
  - 修复可以调用禁止调用的函数的问题 ([ec4e099](https://github.com/error2913/aiplugin4/commit/ec4e0996f6834dcc2d66196585efb2f198bde43d))
  - 修复`remote_function_call`的必须参数和`solve`中的错误 ([90e6e8c](https://github.com/error2913/aiplugin4/commit/90e6e8c2514b53e94147f597aed4d266143851cb))

- ai-tool-send-msg:
  - 禁止给自己私聊发消息 ([d8e773c](https://github.com/error2913/aiplugin4/commit/d8e773ce47bee7a7a1f599d3976d71960db73af5))

### Documentation

- ai-image:
  - 添加新配置说明 ([db2f54c](https://github.com/error2913/aiplugin4/commit/db2f54cdba8f1972766f2743f9f31e25c2f028bb))

- aiplugin4:
  - 修改README ([e9e063c](https://github.com/error2913/aiplugin4/commit/e9e063c63fb88bafe8d9ab4f1ff440a810ad639c))

### Performance Improvements

- aiplugin4:
  - 删掉一个弃用的变量，调整识图默认prompt ([01a5530](https://github.com/error2913/aiplugin4/commit/01a5530308d52e39e21e3e6cbdb7cdb0b6c66edd))
  - 优化了进行请求后的错误信息展示 ([5418240](https://github.com/error2913/aiplugin4/commit/5418240c478aec7b811ed7bdb682777f3e5cbdd1))
  - header描述部分更改 ([b85116c](https://github.com/error2913/aiplugin4/commit/b85116ce769941f9fc11a3c2c4e55606f9f0a45e))

- ai-tool-tts:
  - 修改tts命名，使其命名风格保持一致 ([78899cd](https://github.com/error2913/aiplugin4/commit/78899cd8ef16c6e00ea47dc2ec02ef6116296b4d))

\* *This CHANGELOG was automatically generated by [auto-generate-changelog](https://github.com/BobAnkh/auto-generate-changelog)*
