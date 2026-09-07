# AI 对话流转

一个把 ChatGPT Conversation 持续保存到电脑本地、整理成可长期管理的资料库，并在需要时按条件重新提取出来继续使用的浏览器用户脚本。

它不是一次性的“聊天记录下载器”，而是维护一个会持续更新的本地 Conversation 资料库：

- 第一次保存后，后续只处理新增或发生变化的对话
- 对话可以按 ChatGPT Project 与本地分类两种方式整理
- 本地同时保留原始、JSON、Markdown、PDF 等视图
- 需要继续使用时，只提取当前需要的一部分 Conversation
- 可输出 Markdown、Word、PDF 等格式，方便继续交给 ChatGPT、其他 AI 或其他工具使用

---

## 下载与安装

- **直接安装脚本：** [🚀 点击这里安装最新版用户脚本](https://raw.githubusercontent.com/zwmqcf/chatgpt-local-sync/main/chatgpt-local-sync.user.js)
- **完整包下载：** [⬇️ 123 云盘｜脚本 + 安装教程 + 使用说明书](https://1855762805.share.123pan.cn/123pan/EKOOvd-1D943)
- **ScriptCat：** [🐱 AI 对话流转脚本页](https://scriptcat.org/zh-CN/script-show-page/7424)
- **视频教程：** [🎬 B站｜ChatGPT聊天记录怎么导出到本地？2.9.85](https://www.bilibili.com/video/BV1ctbA6XELL/)

如果点击“直接安装脚本”后看到的是代码页面，请先安装 **ScriptCat** 或 **Tampermonkey** 浏览器扩展，再重新点击安装链接。

---

## 主要功能

### 1. 持续保存 ChatGPT Conversation

将 ChatGPT 对话增量同步到电脑本地。

第一次完整保存后，后续同步主要处理：

- 新增 Conversation
- 已有 Conversation 的更新
- ChatGPT Project 与归档状态等变化

大资料库首次保存遇到 429 限流时，会自动等待并尝试恢复，而不是直接把整次任务判定为失败。

---

### 2. 本地资料库多视图

2.9.85 的资料库主要包括：

```text
00_原始
01_JSON
02_Markdown
03_PDF
10_项目
11_归档
12_已删除
90_工程文件
```

同一批 Conversation 可以从不同视图查看和使用，而不需要反复重新导出。

---

### 3. ChatGPT Project + 本地分类

支持同时按两种方式组织对话：

- **ChatGPT Project**：保留 ChatGPT 网页端 Project 关系
- **本地命名分类**：根据自己的标题、规则和文件夹习惯整理

两种视图可以并存，不需要二选一。

---

### 4. 按需提取

本地资料库负责长期保存，真正需要继续使用时，可以只拿出当前需要的一部分 Conversation。

可以按照时间、命名、文件夹、关键词等条件筛选，并按需要提取为：

- 原始数据
- JSON
- Markdown
- Word
- PDF

支持 ZIP 或普通文件输出。

这样可以把选中的 Conversation 继续交给 ChatGPT、其他 AI 或其他工具，而不必每次处理整个资料库。

---

### 5. PDF 与数学公式

支持生成 PDF 视图，并改进数学公式渲染，方便保存包含公式的学习、技术或长文本对话。

---

### 6. 旧资料库升级

2.9.85 提供旧资料库安全升级流程。

升级时优先保护已经保存到本地的 Conversation，遇到无法安全判断的情况会停止并提示，而不是为了“同步成功”直接覆盖或删除已有资料。

---

## 第一次使用

1. 安装用户脚本
2. 打开或刷新 ChatGPT
3. 点击页面右侧的「⇄」入口
4. 进入「导出」
5. 选择电脑中的一个文件夹作为本地资料库
6. 开始第一次保存

第一次保存完成后，这个文件夹就会作为长期 Conversation 资料库。

以后有新的聊天，或者原有聊天发生变化，再同步一次即可。

如果需要更完整的安装和使用说明，可以直接下载上面的 **123 云盘完整包**，其中包含图文安装教程和使用说明书。

---

## 数据安全原则

AI 对话流转优先保证已经保存到本地的 Conversation 不会因为一次同步异常而被轻易覆盖或删除。

在无法安全判断远端或本地状态时，工具会优先停止自动处理并提示检查，而不是为了表面上的“同步完成”牺牲已有资料。

---

## 当前支持

目前适配 ChatGPT 网页端：

- `https://chatgpt.com/*`
- `https://chat.openai.com/*`

---

## 当前版本

### v2.9.85

2.9.85 是当前正式版本。

这一版在原有增量保存基础上，重点完成了：

- 新的 `00_原始 / 01_JSON / 02_Markdown / 03_PDF / 10_项目 / 11_归档 / 12_已删除 / 90_工程文件` 资料库视图
- ChatGPT Project 与本地命名分类双视图
- 更完整的筛选与按需提取流程
- Markdown / Word / PDF 等格式输出
- PDF 数学公式渲染
- 旧资料库安全升级
- 大资料库首次保存时的 429 自动等待与恢复
- 空目录误升级、公式、状态反馈等问题修复

---

## 视频教程

2.9.85 的完整演示：

[🎬 ChatGPT聊天记录怎么导出到本地？新版支持 Project、Markdown、Word、PDF｜2.9.85](https://www.bilibili.com/video/BV1ctbA6XELL/)

---

## License

MIT License
