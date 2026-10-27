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

## 能力开关：给「打包给别人用」准备的

这台机器有什么，不一定是别人那台有什么。所以三个能力各有 **`auto` / `on` / `off`** 三档：

| 档 | 意思 |
| --- | --- |
| `auto`（默认） | 自己探测；探不到就**静默关掉**，只在 `~/.dsh/dsh-pet-voice.log` 里留一行 |
| `on` | 强制启用；探不到会**提示一次**（好让你知道哪里没配好） |
| `off` | 连探测都不做 |

| 能力 | 配置 | `auto` 时探什么 | 探不到 |
| --- | --- | --- | --- |
| **说** | `speak.mode` + `speak.provider` | `local`：TCP 连一下 SoVITS；`sapi`：Windows 自带 | 只冒泡，不出声 |
| **听** | `listen.mode` | DSH 有没有语音识别服务 | 输入框旁的入口**置灰**，点一下说原因 |
| **提醒** | `dida.mode` | 本机能不能读到滴答的登录凭证 | 整个模块不启动，一句都不提 |

装好第一次启动会冒一句体检（只提一次，记在 `~/.dsh/dsh-pet-voice/first-run.json`；删掉它就会再说一遍，`firstRunReport: false` 可永久关掉）：

```
鱼鱼在。这台能：说话、嘀嗒提醒。没有：麦克风。
```

**三种典型机器**

| 机器 | 建议配置 |
| --- | --- |
| 只有 Windows 的办公机 | 全默认（`auto`）：能出声、能念嘀嗒，没麦就灰着 |
| 家里那台（SoVITS + 麦 + 嘀嗒） | 全默认会自动全开；想强制就写 `"on"` |
| 别人的机器 | 一个字都不用改：没装滴答就不提提醒，没麦就把入口置灰 |

完整模板见 [`config.example.json`](config.example.json)。

### 旧配置兼容

以前那种写法照旧能用，读的时候映射过来：

| 老键 | 等价于 |
| --- | --- |
| `voice: "off"` | `speak.mode: "off"` |
| `voice: "sapi"` | `speak.provider: "sapi"` |
| `voice: "local"` | `speak.provider: "local"` |
| `hotkey: "Ctrl+U"` | `listen.hotkey` |
| `dida.enabled: false` | `dida.mode: "off"` |

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

### 嘀嗒清单的「到点提醒」

到点了鱼鱼冒个泡 + 念一句。**只念你已经在嘀嗒里配了提醒的任务**（没配提醒的到期限也不念）。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `dida.enabled` | `true` | 关掉就不拉嘀嗒 |
| `dida.pollSeconds` | `120` | 多久重新拉一次任务（到点触发靠本地定时器，不受这个影响） |
| `dida.mergeWindowMs` | `2000` | 同一分钟几条撞一起时，攒这么久合成一句 |
| `dida.quietFrom` / `quietTo` | `23:00` / `08:00` | 安静时段：**只冒泡不出声**；两个都填空 = 不设 |
| `dida.cookie` | 空 | 一般不用填。空 = 自动从本机客户端读 |
| `dida.dbPath` | 空 | 空 = `%APPDATA%\Tick_Tick\TickTick.db` |

**凭证怎么来的**：读本机滴答客户端 SQLite 里 `CommonSettings.LoginUserAuth`，直接当 Cookie 的 `t=` 用。
你在客户端重新登录，凭证自己就更新了，不用手工维护。

**诊断**：

```bash
curl http://127.0.0.1:<端口>/dsh-pet-voice/dida
# → { ok, enabled, 凭证, 已排, 下一条:{时刻,标题}, 上次拉取, 任务数, 错误 }
```

`已排` 是「未来一周内排上的提醒条数」。它是 0 但你在嘀嗒里明明配了提醒，先看 `凭证` 和 `错误`。

**这一版不做**：写回嘀嗒、完成/推迟、习惯打卡、番茄钟、日历事件（`CalendarEventModel` 那条线）。
提醒来源只认 `TaskModel.reminders[]`（`TRIGGER:PT0S` 这类 ISO 8601 偏移，加到 `dueDate` 上）。

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
