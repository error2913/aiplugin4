# 🎲 AI骰娘4 - SealDice AI插件

- 让你的骰娘活起来

![License](https://img.shields.io/badge/License-MIT-blue)
![Version](https://img.shields.io/badge/Version-4.5.10-green)

### 快速开始

- 按[下载](#下载)提示下载插件；
- 在海豹webui点击上传，重载，刷新浏览器页面；
- 按[可用AI大模型开放平台列表](#可用ai大模型开放平台列表)一节或自行找到准备使用的大模型，记下url地址、你的API和模型名；
- 在海豹webui-js插件-插件设置里找到aiplugin4，点击展开，将刚才记下的url地址、API Key填到对应配置项，模型名填入body的model字段；
- 在插件设置界面找到 非指令消息触发正则表达式 一项，修改为你希望的触发方式；找到 角色设定 一项，修改为你希望AI扮演的角色；
- 对着你的骰娘输入你设定的 非指令消息触发正则表达式 的对应触发方式，你就可以看到骰娘的回复啦；
- 如果没有回复，可以自行查看触发日志寻找可能问题，对照[常见问题处理](#常见问题处理)解决；
- 更多详细设置可以修改插件设置界面的配置项，[⚙️ 配置手册](#️-配置手册)有详细说明；

## 目录

- [🎲 AI骰娘4 - SealDice AI插件](#-ai骰娘4---sealdice-ai插件)
  - [快速开始](#快速开始)
    - [目录](#目录)
    - [🌟 核心特性](#-核心特性)
    - [🛠️ 完整安装指南](#️-完整安装指南)
  - [环境要求](#环境要求)
  - [下载](#下载)
  - [依赖下载](#依赖下载)
  - [安装](#安装)
    - [⚙️ 配置手册](#️-配置手册)
  - [打印日志设置](#打印日志设置)
  - [基础文本大模型请求设置](#基础文本大模型请求设置)
  - [基础对话设置](#基础对话设置)
  - [函数调用设置](#函数调用设置)
  - [接收消息和触发相关设置](#接收消息和触发相关设置)
  - [回复相关设置](#回复相关设置)
  - [图片相关设置](#图片相关设置)
    - [💻 完整命令手册](#-完整命令手册)
  - [基础控制命令](#基础控制命令)
  - [工具管理命令](#工具管理命令)
  - [记忆管理命令](#记忆管理命令)
  - [图片相关命令](#图片相关命令)
  - [管理员命令](#管理员命令)
  - [可用工具函数示例](#可用工具函数示例)
    - [🚨 注意事项](#-注意事项)
  - [常见问题处理](#常见问题处理)
    - [可用AI大模型开放平台列表](#可用ai大模型开放平台列表)
    - [📜 开发文档](#-开发文档)
  - [项目结构](#项目结构)
  - [添加新功能](#添加新功能)
  - [添加新配置](#添加新配置)
    - [版权信息](#版权信息)
    - [致谢](#致谢)
    - [📞 技术支持](#-技术支持)

## 🌟 核心特性

AI骰娘4是一款面向TRPG玩家（吗？）的智能对话插件，基于OpenAI兼容API开发。本插件深度整合了海豹骰子核心功能，提供以下核心能力：

- **智能对话**：支持上下文感知的AI对话
- **多功能集成**：内置20+实用功能（属性检定、牌堆抽取、记忆管理等），并且持续更新
- **图像处理**：支持图片识别、表情包管理和盗图功能
- **权限系统**：多维度权限控制体系

---

## 🛠️ 完整安装指南

### 环境要求

- SealDice v1.4.6+ 
  - 1.4.6分离部署使用napcat和llonebot协议图片相关功能存在问题，SealDice v1.5.0+ 正常使用
- 支持的AI API：
  - OpenAI API兼容

### 下载

- 通过GitHub下载最新稳定版：[下载链接](https://github.com/baiyu-yu/plug-in/blob/main/aiplugin4.js)

- 通过GitHub下载最新开发版：[下载链接](https://github.com/baiyu-yu/plug-in/blob/main/aiplugin4/dist/aiplugin4.js)

- 通过GitHub下载后自编译最新开发版：[下载链接](https://github.com/baiyu-yu/plug-in/blob/main/aiplugin4)
  
  - 需要node.js环境，在下载后文件夹执行npm install命令安装依赖，执行npm run build命令编译为aiplugin4.js文件,在dist文件夹中可找到

- 在QQ群中获取插件文件
  
  ### 依赖下载

- 通过GitHub下载最新版：[aitts依赖插件](https://github.com/baiyu-yu/plug-in/blob/main/AITTS.js) 

- 通过GitHub下载最新版：[http依赖插件](https://github.com/error2913/sealdice-js/blob/main/HTTP%E4%BE%9D%E8%B5%96.js)

- 在QQ群中获取插件文件

### 安装

- 参考[海豹手册](https://docs.sealdice.com/config/jsscript.html)进行插件上传安装

---

## ⚙️ 配置手册

### 打印日志设置

| 设置项    | 类型  | 默认值 | 说明                |
|:------:|:---:|:---:|:-----------------:|
| 日志打印方式 | 选项  | 简短  | 是否打印日志，反馈问题建议开启详细 |

### 基础文本大模型请求设置

| 设置项     | 类型  | 默认值                                          | 说明                                                                           |
|:-------:|:---:|:--------------------------------------------:|:----------------------------------------------------------------------------:|
| url地址   | 字符串 | https://api.deepseek.com/v1/chat/completions | 大语言模型的请求地址，一般在大模型平台的文档中会写出，或者参考下面列出的场景大模型请求地址                                |
| API Key | 字符串 | 你的API Key                                    | 在ai的开放平台中获取，请注意个别开放平台会有多个API Key用于不同情况，请注意选择HTTP调用的API Key，未说明可能没做区分，直接完整复制入 |
| body    | 模板  | 见下表                                          | 请求体设置，注意在书写字符串时，使用英文半角双引号。具体参数还请查看自己使用的模型的接口文档                               |

> | body默认值                             | 说明                                                                                                                         |
> |:-----------------------------------:|:--------------------------------------------------------------------------------------------------------------------------:|
> | `"messages":null`                   | 消息体，为null时会自动替换，不用更改                                                                                                       |
> | `"model":"deepseek-chat"`           | 模型名，查看接口文档获取                                                                                                               |
> | `"max_tokens":70`                   | 最大token，值越大回复越长                                                                                                            |
> | `"stop":null`                       | 一个 string 或最多包含 16 个 string 的 list，在遇到这些词时，API 将停止生成更多的 token。例如`"stop":["\n"]`，此时AI将会在遇到换行时停止输出                           |
> | `"stream":false`                    | 是否流式输出，暂不支持更改                                                                                                              |
> | `"response_format":{"type":"text"}` | 响应格式，不用更改                                                                                                                  |
> | `"frequency_penalty":0`             | 如果该值为正，那么新 token 会根据其在已有文本中的出现频率受到相应的惩罚，降低模型重复相同内容的可能性                                                                     |
> | `"presence_penalty":0`              | 如果该值为正，那么新 token 会根据其是否已在已有文本中出现受到相应的惩罚，从而增加模型谈论新主题的可能性                                                                    |
> | `"temperature":1`                   | 更高的值，如 0.8，会使输出更随机，而更低的值，如 0.2，会使其更加集中和确定。 我们通常建议可以更改这个值或者更改 top_p，但不建议同时对两者进行修改                                           |
> | `"top_p":1`                         | 作为调节采样温度的替代方案，模型会考虑前 top_p 概率的 token 的结果。所以 0.1 就意味着只有包括在最高 10% 概率中的 token 会被考虑。 我们通常建议修改这个值或者更改 temperature，但不建议同时对两者进行修改 |
> | `"tools":null`                      | 调用工具相关参数，为null时会自动替换，不需要更改,如果出现function call相关报错可以尝试删除                                                                     |
> | `"tool_choice":null`                | 调用工具相关参数，为null时会自动替换，不需要更改,如果出现function call相关报错可以尝试删除                                                                     |

---

### 基础对话设置

| 设置项              | 类型  | 默认值           | 说明                                              |
|:----------------:|:---:|:-------------:|:-----------------------------------------------:|
| 角色设定             | 模板  | 太长了不粘贴        | ai的扮演设定，当前只会取第一个                                |
| 示例对话             | 模板  | 请写点什么，或者删掉这句话 | 顺序为用户和AI回复轮流出现，可用于提供扮演示例，位于上下文最前面，不会被上下文机制删除    |
| 是否在消息内添加前缀       | 布尔  | true          | 添加消息来源，如 from:土豆                                |
| 是否给AI展示数字号码      | 布尔  | false         | 添加消息来源的数字ID，如 from:土豆(114514)                   |
| 是否合并user content | 布尔  | false         | 在不支持连续多个role为user的情况下开启，比如 deepseek-reasoner 模型 |
| 存储上下文对话限制轮数      | 整数  | 10            | 出现一次user视作一轮，超过轮数会遗忘除了示例对话之外最早的对话，越长消耗的token越多  |

---

### 函数调用设置

| 设置项        | 类型  | 默认值                              | 说明                                                                                                                                                                                                                                |
|:----------:|:---:|:--------------------------------:|:---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------:|
| 是否开启调用函数功能 | 布尔值 | true                             | 开启后AI可使用函数来进行除了文本对话之外的功能                                                                                                                                                                                                          |
| 是否切换为提示词工程 | 布尔值 | false                            | 当API不支持function calling时开启,将函数调用介绍加入到prompt中                                                                                                                                                                                      |
| 不允许调用的函数   | 模板  | 填写不允许调用的函数名称，例如：get_time         | 修改后保存并重载js,设置后将不被允许开启，函数名参考上表或对骰娘发送.ai tool 查看                                                                                                                                                                                    |
| 默认关闭的函数    | 模板  | ban、rename                       | AI默认关闭对该函数调用，在开启后才能调用的函数，函数名参考上表或对骰娘发送.ai tool 查看                                                                                                                                                                                 |
| 长期记忆上限     | 整数  | 5                                | AI通过指令记忆信息的条数上限，超过上限会遗忘最早的记忆，越长消耗的token越多                                                                                                                                                                                         |
| 提供给AI的牌堆名称 | 模板  | 没有的话请去上面把draw_deck这个函数加入不允许调用的函数 | 提供给AI可用于函数调用的牌堆名称                                                                                                                                                                                                                 |
| ai语音使用的音色  | 选项  | 小新                               | 该功能在选择预设音色时，需要安装[http依赖插件](https://github.com/error2913/sealdice-js/blob/main/HTTP%E4%BE%9D%E8%B5%96.js)，且需要可以调用ai语音api版本的napcat/lagrange等。选择自定义音色时，则需要[aitts依赖插件](https://github.com/baiyu-yu/plug-in/blob/main/AITTS.js)和ffmpeg |
| 本地语音路径     | 模板  | <钢管落地>data/records/钢管落地.mp3      | 如不需要可以不填写，尖括号内是语音的名称，提供给AI用于选择，后面是语音文件的路径，修改完需要重载js。发送语音需要配置ffmpeg到环境变量中                                                                                                                                                          |

---

### 接收消息和触发相关设置

| 设置项           | 类型  | 默认值                                 | 说明                                                                                                                                                                                                         |
|:-------------:|:---:|:-----------------------------------:|:----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------:|
| 是否录入指令消息      | 布尔  | false                               | 是否将指令消息写入上下文，指令消息包括指令前缀开头的所有消息，例如指令前缀为.则所有.开头的消息在改选项关闭状态下都不会被AI看到                                                                                                                                          |
| 是否录入所有骰子发送的消息 | 布尔  | false                               | 若开启，则除了AI返回的文本外，骰点之类的所有骰子发送的消息都会被录入上下文                                                                                                                                                                     |
| 非指令触发需要满足的条件  | 字符串 | 1                                   | 保持原样为可无限制非指令触发，即只要符合你的触发条件，AI就会回复，若需要限制只可在指定群或指定用户非指令触发，使用[豹语表达式](https://docs.sealdice.com/advanced/script.html)，例如：\$t群号_RAW=='114514' \| $t账号ID_RAW=='123456789'表示允许群号为114514的群或者QQ号为123456789的用户触发AI回复 |
| 非指令消息触发正则表达式  | 模板  | `\\[CQ:at,qq=748569109\\]`,`^正确正确确` | 用于匹配符合特定正则表达式的消息用于强制触发AI回复，示例中第一个为@骰娘，数字部分可改为你骰娘的QQ号，第二个为以"正确正确确"开头的句子触发，[正则表达式教程](https://www.runoob.com/regexp/regexp-syntax.html)                                                                       |

---

### 回复相关设置

| 设置项        | 类型  | 默认值                                                                                             | 说明                                                                                              |
|:----------:|:---:|:-----------------------------------------------------------------------------------------------:|:-----------------------------------------------------------------------------------------------:|
| 回复是否引用     | 布尔  | false                                                                                           | AI在回复时是否引用触发的消息                                                                                 |
| 回复最大字数     | 整数  | 1000                                                                                            | 防止最大tokens限制不起效导致回复过长                                                                           |
| 禁止AI复读     | 布尔  | false                                                                                           | 开启后检测到AI返回文本和前一次相似度太高时，尝试再次请求以获得相似度较低的文本                                                        |
| 视作复读的最低相似度 | 浮点数 | 0.8                                                                                             | 在禁止AI复读开关打开后，高于该相似度时，尝试再次请求以获得相似度较低的文本                                                          |
| 过滤上下文正则表达式 | 模板  | `<[\\\|｜]from.*?[\\\|｜]?>`,`^<think>[\\s\\S]*?</think>`                                         | 回复加入上下文时，将符合正则表达式的内容删掉，默认为删除AI模仿的消息来源和以<think></think>包裹的内容删掉                                   |
| 过滤回复正则表达式  | 模板  | `<[\\\|｜].*?[\\\|｜]?>`,`^<think>[\\s\\S]*?</think>`,`<function_call>[\\s\\S]*?</function_call>` | 回复输出时，将符合正则表达式的内容删掉，默认为删除AI模仿的消息来源、以<think></think>包裹的内容和<function_call></function_call>包裹的内容删掉 |

---

### 图片相关设置

| 设置项                | 类型  | 默认值                                                   | 说明                                                                                                                                                                                                               |
|:------------------:|:---:|:-----------------------------------------------------:|:----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------:|
| 本地图片路径             | 模板  | <海豹>data/images/sealdice.png                          | 如不需要可以不填写，尖括号内是提供给AI发送的图片的名称，后面是本地图片的路径，修改完需要重载js                                                                                                                                                                |
| 图片识别需要满足的条件        | 字符串 | 1                                                     | 保持原样为在所有群中，AI调用识别图片指令可正常使用，若需要限制只可在指定群或指定用户发出的图片可被AI通过图片识别指令识别，使用[豹语表达式](https://docs.sealdice.com/advanced/script.html)，例如：\$t群号_RAW=='114514'\|$t账号ID_RAW=='123456789'表示允许在群号为114514的群或者QQ号为123456789的用户触发图片识别 |
| 发送图片的概率/%          | 整数  | 100                                                   | 在AI触发回复后随机抽取一张本地或偷取的图片发送的概率                                                                                                                                                                                      |
| 图片大模型URL           | 字符串 | https://open.bigmodel.cn/api/paas/v4/chat/completions | 视觉大模型的请求URL，填写后可使用image_to_text或check_avatar识别图片内容                                                                                                                                                               |
| 图片API key          | 字符串 | yours                                                 | 视觉大模型的API key                                                                                                                                                                                                    |
| 图片body             | 模板  | 见下表                                                   | 视觉大模型请求体设置                                                                                                                                                                                                       |
| 识别图片时将url转换为base64 | 选项  | 永不                                                    | 解决大模型无法正常获取QQ图床图片的问题，当请求图片报错错误码400图片格式错误，但图片可在浏览器正常访问时，时可尝试修改                                                                                                                                                    |
| 图片最大回复字符数          | 字符串 | 100                                                   | 超过该字符数会自动截断，防止max_tokens不起效                                                                                                                                                                                      |
| 偷取图片存储上限           | 整数  | 30                                                    | 偷取图片存储上限，每个群聊或私聊单独储存                                                                                                                                                                                             |

> | body默认值            | 说明                                                                                               |
> |:------------------:|:------------------------------------------------------------------------------------------------:|
> | `"messages":null`  | 消息体，为null时会自动替换，不用更改                                                                             |
> | `"model":"glm-4v"` | 模型名，查看接口文档获取                                                                                     |
> | `"max_tokens":20`  | 最大token，值越大回复越长                                                                                  |
> | `"stop":null`      | 一个 string 或最多包含 16 个 string 的 list，在遇到这些词时，API 将停止生成更多的 token。例如`"stop":["\n"]`，此时AI将会在遇到换行时停止输出 |
> | `"stream":false`   | 是否流式输出，暂不支持更改                                                                                    |

---

## 💻 完整命令手册

### 基础控制命令

| 命令                       | 使用示例                                       | 说明                                                          |
|:------------------------:|:------------------------------------------:|:-----------------------------------------------------------:|
| `.ai on --<参数>=<数字>`     | `.ai on --c=10 --t=60`每收到十条消息触发一次或每60s触发一次 | 开启AI，参数有计数器模式(c)，计时器模式(t)和概率模式(p)，可同时开启多个模式                 |
| `.ai off`                | -                                          | 关闭AI（仍可通过关键词触发）                                             |
| `.ai sb`                 | -                                          | 待机模式（仅录入上下文，但不主动发言，只有非指令关键词触发才发言）                           |
| `.ai f [assistant/user]` | -                                          | 遗忘当前上下文，不加参数为遗忘全部上下文，assistant为遗忘AI调用函数和发言，user为遗忘用户发言和函数返回 |
| `.ai ctxn`               | -                                          | 查看上下文中的名字                                                   |
| `.ai pr`                 | -                                          | 查看当前群聊权限和触发设定                                               |

### 工具管理命令

| 命令                         | 使用示例                                                             | 说明                                                       |
|:--------------------------:|:----------------------------------------------------------------:|:--------------------------------------------------------:|
| `.ai tool`                 | -                                                                | 列出所有可用工具                                                 |
| `.ai tool help <name>`     | `.ai tool help get_time`                                         | 查看指定工具的详细说明和参数需求                                         |
| `.ai tool [on/off]`        | -                                                                | 开启/关闭全部工具函数                                              |
| `.ai tool <name> [on/off]` | `.ai tool jrrp on`                                               | 开启/关闭指定工具函数                                              |
| `.ai tool <name>`          | `.ai tool jrrp --name=错误` 调用一次查看错误今日人品，输出会包括今日人品函数的输出和调用函数返回结果输出 | 试用指定工具函数，会输出调用函数返回信息，多个参数用空格或换行隔开，可使用上下文中名字或QQ号，数字需要引号包裹 |

### 记忆管理命令

| 命令                    | 使用示例                           | 说明                         |
|:---------------------:|:------------------------------:|:--------------------------:|
| `.ai memo st`         | `.ai memo st 西瓜` 将自己的设定记忆设定为西瓜 | 修改AI的设定记忆，不能超过20字          |
| `.ai memo clr`        | -                              | 清除当前个人所有记忆，骰主可通过@其他人替他人删除  |
| `.ai memo clr group`  | -                              | 清除当前群聊记忆，骰主可通过@其他人替他人删除    |
| `.ai memo show`       | -                              | 展示当前个人所有记忆，骰主可通过@其他人查看他人记忆 |
| `.ai memo show group` | -                              | 展示当前群聊记忆                   |

> 注：个人记忆是跨群的，群聊记忆是群内的，在刚初始化的时候每个人会等概率随机或者“好人”或“坏人”一个设定记忆，可以清除或覆盖，记忆会写入prompt

### 图片相关命令

| 命令                        | 使用示例                                           | 说明                                                                                |
|:-------------------------:|:----------------------------------------------:|:---------------------------------------------------------------------------------:|
| `.img stl [on/off]`       | -                                              | 开启/关闭图片盗取功能，开启后会随机偷取群内发送的图片，然后按照配置项设置的概率在触发ai回复后随机抽取一张发送。不带on/off参数为查看当前偷取图片状态和数量 |
| `.img draw [stl/lcl/all]` | `.img itt stl` 随机抽取一张偷取的图片                     | 随机抽取图片(偷取/本地/全部)                                                                  |
| `.img f`                  | -                                              | 遗忘图片                                                                              |
| `.img itt [图片/ran] [提示词]` | `.img itt ran 看看这图里人物是什么` 抽取一张盗取的图片，并询问AI是什么人物 | 使用视觉大模型进行一次图片转文字，图片为一张发送的图片，ran为抽取的随机图片(可带提示词)                                    |

### 管理员命令

| 命令           | 使用示例                                                                | 说明                                       |
|:------------:|:-------------------------------------------------------------------:|:----------------------------------------:|
| `.ai st`     | `.ai st QQ-Group:1234 60`设置群1234的权限限制是群主或群主以上，即群主、骰娘白名单、骰主可使用基础控制命令 | 设置群组操作基础控制命令需要的权限等级                      |
| `.ai ck`     | `.ai ck QQ-Group:1234` 查看群1234的权限设置                                 | 检查指定群或私聊的权限等级需求和触发设定                     |
| `.ai prompt` | -                                                                   | 检查当前prompt，需要注意如果打开了将AI命令写入提示词开关，这条输出会很长 |

### 可用工具函数示例

以下是一些常用的工具函数，可通过`.ai tool help <name>`查看详细用法：

| 函数名                   | 描述                       | 特殊说明                                 |
|:---------------------:|:------------------------:|:------------------------------------:|
| add_memory            | 添加记忆                     |                                      |
| show_memory           | 查看记忆                     |                                      |
| draw_deck             | 抽取牌堆                     |                                      |
| face                  | 发送表情包                    |                                      |
| jrrp                  | 查看今日人品                   |                                      |
| modu_roll             | 随机抽取COC模组                |                                      |
| modu_search           | 搜索COC模组                  |                                      |
| roll_check            | 技能/属性检定                  |                                      |
| rename                | 设置群名片                    |                                      |
| attr_show             | 展示用户全部属性                 |                                      |
| attr_get              | 获取用户指定属性                 |                                      |
| attr_set              | 修改用户属性                   |                                      |
| ban                   | 禁言用户                     | 需要http依赖                             |
| whole_ban             | 全员禁言                     | 需要http依赖                             |
| get_ban_list          | 查看群内被禁言的用户               | 需要http依赖                             |
| text_to_sound         | AI文本转语音                  | 预设音色需要http依赖，自定义音色需要AITTS依赖和ffmpeg   |
| poke                  | 发送戳一戳                    | 需要http依赖                             |
| get_time              | 获取当前时间                   |                                      |
| set_timer             | 设置定时器用于触发对话              |                                      |
| show_timer_list       | 查看当前聊天定时器列表              |                                      |
| cancel_timer          | 取消当前聊天指定定时器              |                                      |
| web_search            | 搜索引擎搜索                   |                                      |
| image_to_text         | 图片内容识别，可指定特别关注的内容        | 需要设置视觉大模型相关配置项，需要支持QQ图床的视觉大模型或使用中转插件 |
| check_avatar          | 查看指定用户头像或群聊头像，可指定特别关注的内容 | 需要设置视觉大模型相关配置项                       |
| san_check             | San值检定                   |                                      |
| group_sign            | 发送群打卡                    | 需要http依赖                             |
| get_person_info       | 获取用户信息                   | 需要http依赖                             |
| record                | 发送本地语音                   | 需要配置ffmpeg                           |
| send_msg              | 向指定私聊或群聊发送消息或调用函数        |                                      |
| get_context           | 查看指定私聊或群聊的上下文            |                                      |
| get_list              | 查看当前好友列表或群聊列表            | 需要http依赖                             |
| get_group_member_list | 查看群聊成员列表                 | 需要http依赖                             |
| search_chat           | 搜索好友或群聊                  | 需要http依赖                             |
| search_common_group   | 搜索共同群聊                   | 需要http依赖                             |

> 注：部分工具函数需要额外依赖或权限，请在依赖下载一节中获取。

---

## 🚨 注意事项

### 常见问题处理

- `请求出错：Error:HTTP error! status 数字` —— HTTP请求错误，可自行翻译日志中错误信息，以及在对应大模型文档中查找错误码对应问题自行解决，若找不到可以直接百度"HTTP错误码***"。常见问题：url填错，api填错，模型名填错，不支持工具调用，余额不足，请求频繁等；
- `图片识别异常`：确认图片URL是否可以在浏览器访问，不能可能是图片过期或者QQ图床bug，可以尝试通过升级协议端版本，如果能正常访问可能是模型不支持QQ图床，可以尝试更换模型或者使用base64；

---

## 可用AI大模型开放平台列表

| 大模型平台                                                           | 调用url                                                                      | 文档地址                                                                                                                               | 支持语言大模型                                                                                                                           | 支持视觉大模型                                                  |
|:---------------------------------------------------------------:|:--------------------------------------------------------------------------:|:----------------------------------------------------------------------------------------------------------------------------------:|:---------------------------------------------------------------------------------------------------------------------------------:|:--------------------------------------------------------:|
| [deepseek](https://platform.deepseek.com)                       | `https://api.deepseek.com/chat/completions`                                | [deepseek API文档](https://api-docs.deepseek.com/zh-cn)                                                                              | `deepseek-chat`,`deepseek-reasoner`×▲                                                                                             | -                                                        |
| [kimi](https://platform.moonshot.cn/console)                    | `https://api.moonshot.cn/v1/chat/completions`                              | [Moonshot AI 使用手册](https://platform.moonshot.cn/docs)                                                                              | `moonshot-v1-8k`,`moonshot-v1-32k`,`moonshot-v1-128k`,`moonshot-v1-auto`                                                          | -                                                        |
| [百炼大模型](https://www.aliyun.com/product/bailian/getting-started) | `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`       | [大模型服务平台百炼产品文档](https://help.aliyun.com/zh/model-studio/getting-started/what-is-model-studio)                                      | `qwen-max`,`qwen-plus`,`qwen-turbo`,`qwen-long`,`deepseek-r1`×▲,`deepseek-v3`×                                                    | `qwen-vl-max`,`qwen-vl-plus`                             |
| [智谱AI](https://www.bigmodel.cn/console/overview)                | `https://open.bigmodel.cn/api/paas/v4/chat/completions`                    | [BigModel 接口文档](https://www.bigmodel.cn/dev/api)                                                                                   | `glm-4-plus`,`glm-4-air`,`glm-4-air-0111`,`glm-4-airx`,`glm-4-long`,`glm-4-flashx`,`glm-4-flash`,`glm-zero-preview`×,`charglm-4`× | `glm-4v-plus-0111`,`glm-4v-plus`,`glm-4v`,`glm-4v-flash` |
| [百度千帆大模型平台](https://console.bce.baidu.com/qianfan/overview)     | `https://qianfan.baidubce.com/v2/chat/completions`                         | [千帆大模型服务与开发平台ModelBuilder文档](https://cloud.baidu.com/doc/WENXINWORKSHOP/s/Zm2ycv77m)                                               | `ernie-4.0-8k`▲,`ernie-4.0-turbo-8k`▲,`ernie-3.5-8k`▲,`deepseek-v3`×▲,`deepseek-r1`×▲                                             | `deepseek-vl2`                                           |
| [讯飞星火大模型](https://console.xfyun.cn/services)                    | `https://spark-api-open.xf-yun.com/v1/chat/completions`                    | [讯飞开放平台文档中心](https://www.xfyun.cn/doc/spark/HTTP%E8%B0%83%E7%94%A8%E6%96%87%E6%A1%A3.html#_1-%E6%8E%A5%E5%8F%A3%E8%AF%B4%E6%98%8E) | `lite`×,`generalv3`×,`pro-128k`×,`generalv3.5`×,`max-32k`,`4.0Ultra`                                                              |                                                          |
| [google AI](https://ai.google.dev/)                             | `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` | [gemini API 文档](https://ai.google.dev/api)                                                                                         | `gemini-2.0-flash`,`gemini-1.5-flash`,`gemini-1.5-pro`                                                                            |                                                          |
| [openAI](https://openai.com/api/)                               | `https://api.openai.com/v1/chat/completions`                               | [openAI API 文档](https://platform.openai.com/docs/quickstart)                                                                       | `gpt-4o`,`gpt-4o-mini`,`o1`,`o3-mini`,`gpt-4-turbo`,`gpt-3.5-turbo`                                                               | `gpt-4-turbo`,`gpt-4o`,`o1`,`gpt-4o-mini`                |

> 注：×为不支持function call。▲为需要开启合并user消息开关。

> 视觉模型不一定支持QQ图床识别，可使用中转插件。

> 仅列出部分官方的我知道的该插件支持的模型，部分大模型平台同一模型有多个版本并未在上表写出，且更新不及时，存在过期可能，未列出的不一定不能使用，最好到文档自己查看。

> 国外大模型网络问题请自行解决。

---

## 📜 开发文档

### 项目结构

```
aiplugin4/
├── src/
│   ├── config/        # 配置项相关
│   │   ├── config.ts  # 配置管理
│   │   ├── config_image.ts  # 图片配置
│   │   ├── config_log.ts  # 日志配置
│   │   ├── config_message.ts  # 构建prompt和消息拼接配置
│   │   ├── config_receive.ts  # 接收消息和触发配置
│   │   ├── config_reply.ts  # 回复配置
│   │   ├── config_request.ts  # 基础文本大模型请求配置
│   │   └── config_tool.ts  # 函数调用配置
│   ├── tools/         # 调用函数扩展
│   │   ├── tool.ts     # 工具管理
│   │   ├── tool_attr.ts     # 属性工具
│   │   ├── tool_ban.ts     # 禁言工具
│   │   ├── tool_draw_deck.ts     # 抽取牌堆工具
│   │   ├── tool_face.ts     # 本地表情发送工具
│   │   ├── tool_get_context.ts     # 查看上下文工具
│   │   ├── tool_get_list.ts     # 查看QQ相关列表工具
│   │   ├── tool_get_person_info.ts     # 获取用户信息工具
│   │   ├── tool_get_time.ts     # 获取当前时间工具
│   │   ├── tool_group_sign.ts     # 群打卡工具
│   │   ├── tool_image_to_text.ts     # 图片识别工具
│   │   ├── tool_jrrp.ts     # 今日人品工具
│   │   ├── tool_memory.ts     # 记忆工具
│   │   ├── tool_modu.ts     # 模组工具
│   │   ├── tool_poke.ts     # 戳戳工具
│   │   ├── tool_record.ts     # 本地语音发送工具
│   │   ├── tool_rename.ts     # 修改群名片工具
│   │   ├── tool_roll_check.ts     # 检定工具
│   │   ├── tool_san_check.ts     # sc工具
│   │   ├── tool_search_chat.ts     # QQ相关搜索工具
│   │   ├── tool_send_msg.ts     # 发送消息工具
│   │   ├── tool_text_to_sound.ts     # 文字转语音工具
│   │   ├── tool_timer.ts     # 定时任务工具
│   │   └── tool_web_search.ts     # 联网搜索工具
│   ├── AI/            # 核心逻辑
│   │   ├── AI.ts       # 核心AI逻辑
│   │   ├── context.ts  # 上下文管理
│   │   ├── memory.ts   # 记忆管理
│   │   ├── image.ts    # 图片管理
│   │   └── service.ts  # 服务管理，包括API调用
│   └── utils/         # 工具函数
│       ├── utils.ts   # 杂项工具函数
│       ├── utils_message.ts  # 构建prompt和消息拼接
│       ├── utils_reply.ts  # 回复处理
│       ├── utils_seal.ts   # msg和ctx制作
│       └── utils_string.ts    # 字符串处理
└── package.json       # 项目依赖
```

### 添加新功能

1. 在`src/tools/`目录下创建新文件，文件命名格式为`tool_xxx.ts`(也可直接在有关文件内添加新功能)

2. 实现工具接口，示例：
   
   ```typescript
   import { Tool, ToolInfo, ToolManager } from "./tool";
   
   export function registerGetTime() {
       // 用JSON Schema标准填写tool info，以提供给AI
       const info: ToolInfo = {
           type: "function",
           function: {
               name: "get_time",
               description: `获取当前时间`,
               parameters: {
                   type: "object",
                   properties: {
                       arg1: {
                           type: 'string',
                           description: '喵喵喵'
                       }
                   },
                   required: ['arg1'] // 必需参数
               }
           }
       }
   
       const tool = new Tool(info); // 创建一个新tool
       tool.solve = async (ctx, msg, ai, args) => { // 实现方法，返回字符串提供给AI
           const { arg1 } = args; // 解构获取AI提供的参数
           return new Date().toLocaleString();
       }
   
       // 注册到toolMap中
       ToolManager.toolMap[info.function.name] = tool;
   }
   ```

3. 注册到工具管理系统，示例：
   
   ```typescript
   // 打开src/tool/tool.ts，导入你写的注册函数
   import { registerGetTime } from "./tool_get_time"
   
   export class ToolManager {
       // ...
       static registerTool() {
           // ...
           registerGetTime(); // 添加到registerTool函数中
       }
   }
   ```
   
   

### 添加新配置

1. 在`src/config/`目录创建文件，文件命名格式为`config_xxx.ts`(也可直接在有关文件内添加新功能)

2. 定义一个类，实现`register`静态方法和`get`静态方法，示例：
   
   ```typescript
   import { ConfigManager } from "./config";
   
   export class LogConfig {
       static register() {
           seal.ext.registerBoolConfig(ConfigManager.ext, "是否打印日志细节", true, "");
       }
   
       static get() {
           return {
               isLog: seal.ext.getBoolConfig(ConfigManager.ext, "是否打印日志细节")
           }
       }
   }
   ```

3. 注册到配置管理系统，示例：
   
   ```typescript
   // 打开src/config/config.ts，导入你写的类
   import { LogConfig } from "./config_log";
   
   export class ConfigManager {
       // ...
       static registerConfig() {
           // ...
           LogConfig.register(); // 添加你的注册函数
       }
       // ..
       static get log() { return this.getCache('log', LogConfig.get) } // 添加你的get方法
   }
   ```
   
   

---

## 版权信息

本项目采用MIT开源协议，欢迎二次开发。原创作者保留署名权。

```text
Copyright 2024 错误、白鱼

Permission is hereby granted...
```

## 致谢

- 海豹骰子开发团队
- 开源社区贡献者

## 📞 技术支持

- GitHub Issues: [问题提交](https://github.com/baiyu-yu/plug-in/issues)
- QQ交流群: 940049120

> "才、才不是专门给你写的文档呢！只是...只是顺便而已！(///ω///)" —— 正确·改
