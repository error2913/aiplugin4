// SealDice 当前源码（sealdice-core，2026-08-18）内置扩展与核心命令的默认可调用清单。
// 命令别名也保留，确保 AI 传入任意 SealDice 可解析名称时都能通过白名单校验。
export const SEALDICE_COMMAND_WHITELIST = [
    // 核心命令（同一扩展元素内用 / 分隔别名，含 core 扩展中的 team）
    'core|black/ban', 'core|find/查询/査詢', 'core|help',
    'core|bot', 'core|dismiss', 'core|botlist', 'core|master',
    'core|roll/r/rd/rh/rhd/rdh/rx/rxh/rhx',
    'core|ext', 'core|nn', 'core|userid', 'core|randalgo', 'core|set',
    'core|角色/ch/char/character/pc', 'core|st/cst', 'core|reply', 'core|team',

    // fun
    'fun|alias', 'fun|&/a', 'fun|ping', 'fun|send', 'fun|welcome', 'fun|gugu/咕咕',
    'fun|jrrp', 'fun|text', 'fun|rsr', 'fun|ek/ekgen', 'fun|dx',
    'fun|w/ww/dxh/wh/wwh', 'fun|jsr', 'fun|drl/drlh', 'fun|check',

    // story
    'story|name', 'story|namednd', 'story|who', 'story|cnmods/modu/魔都',

    // coc7
    'coc7|en', 'coc7|setcoc', 'coc7|ti', 'coc7|li',
    'coc7|ra/rc/rch/rah/cra/crc/crch/crah', 'coc7|rav/rcv', 'coc7|sc',
    'coc7|coc', 'coc7|st/cst',

    // deck
    'deck|draw/deck',

    // dnd5e
    'dnd5e|dnd/dndx', 'dnd5e|ri', 'dnd5e|init', 'dnd5e|st/dst',
    'dnd5e|rc/ra/rah/rch/drc', 'dnd5e|buff/dbuff',
    'dnd5e|spellslots/ss/dss/法术位', 'dnd5e|cast/dcast',
    'dnd5e|长休/longrest/dlongrest', 'dnd5e|ds/死亡豁免',

    // log
    'log|log', 'log|stat/hiy', 'log|ob', 'log|sn'
];

// 默认技能：仅保留「录卡」。
// SealDice 核心/扩展指令与 OB11 API 的调用帮助已改写为默认知识库（见 knowledge_base_defaults.ts：
// 「核心指令」「扩展指令」「ob11-api(仅 QQ)」），不再作为技能默认值。
export const SEALDICE_COMMAND_SKILLS = [
    `---
name: 录卡
description: 从角色卡 Excel 表格提取可直接执行的 .st 命令，并通过 SealDice 核心录入角色卡
---
目标：把用户提供的角色卡表格录入当前群/私聊上下文对应的 SealDice 角色卡。优先使用表格已经生成的完整 .st 导入命令，不要凭空重排或猜测属性。

一、读取文件
1. 先从当前消息的文件字段中取得真实路径或 URL（优先 path/file/url，其次 file_id）；只有文件名而没有可访问路径时，明确提示用户重新发送文件或提供路径，不要猜测本地位置。
2. 对 .xlsx/.xlsm 文件，使用 mcp-files-exec 的 read_file 或 run_shell 配合 Python/openpyxl/LibreOffice 读取；先列出工作表，优先选择名称为“简化卡 骰娘导入”、包含“简化卡”或“骰娘导入”的工作表，其次选择 Sheet2/第二个工作表。D:\COC\空白卡 下的模板仅用于识别布局，不能替代用户实际上传的角色卡。
3. 读取公式结果时优先取已计算的缓存值；缓存为空时用 LibreOffice headless 重算后再读。不要把公式文本本身当作 .st 参数。

二、提取 .st
1. 扫描优先工作表的所有单元格（包括公式计算结果、富文本/换行文本），寻找以 .st 开头的完整命令；允许前后空白和全角空格，但必须保留命令原文中的字段顺序、等号、加减号、括号和分隔符。
2. 优先选择完整的角色卡导入命令（包含角色名及多个属性），排除“.st show/.st clr/.st rm”等查询、清理或局部修改命令。若表格生成多个 .st 行，按表格顺序执行；执行前先向用户展示将执行的命令摘要并确认角色名，避免覆盖错误角色。
3. 录入使用核心工具 run_core_command，不要使用 run_ext_command：
   {"action":"call","raw_message":".st …","forward":true}
   raw_message 与 command/args 不能同时传。forward 未提供时默认也是 true；如用户要求静默再显式传 false。
4. 命令返回后用 run_core_command 再执行核心 st 查询确认（通常为 {"action":"call","command":"st","args":["show"]}），检查角色名和关键属性是否已写入；失败时不要盲目重复执行，先报告核心返回。

三、没有可用 .st 时的回退
1. 先确认角色名，再调用核心角色管理：{"action":"call","command":"pc","args":["new","角色名"],"forward":true}。若角色已存在，不要覆盖，先用 pc list/st show 查询并请求确认。
2. 新建成功后，把表格中的可识别属性按核心 st 语法分批设置，仍使用 run_core_command(command="st", args=[…])；未知字段、公式未解析或无法映射的字段列为待人工处理，不要猜值。
3. 最后再次执行 st show 验证。回复用户时报告：文件、工作表、是否找到直接 .st、角色名、执行结果和未录入字段。`
];
