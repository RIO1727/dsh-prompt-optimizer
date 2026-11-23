# dsh-prompt-optimizer

简体中文 · [English](./README.md)

给 [DeepSeek Harness](https://github.com/deepseek-ai) 输入框加一个**AI 提示词优化**按钮的插件：✨ 按钮就贴在**发送**键左边，和 Work Buddy 的提示词优化位置、交互一致。点一下，把输入框里那句半成品念头改写成真正可执行的提示词，再放回输入框——可以直接发送，也可以一键撤销。

```
┌─────────────────────────────────────────────┐
│  你那句随手写的草稿……                        │
│                              ✨  ➤          │  ← ✨ = 优化提示词，➤ = 发送
└─────────────────────────────────────────────┘
  ✓ 已优化，可以直接发送，也可以撤销。  [撤销] [×]
```

整个过程不会往对话里追加任何消息：优化是一次旁路调用，只改写你还在编辑的那段文字。

## 功能

- **只加一个按钮，就在发送键左边。** 它注册在 `conversation.input.right` 插槽——Harness 自己定义的「发送动作之前的紧凑控件」行——因此主题、密度、窗口宽度怎么变，它都跟着输入框走。
- **改写草稿，不动会话。** 当前草稿连同提示词工程师系统提示一起发给模型，改写结果原地替换草稿。不产生对话轮次，不消耗你没要求的上下文。
- **天然忠实。** 系统提示明确禁止新增事实、数字、路径、名称与约束，禁止扩大或缩小需求范围，保持草稿语言，并原样保留代码块、URL 和 `@文件` 引用。
- **一键撤销。** 输入框下方会出现状态条，点**撤销**即可还原成原文。
- **绝不覆盖你的输入。** 请求在途时你改过草稿，结果就*不会*写回，而是给你一条提示和显式的**仍然替换**按钮。
- **失败也说得清楚。** 空草稿、斜杠命令模式、草稿过长、未选模型、模型报错或超时，都会在输入框下方显示成一句话，按钮不会静默失败。
- **中英双语**，跟随 Harness 的语言设置。
- **零配置。** 复用当前会话已选的模型、provider 和凭据——插件不持有任何 API Key，没有额外依赖，也不需要构建。

## 安装

### 交给 agent（推荐）

让 DSH 里的 agent 帮你装，或者直接用 harness 的插件管理器指向本包：

```text
plugin_manager action=install_bundle target=dsh-prompt-optimizer
```

DSH 提示需要重启时，重启 DSH 即可。这个 bundle 会同时挂上两半——Host 路由和输入框按钮。

### 手动安装

1. 把包加进你的 profile（npm、git 地址或本地 checkout 都行）：

   ```bash
   cd ~/.dsh/profiles/desktop
   pnpm add dsh-prompt-optimizer            # 或：pnpm add link:/path/to/dsh-prompt-optimizer
   ```

2. 在该目录的 `package.json` 里把它加进 `dsh.profile.bundles`：

   ```json
   "dsh": { "profile": { "bundles": [ "...", "dsh-prompt-optimizer" ] } }
   ```

3. 重启 DSH。任意会话里，发送键左边就会出现那个按钮。

### 自检 Host 半侧

插件只注册一条路由。DSH 运行时执行：

```bash
curl http://127.0.0.1:<端口>/dsh-prompt-optimizer/health
# {"ok":true,"version":"1.0.0","route":"/dsh-prompt-optimizer","llm":true,"model":"deepseek-account/deepseek-flash","maxChars":12000}
```

## 配置

全部可选项；随包提供的 `cordis.patch.yml` 里 `config` 是空的，每一项都有可用默认值。

| 配置键 | 默认值 | 含义 |
| --- | --- | --- |
| `maxChars` | `12000` | 接受的最长草稿字符数（夹在 200–40000）。 |
| `timeoutMs` | `90000` | 模型调用预算，毫秒（夹在 5000–300000）。 |
| `temperature` | `0.6` | 改写时的采样温度（0–2）。 |
| `reasoning` | `"off"` | `"off"` 关闭深度思考（更快更省）；`"keep"` 沿用模型默认。模型不声明该档位时不发送。 |
| `provider` | 跟随会话 | 强行指定 provider。 |
| `model` | 跟随会话 | 强行指定模型。 |

示例（`cordis.patch.yml`）：

```yaml
- id: dsh-prompt-optimizer
  name: dsh-prompt-optimizer
  config:
    maxChars: 8000
    temperature: 0.4
```

## 工作原理

```text
Client 半侧 (client.js)                    Host 半侧 (index.js)
┌────────────────────────────┐             ┌──────────────────────────────┐
│ conversation.input.right   │  POST       │ /dsh-prompt-optimizer/optimize│
│  ✨ 按钮                   │ ─────────►  │  · 唯一的模型调用              │
│ 经 conversation.input.for()│  {text}     │  · ctx.llm + 会话已选模型      │
│ 读写草稿                   │ ◄─────────  │  · 剥掉代码围栏与“优化后：”标签 │
│ conversation.composer.dock │  {text}     │  · 90s 中止、最多 2 个并发      │
└────────────────────────────┘             └──────────────────────────────┘
```

- **Host 半侧**负责模型调用，因为浏览器既没有凭据也没有 provider 访问能力。它读取会话当前模型（`ctx.agentDefaultModel`），用提示词工程师系统提示经 `ctx.llm` 流式生成一次，清洗输出（代码围栏、`优化后的提示词：` 前缀）后回 JSON。它强制 256 KiB 请求体上限、`maxChars` 草稿上限和最多 2 个并发改写；客户端断开或超时都会中止模型流。
- **Client 半侧**只注册两个插槽面——`conversation.input.right` 放按钮、`conversation.composer.dock` 放提示条——并通过 conversation 服务读写草稿，不碰输入框的 DOM。每次写回都带上下发前观察到的草稿版本号，因此你同时在编辑的草稿不会被静默覆盖。样式只用 `--dsw-alias-*` 主题令牌，并集中注入到一个 `<style>` 元素里，因此跟随明暗主题与皮肤，热重载也不会泄漏。

## 隐私

- 草稿只发往**你自己的**模型服务商，用的是**你自己的**账号——正是当前会话本来就在用的 provider 与凭据。没有第三方服务、没有遥测、没有统计。
- 不会写入任何对话记录，撤销即可还原原文。
- HTTP 路由仅同源可达、只接受相对地址、不缓存，错误一律以 JSON 返回。

## 要求

- 带 Web UI 的 DSH（插槽 API 是 Web UI 的契约）。针对 DSH 桌面版 0.2.x Web UI 构建并测试。
- 会话里已经选好模型（任何有凭据的 provider 都行）。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 发送键旁边没有 ✨ 按钮 | 装完 bundle 后 DSH 需要重启；先确认 `dsh.profile.bundles` 里有 `dsh-prompt-optimizer`，再重启。 |
| 提示「没找到当前会话的输入框」 | 插槽渲染在会话作用域之外——刷新页面，进入一个会话再试。 |
| 提示「优化失败：… no model configured」 | 在会话里选个模型，或在配置里指定 `provider`/`model`。 |
| 一直提示「上一条优化还没结束」 | 这个 DSH 实例里已有 2 个改写在进行，等它们结束。 |
| 草稿很长时按钮只弹提示 | 超过 `maxChars` 会被拒绝——精简草稿，或调大 `maxChars`。 |

## 开发

纯 ESM，无构建步骤，除 harness 本身外无运行时依赖：

```text
index.js          Host 半侧：配置、/dsh-prompt-optimizer 路由、模型调用
client.js         Client 半侧：输入框按钮、提示条、多语言与样式
cordis.patch.yml  bundle patch：挂载 Host 半侧的那一行 loader 配置
locale/*.json     插件列表里的标题与简介
icon.svg          原创图标
test/             两半侧的离线测试（桩 React、桩 ctx、桩 llm）
```

`node --check index.js client.js` 就是全部静态检查。测试不需要装 DSH，纯 Node + 一个由 resolve hook 接进去的 `@deepseek-ai/dsh-llm` 桩：

```bash
node --import ./test/shim.mjs test/host.test.mjs   # 22 项：路由、错误码、模型调用接线
node test/client.test.mjs                          # 24 项：插槽、按钮、撤销、草稿并发保护
```

把目录作为 link bundle 装上并重启 DSH 即可试改。

## 许可

[MIT](./LICENSE)
