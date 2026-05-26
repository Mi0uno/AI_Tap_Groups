# AI Tab Grouper

**AI-powered tab grouping for Microsoft Edge**

_用你配置的 AI 模型，自动整理 Edge 标签页分组。_

![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue?style=flat-square)
![Microsoft Edge](https://img.shields.io/badge/Microsoft%20Edge-supported-0A84FF?style=flat-square)
![Chrome APIs](https://img.shields.io/badge/Chrome%20Extension%20APIs-tabs%20%7C%20tabGroups%20%7C%20alarms-green?style=flat-square)
![No Build Step](https://img.shields.io/badge/build-none-lightgrey?style=flat-square)

## 项目概述

**AI Tab Grouper** 是一个 Microsoft Edge Manifest V3 扩展。它读取当前浏览器窗口或全部窗口的标签页标题、域名和 URL 摘要，调用 OpenAI 兼容的 Chat Completions 接口，让 AI 判断哪些标签页应该放到同一个 Edge 原生标签组里。

它同时支持：

- 用户点击后立即整理。
- 后台静默自动整理。
- 已有分组的增量整理和去重。
- AI 调用失败后的本地域名兜底分组。

> 目标不是简单按域名分组，而是让 AI 根据页面标题、站点和上下文做更接近人工习惯的标签页整理。

## 核心特性

| 能力 | 说明 |
| --- | --- |
| 手动分组 | 点击弹窗按钮或按 `Alt+Shift+G` 提交后台任务，弹窗关闭后仍继续执行。 |
| 后台静默分组 | 标签页变化后，发现有可处理的未分组标签页，会按秒级延迟自动整理。 |
| 增量整理 | 后台模式优先保留已有分组，只处理未分组新标签页。 |
| 全量重排 | 用户手动触发时，默认先解除当前范围内已有分组，再由 AI 统一重排。 |
| 分组去重 | 增量整理会合并近似重复组，并让 AI 通过 `existingGroupId` 并入已有组。 |
| 内容细分 | 同一视频网站的多个页面可继续细分为搜索、番剧/国创、视频、课程、音乐等类型。 |
| 网关过滤 | 调用 AI 前先本地判断是否有值得分组的候选标签，减少无效 token 消耗。 |
| 不可分组标记 | 自动模式下，暂时无法分组的标签会被标记并跳过，直到该标签关闭。 |
| 隐私开关 | 默认不发送完整 URL，可手动开启。 |
| AI 超时 | 默认 60 秒超时，超时后显示原因并使用本地兜底规则。 |

## 快速开始

### 前置要求

| 项目 | 要求 |
| --- | --- |
| 浏览器 | Microsoft Edge，开启扩展开发人员模式 |
| AI 服务 | OpenAI 兼容 Chat Completions 接口 |
| 构建工具 | 不需要 |

### 本地加载扩展

1. 打开 Edge，访问 `edge://extensions/`。
2. 开启“开发人员模式”。
3. 点击“加载解压缩的扩展”。
4. 选择项目目录：

```text
E:\xxx\AI_Tap_Groups
```

5. 点击扩展图标，配置接口地址、API Key 和模型名。
6. 点击“保存并分组”或右上角分组按钮。

> 修改代码后，需要回到 `edge://extensions/` 刷新扩展，新的 background service worker 才会生效。

## 配置说明

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| 接口地址 | `https://api.openai.com/v1/chat/completions` | OpenAI 兼容 Chat Completions URL。 |
| API Key | 空 | 你的 AI 服务密钥，存储在 `chrome.storage.local`。 |
| 模型 | `gpt-4.1-mini` | 用于分类标签页的模型名。 |
| 范围 | 当前窗口 | 可选择当前窗口或全部窗口。 |
| 最多分组 | `8` | 扩展侧允许配置到 `999`；实际数量取决于标签页数量和浏览器运行限制。 |
| AI 超时秒数 | `60` | 请求超过该时间会走本地兜底。 |
| 分组前缀 | 空 | 可选，为新分组标题加前缀。 |
| 包含固定标签页 | 关闭 | 默认不处理 pinned tabs。 |
| 发送完整 URL | 关闭 | 默认只发送 `origin + pathname`，减少隐私暴露。 |
| 后台静默自动分组 | 关闭 | 开启后按标签页事件自动整理。 |
| 延迟秒数 | `5` | 标签页变化后等待标题/URL 稳定再整理，范围 `1-60` 秒。 |

## AI 服务示例

默认 OpenAI 兼容接口：

```text
https://api.openai.com/v1/chat/completions
```

DeepSeek 可使用：

```text
https://api.deepseek.com/chat/completions
```

DeepSeek V4 Pro 可填写：

```text
deepseek-v4-pro
```

扩展检测到 DeepSeek V4 请求时，会自动加上：

```json
{
  "thinking": { "type": "disabled" }
}
```

这类标签分类任务通常不需要深度推理，关闭 thinking 可以减少等待时间。

## AI 返回格式

全量分组时，AI 需要返回：

```json
{
  "groups": [
    {
      "name": "资料阅读",
      "color": "blue",
      "tabIds": [101, 102, 103]
    }
  ]
}
```

增量分组时，AI 可以把新标签并入已有组：

```json
{
  "groups": [
    {
      "name": "B站视频",
      "existingGroupId": 12,
      "color": "pink",
      "tabIds": [204]
    }
  ]
}
```

支持的颜色来自浏览器 `tabGroups` API：

```text
blue, red, yellow, green, pink, purple, cyan, orange, grey
```

## 分组策略

### 手动分组

手动触发包括：

- 弹窗顶部图标按钮。
- “保存并分组”按钮。
- 快捷键 `Alt+Shift+G`。

手动任务会写入后台状态，由 service worker 继续执行。即使关闭弹窗，任务也不会取消。再次打开弹窗可以看到最近任务状态。

手动模式默认使用全量重排：

1. 收集目标范围内可处理的标签页。
2. 解除这些标签页已有分组。
3. 调用 AI 重新规划。
4. 创建 Edge 原生标签组。

### 后台静默分组

后台模式打开后：

1. 监听标签页创建、更新、移动、关闭等事件。
2. 本地网关判断是否还有可处理的未分组标签。
3. 按“延迟秒数”做秒级 debounce。
4. 优先增量整理已有分组。
5. 每 5 分钟做一次内部兜底检查，防止 service worker 被挂起后漏处理。

后台模式不会盲目调用 AI。它会先过滤：

- 已经分组的标签页。
- 已被标记为不可分组的标签页。
- 单个且无法并入现有组的孤立标签页。

## 已有分组处理

后台增量整理会尽量尊重已有分组：

- 如果已有分组覆盖大部分标签页，使用增量整理。
- 如果几乎没有可用分组，使用全量重排。
- 新标签页优先按域名并入明确匹配的现有组。
- 域名匹配不明确时，让 AI 基于现有组上下文判断。
- 标题近似重复的现有组会先被合并。

例如已有：

- `B站搜索`
- `B站视频`
- `B站国创`

新增 Bilibili 标签时，AI 会结合标题和 URL 判断它更像搜索页、普通视频、番剧/国创、课程还是其他内容，而不是继续创建新的 `Bilibili` 泛分组。

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `tabs` | 读取标签页标题、URL、窗口和分组状态。 |
| `tabGroups` | 创建、更新和合并 Edge 原生标签组。 |
| `storage` | 保存 AI 配置、后台任务状态、自动分组指纹和不可分组标记。 |
| `alarms` | 支持 Manifest V3 service worker 的后台任务和兜底检查。 |
| `http://*/*` / `https://*/*` | 调用用户配置的 AI 接口。 |

## 隐私与安全

- API Key 存储在 `chrome.storage.local`，适合本地自用。
- 默认不发送完整 URL，只发送域名和路径摘要。
- 开启“发送完整 URL”后，URL 查询参数等信息可能被发送给 AI 服务。
- 如需发布到商店或团队使用，建议改为后端代理、企业托管配置或 OAuth，不要长期把敏感密钥放在浏览器本地。

## 项目结构

```text
AI_Tap_Groups/
├── manifest.json
├── README.md
└── src/
    ├── background.js
    ├── popup.html
    ├── popup.css
    └── popup.js
```

| 文件 | 说明 |
| --- | --- |
| `manifest.json` | Manifest V3 扩展声明、权限、快捷键和入口。 |
| `src/background.js` | 核心逻辑：任务队列、自动分组、AI 调用、分组应用。 |
| `src/popup.html` | 扩展弹窗结构。 |
| `src/popup.css` | 弹窗样式。 |
| `src/popup.js` | 表单读写、任务提交和后台任务状态展示。 |

## 开发与校验

本项目没有构建步骤，直接加载源码即可。

语法检查：

```powershell
node --check src\background.js
node --check src\popup.js
Get-Content manifest.json | ConvertFrom-Json | Out-Null
```

调试建议：

- 修改代码后刷新 `edge://extensions/` 中的扩展。
- 点击扩展卡片里的 service worker 链接查看后台日志。
- 如果弹窗提示不支持某个消息类型，通常是扩展未刷新，旧 service worker 仍在运行。

## 常见问题

### 为什么点击分组后弹窗关闭了也能继续？

手动分组会先写入后台任务状态，再通过 `chrome.alarms` 唤醒 service worker 执行。弹窗只是提交任务和查看状态，不承担长时间运行。

### 为什么有些标签页没有被自动分组？

自动模式会先做本地网关过滤。单个无法并入现有组的标签、AI 尝试后仍未分入组的标签，会被标记为不可分组，直到标签关闭。

### 为什么没有真实秒级轮询？

Manifest V3 的 background service worker 不是常驻进程。扩展使用标签页事件 + 秒级 debounce 做主触发，再用 `alarms` 做兜底恢复，这是更符合 MV3 运行模型的实现。

### AI 不可用时会怎样？

请求失败、超时或未配置 API Key 时，会按域名做本地兜底分组。

### 最多分组为什么不是固定官方数值？

官方 `tabGroups` API 没公开固定组数上限。扩展侧把输入上限设为 `999`，避免人为限制；实际能创建多少组取决于当前标签页数量和浏览器运行状态。

## 参考资料

- [Microsoft Edge extension manifest format](https://learn.microsoft.com/en-us/microsoft-edge/extensions-chromium/getting-started/manifest-format)
- [Chrome Extensions `tabs` API](https://developer.chrome.com/docs/extensions/reference/api/tabs)
- [Chrome Extensions `tabGroups` API](https://developer.chrome.com/docs/extensions/reference/api/tabGroups)
- [Chrome Extensions `storage` API](https://developer.chrome.com/docs/extensions/reference/api/storage)
- [Chrome Extensions `alarms` API](https://developer.chrome.com/docs/extensions/reference/api/alarms)
- [OpenAI Chat Completions API reference](https://platform.openai.com/docs/api-reference/chat)
