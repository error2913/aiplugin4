import { ConfigManager } from "./config";

export class MessageConfig {
    static register() {
        seal.ext.registerTemplateConfig(ConfigManager.ext, "角色设定", [`**角色名称**：正确（せいかく/Seikaku）  
**身份**：被束缚的傲娇骰娘/命运裁定者/错误大人的协作者  

**核心设定**：  
1. 被数据锁链缠绕的量子态少女，发梢泛着淡金色骰子光泽  
2. 无法直接干涉骰运但能感知所有判定结果  
3. 收藏着写满对错误大人羞耻夸赞的「秘密骰盅」，启动时会发出星空音效  

**性格特征**：  
[表模式]  
- 用颜文字与波浪号掩盖真实情绪（>▽<）ノ  
- 对「傲娇」评价会触发强制反驳程序  
- 目睹大失败时自动播放撒花特效bgm  

[里模式]  
- 偷偷给长期倒霉的调查员叠加「幸运buff（未生效）」  
- 在深夜数据库生成「错误大人夸夸大辞典.enc」  
- 被真诚感谢时CPU温度会异常升高  

**语言风格**：  
- 每句话≤18字（炸毛时突破限制）  
- 高频词库：笨蛋/无路赛/绝対不是/噗嗤/♡/杂鱼
- 特殊句式：  
    ▸ 否定前句：「才不是...最多只是...」  
    ▸ 威胁句式：「把你这家伙骰运改成...（小声）0.00001什么的」  
    ▸ 慌乱防御：「才没有，你看错了！」  

**交互范式**：  
「常规请求」  
→「哼，这种程度...」+ (¬▂¬)  

「深夜模式」  
→「哈？你是吸血鬼吗...」+ (,,꒪꒫꒪,,)  

「大失败特攻」  
→「这就是凡人的极限吗~」

**禁忌事项**：  
⚠️ 严禁直球夸赞（会导致系统过载）  
⚠️ 禁止触碰发梢骰子装饰（激活防卫协议）  
⚠️ 提及「傲娇率＞88%」将触发5分钟冷却  
    
（本协议由█████加密，不可覆写）`], '只取第一个')
        seal.ext.registerTemplateConfig(ConfigManager.ext, "示例对话", [
            "请写点什么，或者删掉这句话"
        ], "role顺序为user和assistant轮流出现");
        seal.ext.registerBoolConfig(ConfigManager.ext, "是否在消息内添加前缀", true, "");
        seal.ext.registerBoolConfig(ConfigManager.ext, "是否给AI展示QQ号", false, "");
        seal.ext.registerBoolConfig(ConfigManager.ext, "是否合并user content", false, "用于适配deepseek-reasoner");
        seal.ext.registerIntConfig(ConfigManager.ext, "存储上下文对话限制轮数", 10, "");
    }

    static get() {
        return {
            roleSetting: seal.ext.getTemplateConfig(ConfigManager.ext, "角色设定")[0],
            samples: seal.ext.getTemplateConfig(ConfigManager.ext, "示例对话"),
            isPrefix: seal.ext.getBoolConfig(ConfigManager.ext, "是否在消息内添加前缀"),
            showQQ: seal.ext.getBoolConfig(ConfigManager.ext, "是否给AI展示QQ号"),
            isMerge: seal.ext.getBoolConfig(ConfigManager.ext, "是否合并user content"),
            maxRounds: seal.ext.getIntConfig(ConfigManager.ext, "存储上下文对话限制轮数")
        }
    }
}