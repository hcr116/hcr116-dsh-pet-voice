# 大肥鱼 · 语音入口（dsh-pet-voice）

给 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 这只网页桌宠补上两件事：

1. **听你说**：在 DSH 窗口里按住 `Ctrl+U` 说话，松手后本地转写，文字落进当前会话的输入框，你自己按回车发出去。
2. **开口回你**：每一轮回答结束后，从回答里挑一句，克隆嗓（本机 GPT-SoVITS）念出来，同时桌宠冒气泡、做说话动画。

> 上一版是 C# WPF 的桌面宠物（能在桌面漂、能按 U 说话、能读 QQ 消息）。那一套的源码已从本仓库删除，需要翻旧账就 `git show v1-csharp-pet`。

## 它怎么挂上去的

```
你按住 Ctrl+U
   → 网页半边 lib/client.js：录音 16 kHz 单声道 PCM16 WAV
   → POST /dsh-pet-voice/stt
   → 宿主半边 index.js：ctx.speechToText（SenseVoice，本机）
   → 文字插到输入框光标处（不覆盖你已打的字）
   → 你按回车，DSH 走普通一轮（人格、历史、工具、记忆都在）
   → 回答结束 → 挑一句 → 气泡 + GPT-SoVITS 念
```

设计文档（策划视角，含流程图、挑句规则、出错对照、验收清单）：
[`docs/语音入口-设计-v1.html`](docs/语音入口-设计-v1.html) · 源文件 [`docs/设计稿源.archify.md`](docs/设计稿源.archify.md)

## 装

```bash
# 1) 装身体（网页版，不下载 Electron）
dsh plugin --profile desktop add dsh-pet

# 2) 装这个插件（用绝对路径 link，别用相对路径，dsh 会把相对路径解析到盘符根）
dsh plugin --profile desktop add C:/Users/Administrator/.dsh/plugins/dsh-pet-voice

# 3) 确认它进了 profile 的 bundles（dsh 不会自动把已存在的依赖补进 bundles，要手工加）
#    ~/.dsh/profiles/desktop/package.json → dsh.profile.bundles 末尾加 "dsh-pet-voice"

# 4) 重启 DSH
```

`package.json` 里必须同时有三样东西，缺一个网页半边就不会被加载：

```json
"exports": { ".": "./index.js", "./client": "./lib/client.js" },
"dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "platform": "web", "inject": ["slots"], "external": ["react"] } }
```

## 配

配置在 `~/.dsh/dsh-pet-voice.json`，**每次说话现读**，改完不用重启：

```jsonc
{
  "enabled": true,
  "petId": "main",          // dsh-pet 里的宠物 id
  "surface": "web",         // 必须是网页版；要让桌面窗也显示就改成 both
  "bubbleMs": 9000,         // 气泡挂多久
  "voice": "local",         // local = 克隆嗓，失败自动退 sapi；sapi = 只用系统嗓子；off = 只冒泡不出声
  "sapi": { "voice": "", "rate": 0, "volume": 90 }, // voice 留空自动挑中文女声
  "maxChars": 40,           // 一句念多长
  "mainSessionOnly": true,  // 只念你正看着的那个会话（子代理会话不念）
  "sovits": {
    "url": "http://127.0.0.1:9880",
    "refAudio": "D:\\DafeiyuVoice\\ref\\dwg_0002.wav",
    "promptText": "什么嘛，这么简单的事情，你居然专门跑来问我。",
    "lang": "zh",
    "speed": 1,
    "timeoutMs": 3000       // 超过就退 SAPI，别让人等
  }
}
```

`voice: "local"` 需要先起 GPT-SoVITS（本机 `D:\DafeiyuVoice\start-tts.vbs`）。没起也不会哑：3 秒判失败，自动换成系统嗓子。

## 挑句规则（不随机）

1. 回答里如果有 `口播：` / `口播词：` / `播报：` 开头的一行，就念那一行（人格 v1.17 起会主动写）。
2. 没有就取第一句能念的。
3. 都不行就只冒泡不出声。

念之前先清：代码块整段丢掉、`|` 开头的表格行、`#` 标题、`>` 引用、路径与命令、纯英文串、markdown 符号、emoji。**鱼鱼不念代码。**

## 调试路由

全在 `http://127.0.0.1:7745`（端口取 DSH 自己的 webserver）：

| 路由 | 作用 |
| --- | --- |
| `GET /dsh-pet-voice/state` | 现在什么状态：语音服务就绪没、前台是哪个会话、队列、上次说了什么 |
| `POST /dsh-pet-voice/say` `{"text":"…"}` | 让鱼鱼念一句（不进对话） |
| `POST /dsh-pet-voice/focus` `{"sessionId":"…"}` | 网页半边挂载时自己报的，不用手动调 |
| `POST /dsh-pet-voice/stt` `{"audioBase64":"…"}` | 转写（web 半边用）；服务没准备好回 425 |

## 测

```bash
node --test tests/host.test.mjs tests/client.smoke.mjs tests/integration.test.mjs
```

14 个用例，不需要网络也不需要 DSH 在跑：

- `tests/host.test.mjs` — 挑句规则、去表情、路由（前台会话、503、短音频、空文本）
- `tests/client.smoke.mjs` — 网页半边用假 `ModuleLoader` 跑一遍，验注册形状与 WAV 头（PCM=1 / 单声道 / 16000 / 16 bit / data 长度）
- `tests/integration.test.mjs` — 起假的 dsh-pet 与假的 GPT-SoVITS，验 `lock → broadcast → release` 三次请求、`?surface=` 与 `lock=` 参数、payload 字段，以及超时降级

想单独验系统嗓子：`PETVOICE_SILENT_WAV=C:/tmp/a.wav node -e "import('./index.js').then(m=>m.__test.念SAPI('测试',{}))"`（写文件，不外放）。

## 踩过的坑（v2 才修好）

这两处任何一个都会让「按 Ctrl+U 什么都不发生」，而且**都不报错、不影响启动**，只会在浏览器控制台里留一行：

- **宿主半边**：`apply(ctx)` 那一刻 `ctx.get('webServer')` / `ctx.get('speechToText')` 都还是 `undefined`。必须写成
  `ctx.inject(['webServer'], 范围 => 范围.effect(() => 范围.webServer.register(...)))`，
  转写同理（`ctx.inject(['speechToText'], 范围 => …)`）。v1 用 `ctx.get` 拿端口和路由，结果路由一条都没注册、`/dsh-pet-voice/*` 全 404。
- **网页半边**：不能自己用 `ctx.inject(['slots'], …)` 去取插槽——那样拿到的作用域读 `slots` 会抛
  `cannot get property "slots" without inject`。正确写法是静态 `inject = ['slots']` + `ctx.slots.inject('conversation.input.overlay', function* () { yield ctx.slots.register(...) })`，和 dsh-pet、官方语音输入一致。

## 已知限制

- **网页半边改动必须重启 DSH 才生效**。`dsh --profile desktop` 被 Electron 独占，CLI 不能二次启动；`--dump-config` 也一样被拒。
- `Ctrl+U` 是浏览器「查看源代码」的快捷键，页面里要 `preventDefault` 抢；抢不到会自动改认 `Ctrl+Shift+U`。热键只在 DSH 窗口聚焦时有效（网页拿不到全局键盘）。
- 录音按 16 kHz / 单声道 / PCM16 固定，这是 DSH 转写服务的硬要求，改不了。
- 克隆嗓有 1~3 秒合成延迟，气泡先到、声音后到。
- 说话时会掐掉上一句（只念最新），所以连发两条只听到第二条。
