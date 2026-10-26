# dsh-pet-bridge

让 `D:\DafeiyuPet` 那个 WPF 桌宠把话递进 DSH、再把本鲸的回答递回去；顺带把桌宠录的音交给 DSH 自带的 SenseVoice 认字。

```
桌宠  POST /stt（裸 WAV）    →  ctx.speechToText.transcribe()  →  {text}
桌宠  POST /say {text}      →  agent.followup(user 消息) → DSH 自己开一轮（人格/历史/工具全自带）
本鲸  assistant/message     →  收件箱
桌宠  GET /feed?after=N     →  取走朗读
```

## 端口

默认 **43110**，只绑 `127.0.0.1`。要改就在 `~/.dsh/pet-bridge.json` 写：

```json
{ "port": 43111 }
```

桌宠那边对应的配置在 `%APPDATA%\DafeiyuPet\config.json` 的 `Bridge.Url`。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/ping` | `{ok, 会话, 待答, 未取, 序号, 语音, 就绪}`，桌宠探活用 |
| GET | `/sessions` | 现在有哪些会话可选（`id` / `title` / `active`） |
| POST | `/say` | 体 `{"text": "...", "session": "可选"}`；不指定就用最近活跃的会话 |
| GET | `/feed?after=N` | `{ok, last, items:[{seq, text, ts}]}`，只回 `seq > N` 的 |
| GET | `/stt/status` | `{ok, 服务, provider, phase, step, progress, 就绪, message}` |
| POST | `/stt/prepare` | 主动开始下模型：已就绪 200，开始下 202 |
| POST | `/stt` | 体是**裸 WAV**（16 kHz / 单声道 / PCM16，≤ 4 MB）→ `{ok, text, audioSeconds, inferenceSeconds}` |

## 认字（`/stt`）怎么走

- 转写用 DSH 自己的语音服务（`inject: ['speechToText']`，`ctx.speechToText`），**插件不带模型、不起子进程**。
- 格式是死的：DSH 的 `resolve()` 逐字段校验 RIFF 头（采样率必须 16000、blockAlign 2、16 bit），不对就抛 `SpeechInputError` → 这里回 400 `bad-audio`。
- 模型没下过时（`~/.dsh/speech-to-text` 不存在）：第一次 `POST /stt` 会**顺手调 `prepare()` 开始下载**，然后回 **425** `{code:'preparing', phase, progress}`。桌宠看到 425 就说「等本鲸把耳朵准备好」，过一会儿再按一次就行。
- 下载源固定用 `https://hf-mirror.com`（必须是 provider 的 `modelOrigins` 里有的 origin，否则 `prepare()` 直接抛）。

## `/feed` 里只放「口播句」（v1.3）

DSH 的正式回复常有表格、路径、清单，桌宠念出来又长又难听。所以进收件箱前先挑一句：

1. 回复里有 `口播：……` 这一行 → 只送这一行（超 40 字在标点处切）；
2. 没有 → 规则兜底：去掉代码块 / 行内代码 / 链接 / markdown 符号，取第一句（≤ 60 字）；
3. 挑不出来 → 这条不进 `/feed`（总比念一串乱码好）。

`口播：` 是约定不是协议，写不写都能跑。单测：`node speech-test.mjs`（6 例）。

## 为什么不用 `ctx.webServer`

DSH 的网页端口在登录鉴权后面（`curl http://127.0.0.1:<port>/` 直接 401），桌宠是外部进程，进不去。所以本插件自己起一个原生 `node:http`，只绑回环。

## 为什么必须走 `agent.followup`

那样才是 DSH 自己的回合 —— 模型照常被调用，历史是会话自己的历史，工具是会话自己的工具。自己拼上下文往会话里塞死文字是假开口。

⚠ `followup` 必须 `await` + `try/catch`：它的 rejection 在 Node 22+ 是**未处理拒绝 = 宿主进程退出**（2026-10-21 有人踩过"装了鱼就死了"）。

## 联调

```bash
# 假 ctx 把桥跑起来（43110），收到 /say 就模拟本鲸回一句，/stt 给一个假转写器
node mock-server.mjs
# 或者：/stt 三连测（自己起 43112，不跟桌宠抢）
node stt-test.mjs
```

桌宠侧自测台在 `D:\DafeiyuPet\.selftest\`（`dotnet run --project Test.csproj`；`silence.wav` 是 1 秒静音，用来试 `/stt`）。
