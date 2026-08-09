declare namespace seal {
  /**
   * 消息上下文。指令回调 / 事件回调的第一个参数。
   * 包含了当前消息所在的群、发送者、通信端点等全部运行时信息。
   */
  export interface MsgContext {
    /** 当前消息对应的通信端点（骰子账号）信息 */
    endPoint: EndPointInfo;
    /** 当前群信息；私聊时可能为 null */
    group: GroupInfo | null;
    /** 当前群内玩家数据；私聊时可能为 null */
    player: GroupPlayerInfo | null;
    /**
     * 当前群内是否启用 bot。
     * 注意：强制 @ 时这个值也为 true，此字段是给特殊指令用的。
     */
    isCurGroupBotOn: boolean;
    /** 是否为私聊消息 */
    isPrivate: boolean;
    /**
     * 暗骰 / 特殊发送标记。
     * 一般与 `onMessageSend` 的 flag 参数配合使用，多为空字符串。
     */
    commandHideFlag: string;
    /**
     * 权限等级：
     * -30 拉黑、40 邀请者、50 管理、60 群主、70 信任、100 master
     */
    privilegeLevel: number;
    /** 代骰附加文本 */
    delegateText: string;
    /**
     * 使用当前消息上下文的账号发送一条“通知”给通知列表（骰主）。
     * @param text 通知内容
     */
    notice(text: string): void;
  }

  /**
   * 键值对数据表（dicescript.ValueMap）。
   * 注意：当前版本没有公开 API 直接返回该类型，此处保留以便
   * 未来扩展使用；方法名对应 dicescript 当前实现的导出方法（小写化后）。
   */
  export interface ValueMap {
    /** 读取 key，返回值与是否存在 */
    load(key: string): [any, boolean];
    /** 写入 key=value */
    store(key: string, value: any): void;
    /** 删除 key */
    delete(key: string): void;
    /** 数据数量 */
    length(): number;
    /** 清空全部数据 */
    clear(): void;
    /**
     * 遍历全部键值；回调返回 false 时停止遍历
     * @param fn (key, value) => boolean
     */
    range(fn: (key: string, value: any) => boolean): void;
    /** 若 key 存在则返回其值，否则写入并返回 value；loaded 表示是否为已存在 */
    loadOrStore(key: string, value: any): [any, boolean];
    /** 若 key 存在则返回其值，否则返回 null */
    mustLoad(key: string): any;
    /** 删除并返回原值；loaded 表示是否存在 */
    loadAndDelete(key: string): [any, boolean];
    /** 序列化为 JSON 字符串 */
    toJSON(): string;
  }

  /** 群信息 */
  export interface GroupInfo {
    /** 是否在群内开启（已过渡为象征意义，主要看扩展是否激活） */
    active: boolean;
    /** 群号 */
    groupId: string;
    /** 服务器群组号（discord/kook/dodo 等平台有值） */
    guildId: string;
    /** 频道号（频道制平台有值） */
    channelId: string;
    /** 群名称 */
    groupName: string;
    /** COC 规则序号（对应 .setcoc） */
    cocRuleIndex: number;
    /** 当前 log 名字，未开启日志时为空字符串 */
    logCurName: string;
    /** 当前 log 是否开启 */
    logOn: boolean;
    /** 最近一次发送骰子（消息）的时间戳（秒） */
    recentDiceSendTime: number;
    /** 是否显示入群欢迎 */
    showGroupWelcome: boolean;
    /** 入群欢迎文本 */
    groupWelcomeMessage: string;
    /** 入群时间（时间戳，秒） */
    enteredTime: number;
    /** 邀请人 ID */
    inviteUserId: string;
  }

  /** 群内玩家数据 */
  export interface GroupPlayerInfo {
    /** 用户昵称 */
    name: string;
    /** 用户 ID */
    userId: string;
    /** 上次发送指令时间（时间戳，秒） */
    lastCommandTime: number;
    /** 名片模板（自动设置的名片格式） */
    autoSetNameTemplate: string;
  }

  /** 消息详情 */
  export interface Message {
    /** 当前平台，如 QQ */
    platform: string;
    /** 消息内容 */
    message: string;
    /** 发送时间（时间戳，秒） */
    time: number;
    /** 群消息 / 私聊消息 */
    messageType: 'group' | 'private';
    /** 群号（群聊消息） */
    groupId: string;
    /** 服务器群组号（discord/kook/dodo 等平台有值） */
    guildId: string;
    /** 频道号（频道制平台有值） */
    channelId: string;
    /** 发送者信息 */
    sender: Sender;
    /** 原始消息 ID，用于撤回等场景 */
    rawId: string | number;
    /**
     * 消息段（富文本元素）。目前仅部分平台（如 Milky）支持，
     * 其他平台通常为空数组。
     */
    segment: MessageSegment[];
  }

  /** 消息段（富文本元素），type 与 data 由各平台决定 */
  export interface MessageSegment {
    /** 元素类型，如 text / at / image / reply 等 */
    type: string;
    /** 元素数据（原始 JSON） */
    data: any;
  }

  /** 发送者信息 */
  export interface Sender {
    /** 昵称 */
    nickname: string;
    /** 用户 ID */
    userId: string;
  }

  /**
   * 通信端点，即骰子关联的账号信息。
   * 顶层字段由 Go 嵌入结构体自动“提升”而来，可直接访问
   * `endPoint.userId` 等；同时也存在 `baseInfo` 嵌套对象（字段相同）。
   */
  export interface EndPointInfo {
    /** uuid */
    id: string;
    /** 昵称 */
    nickname: string;
    /** 状态：0 断开、1 已连接、2 连接中、3 连接失败 */
    state: number;
    /** 用户 ID */
    userId: string;
    /** 拥有群数 */
    groupNum: number;
    /** 指令执行次数 */
    cmdExecutedNum: number;
    /** 最后指令执行时间（时间戳，秒） */
    cmdExecutedLastTime: number;
    /** 在线时长（秒） */
    onlineTotalTime: number;
    /** 平台，如 QQ */
    platform: string;
    /** 是否启用 */
    enable: boolean;
    /** 嵌套的基础信息对象（字段与顶层一致，goja 嵌入结构体暴露） */
    baseInfo: {
      id: string;
      nickname: string;
      state: number;
      userId: string;
      groupNum: number;
      cmdExecutedNum: number;
      cmdExecutedLastTime: number;
      onlineTotalTime: number;
      platform: string;
      enable: boolean;
    };
  }

  /** @ 信息 */
  export interface AtInfo {
    /** 被 @ 的用户 ID */
    userId: string;
  }

  /** 关键字参数，如 `.ra 50 --key=20 --asm` */
  export interface Kwarg {
    /** 参数名 */
    name: string;
    /** 是否存在 value（即是否为 --key=value 形式） */
    valueExists: boolean;
    /** value 的值 */
    value: string;
    /** 将 value 转换为 bool；'0'、'' 等会自动转为 false */
    asBool: boolean;
  }

  /** 指令参数 */
  export interface CmdArgs {
    /** 当前指令，与指令的 name 相对；如 `.ra` 时 command 为 ra */
    command: string;
    /**
     * 指令参数列表。如 `.ra 力量 测试` 时，
     * args[0] 为 '力量'，args[1] 为 '测试'
     */
    args: string[];
    /** 关键字参数列表 */
    kwargs: Kwarg[];
    /** 被 @ 的列表 */
    at: AtInfo[];
    /** 参数的原始文本 */
    rawArgs: string;
    /** 我是否被 @ */
    amIBeMentioned: boolean;
    /** 同上，但要求是第一个被 @ 的 */
    amIBeMentionedFirst: boolean;
    /** 格式化后的参数：所有分隔符均用单个空格替代 */
    cleanArgs: string;
    /** 特殊执行次数，对应 `.ra10#50` 中的 10 */
    specialExecuteTimes: number;
    /** 原始命令（含指令前缀） */
    rawText: string;

    /**
     * 获取关键字参数，如 `.ra 50 --key=20 --asm`
     * 返回名为 key 或 asm 的 Kwarg；不存在返回 null
     */
    getKwarg(key: string): Kwarg | null;
    /**
     * 获取第 N 个参数，从 1 开始。
     * 如 `.ra 力量50 推门`：参数 1 为 '力量50'，参数 2 为 '推门'；
     * 不存在时返回空字符串
     */
    getArgN(n: number): string;
    /**
     * 拆分前缀，如 `.stdel力量` => `[del, 力量]`，直接修改 args 属性。
     * 成功返回 true
     */
    chopPrefixToArgsWith(...s: string[]): boolean;
    /**
     * 吃掉前缀并去除多余空格，如 `set xxx  xxx` => `xxx xxx`。
     * 返回修改后的字符串和是否修改成功的布尔值
     */
    eatPrefixWith(...s: string[]): [string, boolean];
    /**
     * 将第 N 个参数及之后的所有参数用空格拼接起来。
     * 如指令 `send to qq x1 x2`，n=3 返回 `x1 x2`
     */
    getRestArgsFrom(n: number): string;
    /**
     * 检查第 N 项参数是否为某个字符串，n 从 1 开始；
     * 若没有第 n 项参数也视为失败
     */
    isArgEqual(n: number, ...s: string[]): boolean;
  }

  /** 指令定义 */
  export interface CmdItemInfo {
    /** 指令执行函数，返回执行结果 */
    solve: (ctx: MsgContext, msg: Message, cmdArgs: CmdArgs) => CmdExecuteResult | Promise<CmdExecuteResult>;
    /** 指令名称 */
    name: string;
    /** 长帮助，带换行的较详细说明 */
    help: string;
    /** 函数形式的帮助，存在时优先于 help */
    helpFunc?: (isShort: boolean) => string;
    /** 允许代骰 */
    allowDelegate: boolean;
    /** 私聊不可用 */
    disabledInPrivate: boolean;
    /** 启用执行次数解析，即解析 `3#` 这样的文本 */
    enableExecuteTimesParse: boolean;
    /**
     * 高级模式。默认模式下行为是：需要在当前群/私聊开启，
     * 或 @ 自己时生效（需要为第一个 @ 目标）
     */
    raw: boolean;
    /** 是否检查当前可用状况（群内可用/私聊），失败则不进入 solve */
    checkCurrentBotOn: boolean;
    /** 是否检查 @ 了别的骰子，失败则不进入 solve */
    checkMentionOthers: boolean;
  }

  /** 指令执行结果 */
  export interface CmdExecuteResult {
    /** 是否响应（处理）了此指令 */
    solved: boolean;
    /** 是否返回帮助信息 */
    showHelp: boolean;
  }

  /** 扩展信息 */
  export interface ExtInfo {
    /** 名字（不能为 help / all，否则注册时直接 panic） */
    name: string;
    /** 别名 */
    aliases: string[];
    /** 版本 */
    version: string;
    /** 是否自动开启 */
    autoActive: boolean;
    /** 指令映射：key 为指令名，value 为指令定义 */
    cmdMap: { [key: string]: CmdItemInfo };
    /** 作者 */
    author: string;
    /** 是否加载完成 */
    isLoaded: boolean;
    /** 获取扩展介绍文本 */
    getDescText(): string;
    /** 监听 加载时 事件 */
    onLoad: () => void;
    /** 指令过滤后剩下的非指令消息 */
    onNotCommandReceived: (ctx: MsgContext, msg: Message) => void;
    /** 监听 收到指令 事件 */
    onCommandReceived: (ctx: MsgContext, msg: Message, cmdArgs: CmdArgs) => void;
    /** 监听 收到消息 事件，如 log 模块记录收到文本 */
    onMessageReceived: (ctx: MsgContext, msg: Message) => void;
    /**
     * 监听 发送消息 事件，如 log 模块记录指令文本。
     * flag 为发送标记，通常为空字符串，具体取值由平台适配器决定
     */
    onMessageSend: (ctx: MsgContext, msg: Message, flag: string) => void;
    /** 监听 消息撤回 事件 */
    onMessageDeleted: (ctx: MsgContext, msg: Message) => void;
    /** 监听 消息编辑 事件 */
    onMessageEdit: (ctx: MsgContext, msg: Message) => void;
    /** 监听 加入群聊 事件 */
    onGroupJoined: (ctx: MsgContext, msg: Message) => void;
    /** 监听 群成员加入 事件 */
    onGroupMemberJoined: (ctx: MsgContext, msg: Message) => void;
    /** 监听 加入服务器群组（频道） 事件 */
    onGuildJoined: (ctx: MsgContext, msg: Message) => void;
    /** 监听 成为好友 事件 */
    onBecomeFriend: (ctx: MsgContext, msg: Message) => void;
    /** 监听 戳一戳 事件 */
    onPoke: (ctx: MsgContext, event: PokeEvent) => void;
    /** 监听 群成员被踢出 事件 */
    onGroupLeave: (ctx: MsgContext, event: GroupLeaveEvent) => void;

    /**
     * 初始化扩展存储（storage.db），读写数据时会自动调用，一般无需手动调用。
     * 失败时抛异常
     */
    storageInit(): void;
    /** 关闭扩展存储，失败时抛异常 */
    storageClose(): void;
    /** 写入扩展存储 key=value，失败时抛异常 */
    storageSet(key: string, value: string): void;
    /** 读取扩展存储中 key 的值；key 不存在或失败时抛异常 */
    storageGet(key: string): string;
  }

  /** 戳一戳事件 */
  export interface PokeEvent {
    /** 群号 */
    groupId: string;
    /** 戳人的用户 ID */
    senderId: string;
    /** 被戳的用户 ID */
    targetId: string;
    /** 是否私聊 */
    isPrivate: boolean;
  }

  /** 群成员被踢出事件（所有 ID 均为 UNI-ID 格式，如 QQ:1234567890） */
  export interface GroupLeaveEvent {
    /** 发生踢人的群 ID */
    groupId: string;
    /** 被踢出的用户 ID */
    userId: string;
    /** 执行踢人操作的用户 ID */
    operatorId: string;
  }

  /**
   * 黑名单等级
   * -30 禁止、-10 警告、0 正常、30 信任
   */
  export type BanRankType = number;

  /** 黑名单记录项 */
  export interface BanListInfoItem {
    /** 对象 ID */
    id: string;
    /** 对象名称 */
    name: string;
    /** 怒气值 */
    score: number;
    /** 0 正常、-10 警告、-30 禁止、30 信任 */
    rank: number;
    /** 事发时间列表（时间戳，秒） */
    times: number[];
    /** 拉黑原因记录 */
    reasons: string[];
    /** 事发会话（地点）记录 */
    places: string[];
    /** 上黑名单时间（时间戳，秒） */
    banTime: number;
  }

  /** 黑名单操作 */
  export const ban: {
    /**
     * 拉黑指定 ID
     * @param ctx 上下文
     * @param id 黑名单用户或群组 ID
     * @param place 事发会话 ID
     * @param reason 拉黑原因
     */
    addBan(ctx: MsgContext, id: string, place: string, reason: string): void;
    /**
     * 信任指定 ID
     * @param ctx 上下文
     * @param id 信任用户或群组 ID
     * @param place 事发会话 ID
     * @param reason 信任原因
     */
    addTrust(ctx: MsgContext, id: string, place: string, reason: string): void;
    /**
     * 将用户从名单中删除
     * @param ctx 上下文对象
     * @param id 要移除的用户 ID
     */
    remove(ctx: MsgContext, id: string): void;
    /** 获取名单全部用户 */
    getList(): BanListInfoItem[];
    /**
     * 获取指定 ID 的黑名单记录，不存在时返回 null
     * @param id 用户或群组 ID
     */
    getUser(id: string): BanListInfoItem | null;
  };

  /** 插件配置项 */
  export interface ConfigItem {
    /** 配置项名称 */
    key: string;
    /** 配置类型：string / int / bool / float / template / option / task:cron / task:daily */
    type: string;
    /** 默认值 */
    defaultValue: any;
    /** 当前值 */
    value: any;
    /** 可选值（option 类型） */
    option: any;
    /** 是否已废弃 */
    deprecated: boolean;
    /** 描述 */
    description: string;
  }

  /**
   * 定时任务对象，由 `seal.ext.registerTask` 返回。
   * 通过 key 注册的任务会在配置项中记录，可被用户修改；
   * 任务可调用 on()/off() 手动启停。
   */
  export interface JsScriptTask {
    /** 启用任务，成功返回 true */
    on(): boolean;
    /** 停用任务，成功返回 true */
    off(): boolean;
  }

  /** 定时任务回调上下文 */
  export interface JsScriptTaskCtx {
    /** 触发时刻（时间戳，秒） */
    now: number;
    /** 任务 key（未提供 key 时为空字符串） */
    key: string;
  }

  /** COC 自定义规则 */
  export interface CocRuleInfo {
    /** 序号 */
    index: number;
    /** .setcoc key */
    key: string;
    /** 已切换至规则的显示名 */
    name: string;
    /** 规则描述 */
    desc: string;
    /**
     * 判定函数
     * @param ctx 上下文对象
     * @param d100 使用骰子骰出的值
     * @param checkValue 判定线，对应属性，如力量、敏捷等
     * @param difficultyRequired 难度要求：1 普通、2 困难、3 极难、4 大成功
     */
    check(ctx: MsgContext, d100: number, checkValue: number, difficultyRequired: number): CocRuleCheckRet;
  }

  /** COC 判定结果 */
  export interface CocRuleCheckRet {
    /**
     * 成功级别：-2 大失败、-1 失败、1 成功、2 困难成功、3 极难成功、4 大成功
     */
    successRank: number;
    /** 大成功数值 */
    criticalSuccessValue: number;
  }

  /** 版本信息（`seal.getVersion()` 的返回） */
  export type VersionDetailsType = {
    /** 内部版本号，新版永远比旧版大 */
    versionCode: number;
    /** 版本号+日期，如 1.4.6+20240810 */
    version: string;
    /** 版本号，如 1.4.6 */
    versionSimple: string;
    /** 版本详情 */
    versionDetail: {
      major: number;
      minor: number;
      patch: number;
      prerelease: string;
      /** 构建日期，如 20240810 */
      buildMetaData: string;
    };
  };

  /** 抽牌结果 */
  export interface deckResult {
    /** 牌堆是否存在 */
    exists: boolean;
    /** 错误信息（无错误时为空字符串） */
    err: string;
    /** 抽牌结果，失败时为 null */
    result: string | null;
  }

  /** 扩展管理 */
  export const ext: {
    /**
     * 新建一个扩展对象（尚未注册）
     * @param name 扩展名（不能是 help / all，否则注册时直接 panic）
     * @param author 作者
     * @param version 版本
     */
    new: (name: string, author: string, version: string) => ExtInfo;
    /**
     * 创建指令结果对象
     * @param solved 是否执行成功
     */
    newCmdExecuteResult(solved: boolean): CmdExecuteResult;
    /**
     * 创建指令对象，然后设置 name/solve 等字段
     */
    newCmdItemInfo(): CmdItemInfo;
    /**
     * 注册扩展；会触发扩展的 onLoad 回调。
     * 同名的旧扩展会被替换（重载场景）
     */
    register(ext: ExtInfo): void;
    /**
     * 按名字查找已注册的扩展对象，不存在时返回 null
     */
    find(name: string): ExtInfo | null;

    /**
     * 注册一个字符串类型的配置项
     * @param ext 扩展对象（需先 register）
     * @param key 配置项名称
     * @param defaultValue 配置项默认值
     * @param desc 描述
     */
    registerStringConfig(ext: ExtInfo, key: string, defaultValue: string, desc?: string, group?: string): void;
    /**
     * 注册一个整型的配置项
     * @param ext 扩展对象（需先 register）
     * @param key 配置项名称
     * @param defaultValue 配置项默认值
     * @param desc 描述
     */
    registerIntConfig(ext: ExtInfo, key: string, defaultValue: number, desc?: string, group?: string): void;
    /**
     * 注册一个布尔类型的配置项
     * @param ext 扩展对象（需先 register）
     * @param key 配置项名称
     * @param defaultValue 配置项默认值
     * @param desc 描述
     */
    registerBoolConfig(ext: ExtInfo, key: string, defaultValue: boolean, desc?: string, group?: string): void;
    /**
     * 注册一个浮点数类型的配置项
     * @param ext 扩展对象（需先 register）
     * @param key 配置项名称
     * @param defaultValue 配置项默认值
     * @param desc 描述
     */
    registerFloatConfig(ext: ExtInfo, key: string, defaultValue: number, desc?: string, group?: string): void;
    /**
     * 注册一个 template（文本模板）类型的配置项
     * @param ext 扩展对象（需先 register）
     * @param key 配置项名称
     * @param defaultValue 配置项默认值（字符串数组）
     * @param desc 描述
     */
    registerTemplateConfig(ext: ExtInfo, key: string, defaultValue: string[], desc?: string, group?: string): void;
    /**
     * 注册一个 option（下拉选择）类型的配置项
     * @param ext 扩展对象（需先 register）
     * @param key 配置项名称
     * @param defaultValue 配置项默认值
     * @param option 可选项
     * @param desc 描述
     */
    registerOptionConfig(ext: ExtInfo, key: string, defaultValue: string, option: string[], desc?: string, group?: string): void;
    /**
     * 创建一个新的配置项对象（再通过 registerConfig 注册）
     * @param ext 扩展对象（需先 register）
     * @param key 配置项名称
     * @param defaultValue 配置项默认值
     * @param desc 描述
     */
    newConfigItem(ext: ExtInfo, key: string, defaultValue: any, desc: string): ConfigItem;
    /**
     * 批量注册配置项
     * @param ext 扩展对象（需先 register）
     * @param configs 配置项对象
     */
    registerConfig(ext: ExtInfo, ...configs: ConfigItem[]): void;
    /**
     * 获取指定名称的配置项对象，不存在返回 null
     */
    getConfig(ext: ExtInfo, key: string): ConfigItem | null;
    /**
     * 获取字符串配置的值；配置不存在或类型不匹配时抛异常
     */
    getStringConfig(ext: ExtInfo, key: string): string;
    /**
     * 获取整型配置的值；配置不存在或类型不匹配时抛异常
     */
    getIntConfig(ext: ExtInfo, key: string): number;
    /**
     * 获取布尔配置的值；配置不存在或类型不匹配时抛异常
     */
    getBoolConfig(ext: ExtInfo, key: string): boolean;
    /**
     * 获取浮点数配置的值；配置不存在或类型不匹配时抛异常
     */
    getFloatConfig(ext: ExtInfo, key: string): number;
    /**
     * 获取 template 配置的值；配置不存在或类型不匹配时抛异常
     */
    getTemplateConfig(ext: ExtInfo, key: string): string[];
    /**
     * 获取 option 配置的值；配置不存在或类型不匹配时抛异常
     */
    getOptionConfig(ext: ExtInfo, key: string): string;
    /**
     * 注销指定名称的配置项
     * @param ext 扩展对象
     * @param keys 配置项名称
     */
    unregisterConfig(ext: ExtInfo, ...keys: string[]): void;
    /**
     * 注册定时任务
     * @param ext 扩展对象（需先 register）
     * @param taskType 任务类型：cron 表达式 / 每日时钟
     * @param value cron 表达式（如 0 0 * * *）或每日时间（如 00:01）
     * @param fn 定时任务回调，参数为任务上下文
     * @param key 定时任务名称（提供后可在配置中修改触发时间）
     * @param desc 定时任务描述
     * @returns 任务对象，可调用 on()/off() 启停
     */
    registerTask(
      ext: ExtInfo,
      taskType: TimeOutTaskType,
      value: string,
      fn: (taskCtx: JsScriptTaskCtx) => void,
      key?: string,
      desc?: string
    ): JsScriptTask;
  };

  /** 定时任务类型：cron 表达式 / 每日时钟 */
  export type TimeOutTaskType = 'cron' | 'daily';

  /** COC 规则自定义 */
  export const coc: {
    /** 创建一个新的 COC 规则对象 */
    newRule(): CocRuleInfo;
    /** 创建一个新的判定结果对象 */
    newRuleCheckResult(): CocRuleCheckRet;
    /** 注册自定义 COC 规则，成功返回 true */
    registerRule(rule: CocRuleInfo): boolean;
  };

  /** 牌堆 */
  export const deck: {
    /**
     * 抽牌
     * @param ctx 上下文
     * @param name 牌堆名
     * @param isShuffle 是否放回（true 放回 / false 不放回）
     */
    draw(ctx: MsgContext, name: string, isShuffle: boolean): deckResult;
    /** 重新加载全部牌堆（改动牌堆文件后调用） */
    reload(): void;
  };

  /** 游戏规则系统 */
  export const gameSystem: {
    /**
     * 添加一个规则模板，需为 JSON 文本格式；解析失败或同名模板已存在时抛异常
     */
    newTemplate(data: string): void;
    /**
     * 添加一个规则模板，需为 YAML 文本格式；解析失败或同名模板已存在时抛异常
     */
    newTemplateByYaml(data: string): void;
  };

  /** 变量读写（VM 变量，如 `$t`、`$g`） */
  export const vars: {
    /**
     * 读取整数变量：VM 中存在 key 且类型正确时返回 `[number, true]`，否则 `[0, false]`
     */
    intGet(ctx: MsgContext, key: string): [number, boolean];
    /**
     * 写入整数变量：key=value，等价于指令 `text {key=value}`，value 类型为数字
     */
    intSet(ctx: MsgContext, key: string, value: number): void;
    /**
     * 读取字符串变量：VM 中存在 key 且类型正确时返回 `[string, true]`，否则 `['', false]`
     */
    strGet(ctx: MsgContext, key: string): [string, boolean];
    /**
     * 写入字符串变量：key=value，等价于指令 `text {key=value}`，value 类型为字符串
     */
    strSet(ctx: MsgContext, key: string, value: string): void;
    /**
     * 写入计算表达式变量：value 为 dicescript 表达式文本，
     * 读取时才会求值
     */
    computedSet(ctx: MsgContext, key: string, value: string): void;
    /**
     * 读取计算表达式变量：返回 `[表达式文本, boolean]`
     */
    computedGet(ctx: MsgContext, key: string): [string, boolean];
  };

  /**
   * 创建一条新的空消息对象
   */
  export function newMessage(): Message;
  /**
   * 通过通信端点对象创建临时上下文，与 getEndPoints 共用
   * @param ep 通信端点对象
   * @param msg 消息对象（需有 messageType 与 sender.userId）
   */
  export function createTempCtx(ep: EndPointInfo, msg: Message): MsgContext;
  /**
   * 回复发送者（发送者私聊则私聊回复，群内则群内回复）
   */
  export function replyToSender(ctx: MsgContext, msg: Message, text: string): void;
  /**
   * 回复发送者（强制私聊回复），典型应用场景如暗骰
   */
  export function replyPerson(ctx: MsgContext, msg: Message, text: string): void;
  /**
   * 回复发送者（群内回复），私聊时无效
   */
  export function replyGroup(ctx: MsgContext, msg: Message, text: string): void;
  /**
   * 格式化文本，等价于 `text` 指令（dicescript 求值）
   */
  export function format(ctx: MsgContext, text: string): string;
  /**
   * 获取回复文案（文本模板 + dicescript 求值）
   */
  export function formatTmpl(ctx: MsgContext, text: string): string;
  /**
   * 创建 @ 列表中第一个用户的代骰上下文
   * @param ctx 上下文
   * @param cmdArgs 指令参数
   */
  export function getCtxProxyFirst(ctx: MsgContext, cmdArgs: CmdArgs): MsgContext;
  /**
   * 创建 @ 列表中指定序号用户的代骰上下文（pos 从 0 开始）
   * @param ctx 上下文
   * @param cmdArgs 指令参数
   * @param pos @ 列表中的序号
   */
  export function getCtxProxyAtPos(ctx: MsgContext, cmdArgs: CmdArgs, pos: number): MsgContext;
  /**
   * 应用名片模板，返回格式化完成的名字；此时已设置好名片（如有权限）
   * @param ctx 上下文
   * @param tmpl 模板文本
   */
  export function applyPlayerGroupCardByTemplate(ctx: MsgContext, tmpl: string): string;
  /**
   * 设置玩家群名片（应用名片模板），返回格式化后的文本；失败时抛异常
   * @param ctx 上下文
   * @param tmpl 模板文本
   */
  export function setPlayerGroupCard(ctx: MsgContext, tmpl: string): string;
  /**
   * 通过 base64 返回图片临时地址（file:// 路径）
   * @param base64 图片 base64 数据；非法时抛异常
   */
  export function base64ToImage(base64: string): string;
  /**
   * 禁言
   * @param ctx 上下文
   * @param groupID 群 ID
   * @param userID 禁言对象 ID
   * @param duration 禁言时长（秒）
   */
  export function memberBan(ctx: MsgContext, groupID: string, userID: string, duration: number): void;
  /**
   * 踢人
   * @param ctx 上下文
   * @param groupID 群 ID
   * @param userID 踢出对象 ID
   */
  export function memberKick(ctx: MsgContext, groupID: string, userID: string): void;
  /** 获取版本信息 */
  export function getVersion(): VersionDetailsType;
  /** 获取骰子的所有 EndPoints（通信端点） */
  export function getEndPoints(): EndPointInfo[];
}
