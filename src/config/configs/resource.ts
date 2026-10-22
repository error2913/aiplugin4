// 资源配置：本地图片/语音/文件/视频路径（本文件只注册配置项）。
// 路径解析与 Image 实体构造在 src/resource/local_resources.ts：配置层不 import 资源实现，
// 否则会形成 config → resource → config 环；消费方用 getLocalImages()/getLocalAudios()/… 读取。
import { ext } from "../ext";

export default class ResourceConfig {
    static register() {
        seal.ext.registerTemplateConfig(ext, "本地图片路径", [''], "如不需要可以不填写；每框一个本地图片路径，示例：data/images/sealdice.png；修改后需重载 JS 生效", "资源");
        seal.ext.registerTemplateConfig(ext, "本地语音路径", [''], "每框一个本地语音：语音名=路径（省略语音名时默认用文件名），示例：早安=records/早安.mp3；发送语音需要配置ffmpeg到环境变量中；修改后需重载 JS 生效", "资源");
        seal.ext.registerTemplateConfig(ext, "本地文件路径", [''], "每框一个本地文件：文件名=路径（省略文件名时默认用文件名），示例：规则书=data/files/规则书.pdf；发送文件需安装ob11网络连接依赖；修改后需重载 JS 生效", "资源");
        seal.ext.registerTemplateConfig(ext, "本地视频路径", [''], "每框一个本地视频：视频名=路径（省略视频名时默认用文件名），示例：开场动画=data/videos/开场.mp4；发送视频需安装ob11网络连接依赖；修改后需重载 JS 生效", "资源");
    }

    /** 配置数据：解析结果在资源层（src/resource/local_resources.ts），本分区不再产出运行期数据 */
    static get() {
        return {};
    }
}
