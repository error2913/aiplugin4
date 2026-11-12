// 资源配置：本地图片/语音/文件/视频路径（本文件只注册配置项）。
// 路径解析与 Image 实体构造在 src/resource/local_paths.ts（纯路径）与 local_images.ts（Image 实体）：
// 配置层不 import 资源实现，否则会形成 config → resource → config 环；消费方用 getLocalImages()/getLocalAudios()/… 读取。
import { ext } from "../ext";

export default class ResourceConfig {
    static register() {
        seal.ext.registerTemplateConfig(ext, "本地图片路径", [''], "如不需要可以不填写；每框一个本地图片路径，示例：data/images/sealdice.png；修改后需重载 JS 生效", "资源");
        seal.ext.registerTemplateConfig(ext, "本地语音路径", [''], "每框一个本地语音：语音名=路径（省略语音名时默认用文件名），示例：早安=records/早安.mp3；发送语音需要配置ffmpeg到环境变量中；修改后需重载 JS 生效", "资源");
        seal.ext.registerTemplateConfig(ext, "本地文件路径", [''], "每框一个本地文件：文件名=路径（省略文件名时默认用文件名），示例：规则书=data/files/规则书.pdf；发送文件需安装ob11网络连接依赖；修改后需重载 JS 生效", "资源");
        seal.ext.registerTemplateConfig(ext, "本地视频路径", [''], "每框一个本地视频：视频名=路径（省略视频名时默认用文件名），示例：开场动画=data/videos/开场.mp4；发送视频需安装ob11网络连接依赖；修改后需重载 JS 生效", "资源");
        // 资源清单注入（方案 §9.4 / §10.5）：默认关 = 与旧版一致
        // #163 D1-07：段内容已常量化（不再渲染内置图片数量/最近 ID/资源名清单），门控只看本开关
        seal.ext.registerBoolConfig(ext, "资源清单注入", false, "开启后在主对话系统提示词中固定注入资源用法段（core:resources）；本开关只控制该段是否注入，内置图片数量、最近 ID 与 resource:<name> 清单由 list_resources 现场查询；默认关闭", "资源");
        seal.ext.registerIntConfig(ext, "资源清单预算", 600, "资源清单段字符预算（默认 600，受段硬上限 600 约束）", "资源");
    }

    /** 配置数据：解析结果在资源层（src/resource/local_resources.ts），本分区只额外产出提示词开关 */
    static get() {
        return {
            RESOURCE_LIBRARY: seal.ext.getBoolConfig(ext, "资源清单注入"),
            RESOURCE_LIBRARY_BUDGET: seal.ext.getIntConfig(ext, "资源清单预算"),
        };
    }
}
