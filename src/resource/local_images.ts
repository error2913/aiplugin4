// 本地图片实体工厂：把「资源」页配置的本地图片解析成 Image 实体并注册进 imageMap
// （发送 [img:图片ID] 依赖 imageMap 里有对应实例，因此图片消费方必须走这里而不是纯路径层）。
import Image from "./image";
import { getLocalImageEntries } from "./local_paths";

/** 本地图片：Image 实体（含 imageId / 已解析的 path，并注册进 imageMap） */
export function getLocalImages(): Image[] {
    return getLocalImageEntries().map(({ imageId, path }) => Image.createLocalImage(imageId, path));
}
