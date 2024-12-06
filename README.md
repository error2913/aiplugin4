# 海豹js扩展模板


### 介绍

一个简单易用的项目模板。

使用esbuild编译代码，并将多个源码文件打包成一个。


### 如何使用

clone或下载项目，随后:

```
npm install
npm run build
```

好的，现在你的项目被编译成功了，就在dist目录。

默认的名字是`sealdce-js-ext.js`，其逻辑写在src/index.ts


### 开发指南

看这里，这边有大量的例子，以及海豹用户写的插件：

https://github.com/sealdice/javascript

由于无法动态调试，建议将纯逻辑部分独立编写，随后你就可以在调试编译后，用nodejs去验证你的想法:

```
npm run build-dev
node ./dev/sealdice-js-ext.js
```

当然，不止是node，任何其他js环境都行，浏览器里也行。


### 填写个人信息

当插件开发完成后(或者开始开发时)，你需要修改几处地方：

* header.txt 这个文件是你插件的描述信息

* tools/build-config.js 最开头一行"var filename = 'sealdce-js-ext.js';"，改成你中意的名字，注意不要与现有的重名


### 编译和发布

```
npm run build
```

从dist目录找出你的编译结果，将其装入海豹测试并分享即可！

当然，你也可以把你的劳动成果提交到这里：

https://github.com/sealdice/javascript/tree/main/scripts

这样用户就可以直接在海豹的插件面板进行安装了。
