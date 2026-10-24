// 持久化反序列化（revive）：按 validKeysMap 描述恢复对象，支持嵌套属性。
// 拆成叶子模块的原因：配置层（configs/trigger）只需要 revive，却经由 utils/utils 拉进
// config/transport 一整圈依赖；本文件不 import 任何项目模块，可作为 L0 基础层使用。
export type TypeDescriptor<T> =
    'default'
    | 'string'
    | 'number'
    | 'boolean'
    | 'any'
    | TypeDescriptor<any>[] // 元组元素类型
    | { array: TypeDescriptor<any> } // 数组元素类型
    | {
        object?: { [key: string]: TypeDescriptor<any> },
        objectValue?: TypeDescriptor<any>
    } // 对象键值对类型，对象值类型
    | RevivableConstructor<T>; // 嵌套类

export interface RevivableConstructor<T> {
    new(): T; // 构造函数必须无参数
    validKeysMap: { [key in keyof T]?: TypeDescriptor<T[key]> };
}

/**
 * 恢复一个对象，只恢复构造函数中定义的属性，支持嵌套属性
 * @param constructor 传入构造函数，必须有 validKeysMap 属性
 * @param value 要恢复的对象
 * @returns 恢复后的对象
 */
export function revive<T>(constructor: RevivableConstructor<T>, value: any): T {
    function reviveItem(descriptor: any, defaultValue: any, value: any): any {
        if (descriptor === 'string') {
            if (typeof value === 'string') return value;
        } else if (descriptor === 'number') {
            if (typeof value === 'number') return value;
        } else if (descriptor === 'boolean') {
            if (typeof value === 'boolean') return value;
        } else if (Array.isArray(descriptor)) {
            if (Array.isArray(value)) return descriptor.map((d: any, i: number) => reviveItem(d, defaultValue?.[i], value?.[i]));
        } else if (typeof descriptor === 'object' && 'array' in descriptor) {
            if (Array.isArray(value)) return value.map((v: any, i: number) => reviveItem(descriptor.array, defaultValue?.[i], v));
        } else if (typeof descriptor === 'object' && ('object' in descriptor || 'objectValue' in descriptor)) {
            const ov: any = {}, o: any = {};
            if (typeof value === 'object' && value !== null) {
                if ('objectValue' in descriptor) Object.keys(value).forEach(k => ov[k] = reviveItem((descriptor as any).objectValue, defaultValue?.[k], value?.[k]));
                if ('object' in descriptor) Object.keys((descriptor as any).object || {}).forEach(k => o[k] = reviveItem((descriptor as any).object[k], defaultValue?.[k], value?.[k]));
                return { ...o, ...ov };
            }
        } else if (typeof descriptor === 'function') {
            return revive(descriptor, value);
        } else {
            return value;
        }
        return defaultValue;
    }

    const obj: any = new constructor();

    if (constructor.validKeysMap) {
        for (const k in constructor.validKeysMap) {
            const descriptor: TypeDescriptor<T[Extract<keyof T, string>]> | undefined = (constructor.validKeysMap as any)[k];
            if (Object.prototype.hasOwnProperty.call(value, k)) {
                const item = reviveItem(descriptor, obj[k], value[k]);
                if (item !== undefined) obj[k] = item;
            }
        }
    } else { // 没有定义 validKeysMap，直接赋值
        for (const k in value) {
            obj[k] = value[k];
        }
    }

    return obj;
}
