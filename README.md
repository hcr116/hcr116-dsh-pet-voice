# dsh-pet-voice · 给 dsh-pet 装一张嘴

把 DSH 的回答念给网页里那只大肥鱼听：**气泡 + 说话动画 + 本鲸的克隆嗓**。

dsh-pet 负责「身体」（形象、动画、气泡、位置），本插件只管「说话」这一件事。

```
一轮回答结束（agent/turn-stopping）
  └─ 取这一轮最后一条助手消息
       └─ 挑一句短的（有 `口播：` 就念那行，没有就规则兜底，最多 40 字）
            ├─ → dsh-pet：lock → broadcast → release   气泡 + 说话动画（约 50ms）
            └─ → 本机 GPT-SoVITS 127.0.0.1:9880/tts     克隆嗓合成 wav（约 1~3s）
                 └─ PowerShell System.Media.SoundPlayer 念出来
```

## 装（本机已装好，这段是重装时用的）

```bash
dsh plugin --profile desktop add "C:/Users/Administrator/.dsh/plugins/dsh-pet-voice"
```

装完**重开 DSH**。它没有客户端半边（dsh.client），所以不参与浏览器启动检查——就算它自己坏了也砸不到界面。

## 配

配置文件 `~/.dsh/dsh-pet-voice.json`，**每次说话现读**，改完不用重启：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉只留 dsh-pet 自己的碎碎念 |
| `petId` | `main` | 说话的那只宠物（dsh-pet 的 `pets[].id`） |
| `surface` | `web` | 必须和那只宠物的 `display` 对上，否则 dsh-pet 回 `pet-not-displayed` |
| `bubbleMs` | `9000` | 气泡停留毫秒 |
| `voice` | `local` | `local` = GPT-SoVITS 克隆嗓；`off` = 只出气泡不出声 |
| `maxChars` | `40` | 一句话最多几个字 |
| `sovits.url` | `127.0.0.1:9880` | GPT-SoVITS 服务 |
| `sovits.refAudio` | `D:\DafeiyuVoice\ref\dwg_0002.wav` | 参考音（别人的声音，别外传） |
| `sovits.promptText` | 参考音对应的那句话 | 必须和参考音一致，否则音色跑偏 |
| `sovits.speed` | `1` | 语速，0.5~2 |

## 调（自己听一句）

```bash
curl -X POST http://127.0.0.1:<DSH网页端口>/dsh-pet-voice/say -H "content-type: application/json" -d "{\"text\":\"试音，本鲸的嗓子还活着。\"}"
curl http://127.0.0.1:<DSH网页端口>/dsh-pet-voice/state
```

端口就是 DSH 网页的端口（`dsh web` 打出来的那个，本机 7745）。这两个路由只绑 127.0.0.1、不鉴权，和 dsh-pet 自己的接口同一个口径。

## 不念什么

- 只念**一轮最后的**那条助手消息（中途的工具调用、思考过程不念）。
- 代码块、表格、标题、引用、链接、超长段落都不念，挑第一句像人话的。
- 想指定念哪句，在回答里写一行 `口播：xxx`。

## 三条别踩的坑（写在这里免得下次又踩）

1. **不注册任何 systemPrompt / persona 段**。人格由 `dsh-agent-md` 注入一次就够；再注册一遍 = 同一段 prompt 进两次，DSH 直接起不来（隔壁公司那台就这么崩的）。
2. **不写静态 `inject` 里没有的服务**。客户端半边要有也只用动态 `ctx.inject([...], cb)`；宿主侧只 inject 核心 `agents` / `sessions`，`webServer` 惰性 `ctx.get()` 拿。
3. **`peerDependencies` 里不写 `@deepseek-ai/dsh-*`**，DSH ≥0.2.0 会对不上的 peer 静默丢包。写文件一律不带 BOM（`Unexpected token '\ufeff'`）。

## 和别的插件的关系

- `dsh-pet-bridge`（本地 link）本来是给**桌面那只 C# 大肥鱼**喂话的，它现在不在 `bundles` 里，没在跑。两边不冲突，但别同时开两个声音。
- `dsh-speak-up` 是「主动起话头」，它起的话也会被这里念出来（它本身就是一轮回答）。
- `dsh-pet` 自己的 `whisperEnabled` 建议关掉（`~/.dsh/dsh-pet/main-config.jsonc` 里已经是 `false`）：那个碎碎念每轮都调模型，烧 token 还顶 KV cache。
