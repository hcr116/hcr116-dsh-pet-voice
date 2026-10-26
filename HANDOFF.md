# 大肥鱼桌宠 · 交接说明

> 给「另一台电脑接着做」用。看完这份就能独立开工，不用回去翻对话。
> 仓库根目录 = `D:\DafeiyuPet`（家里这台）。最后更新：2026-10-26。

---

## 1. 这是个什么东西

Windows 桌面上的「大肥鱼」：一个无边框、置顶、可拖动的小鲸鱼，自带提醒、能念她 QQ 里说的话、还能按住键跟她说话。

不是 DSH 插件，是**独立进程**（WPF + .NET 9），DSH 没开也能跑（只是不再转述、也不能对话）。

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 常驻桌面 | ✅ | 透明无边框、置顶、不占任务栏；拖动/滚轮缩放/双击收起/托盘 |
| 提醒 | ✅ | 本地 `reminders.json`，每天或只一次，`HH:mm`；改文件 15 秒内自动重读 |
| QQ 转述 | ✅ | 她 QQ 里说的每句话，桌面气泡 + 语音；一条 ssh 长连接盯着服务器上的 outbox |
| 按住 U 说话 | ✅ | 按住录音 → `/stt` 认字 → 递给 DSH 开一轮 → 回答从 `/feed` 取回念出来 |
| 语音 | ✅ | 两种：本地 SAPI（Microsoft Huihui，0 花费）或本机 GPT-SoVITS（`127.0.0.1:9880`） |
| 开机自启 | ✅ | `装开机自启.bat`（装的是 `%LOCALAPPDATA%` 里那份快照，不是仓库里这份） |

---

## 2. 环境要求

| 项 | 要求 |
| --- | --- |
| 系统 | Windows 10/11 x64 |
| SDK | **.NET 9 SDK**（验证过 9.0.313）；目标框架 `net9.0-windows` |
| 运行时 | 单文件发布是 `--self-contained false`，**机器上要有 .NET 9 Desktop Runtime** |
| NuGet | `NAudio`（录音）；WPF + WinForms 都用（`UseWPF` + `UseWindowsForms`） |
| 字体 | `Microsoft YaHei UI`（Win 自带） |
| 选装 | GPT-SoVITS 本地服务（`http://127.0.0.1:9880`），不用它就退到 SAPI |

---

## 3. 三步跑起来

```powershell
cd D:\DafeiyuPet
dotnet build -c Release
dotnet publish -c Release -r win-x64 --self-contained false -p:PublishSingleFile=true -p:DebugType=None -p:DebugSymbols=false -o publish
```

发布得到 `publish\DafeiyuPet.exe`（约 1.1 MB，单文件）。

**安装（必须）**：

```powershell
mkdir "$env:LOCALAPPDATA\Programs\DafeiyuPet" -Force
copy publish\DafeiyuPet.exe "$env:LOCALAPPDATA\Programs\DafeiyuPet\"
```

⚠️ **别在仓库目录里直接跑**：`D:\ds\dafeiyu` 这类工作区目录带低完整性标签（`Mandatory Label\Low Mandatory Level`），从那里跑 SAPI 说话会报 `0x80045040`；装到 `%LOCALAPPDATA%\Programs\DafeiyuPet` 就正常。这是踩过的坑，别改回去。

开机自启：双击 `装开机自启.bat`（往「启动」文件夹建快捷方式，指向 `%LOCALAPPDATA%` 那份）。

---

## 4. 代码地图

| 文件 | 干什么 |
| --- | --- |
| `App.xaml(.cs)` | 单实例（`Global\DafeiyuPet.SingleInstance`）、`ShutdownMode=OnExplicitShutdown`；重复启动弹「大肥鱼已经在桌上了」 |
| `MainWindow.xaml` | 窗口结构：`Root`（整窗可拖）→ `BubbleHost`（气泡，`IsHitTestVisible=False` 不挡点击）+ `PetHost`（鱼身 `PetImage` + `ListenBadge`） |
| `MainWindow.xaml.cs` | 全部交互：拖拽、气泡队列、吸气/摇摆动画、托盘、热键轮询、提醒 tick、语音调用 |
| `Config.cs` | `PetConfig` 全部可调项 + JSON 读写（`%APPDATA%\DafeiyuPet\config.json`） |
| `Store.cs` | `Reminder` / `ReminderStore`（`reminders.json`，同分钟只响一次，`once` 响完自动停用） |
| `OutboxWatcher.cs` | ssh 长连接：`tail -F` 跟服务器 outbox，逐行解析、按 `ts`/`id` 去重、断线 2→30 秒退避、连续断 60 秒才提示且 30 分钟一次 |
| `Recorder.cs` | NAudio 录音，16 kHz / 单声道 / PCM16，返回 WAV；带峰值（太小当没说话） |
| `PetBridge.cs` | 跟 `dsh-pet-bridge` 说话：`POST /stt`、`POST /say`、`GET /feed?after=`、`GET /ping` |
| `Voice.cs` | 本地语音：SAPI（COM）+ GPT-SoVITS 两条路，失败自动退回 / 静音不报错 |
| `AzureVoice.cs`、`GptSovits.cs` | 云/本地 TTS 的试验代码（`AzureVoice` 当前不启用，留着备选） |
| `AddReminderWindow.xaml(.cs)` | 「加提醒」小窗：内容 + `HH:mm` + 每天/只一次 + 日期 |
| `assets/feiyu.png` | 鱼的形象（560×554，透明边已裁） |
| `bridge-plugin/` | DSH 侧插件 `dsh-pet-bridge` 的源码副本（**不是**桌宠的一部分，但对话要用它） |
| `server-plugin/` | 服务器 AstrBot 插件 `astrbot_pet_outbox` 的源码副本（QQ 转述要用它） |
| `README.md` | 使用者视角的操作说明 |
| `设计文档.md` | 设计决策、协议、版本记录（改需求先看它） |

---

## 5. 配置（`%APPDATA%\DafeiyuPet\config.json`）

首次运行自动生成。改完**重启**生效（只有 `reminders.json` 是热重读）。

```jsonc
{
  "Ssh": {                       // QQ 转述：去服务器读 outbox
    "Enabled": true,
    "Host": "root@114.55.151.88",
    "Key": "D:\\ds\\dafeiyu\\_hcr116.pem",   // 家里这台机器上的私钥；私钥一律不入库
    "Remote": "/opt/astrbot/data/plugin_data/astrbot_plugin_pet_outbox/outbox.jsonl",
    "IntervalSeconds": 5        // 现在只是退避基数，长连接不再每 5 秒拉一次
  },
  "BubbleSeconds": 12,          // 一条气泡至少留多久（字多会自动加）
  "Left": null, "Top": null,    // 窗口位置（null = 右下角）
  "Scale": 1.0,                 // 缩放 0.6~1.9
  "Hotkey": "U",                // 按住说话的热键：单个字母/数字
  "Voice": {                    // 本地语音
    "Enabled": true,
    "Name": null,               // 留空＝Huihui；填别的会试 GPT-SoVITS
    "Rate": 0, "Pitch": 8, "Volume": 0.9
  },
  "Bridge": {                   // 跟 DSH 说话
    "Enabled": true,
    "Url": "http://127.0.0.1:43110",
    "IntervalSeconds": 2
  }
}
```

其它文件（同目录）：`reminders.json`（提醒清单）、`state.json`（outbox 读到哪了）、`pet.log`（排障用，滚动追加）。

---

## 6. 两个「外挂」怎么装

### 6.1 DSH 侧：`bridge-plugin/`

就是一个 DSH 插件包（`package.json` 名 `dsh-pet-bridge`），拷到 DSH 的插件目录即可，源码在 `bridge-plugin/`：

```
C:\Users\<你>\.dsh\profiles\desktop\node_modules\dsh-pet-bridge\
```

装好后 DSH 里会多一个 `127.0.0.1:43110` 的本地 http 服务：`/ping` `/sessions` `/say` `/feed` `/stt/status` `/stt`。细节看 `bridge-plugin/README.md`。

> 它依赖 DSH 自带的 SenseVoice（`ctx.speechToText`），第一次用会下 200 多 MB 模型，桌宠会冒「等本鲸把耳朵准备好」。

### 6.2 服务器侧：`server-plugin/`

AstrBot 插件 `astrbot_pet_outbox`，装到服务器容器里：

```bash
scp main.py metadata.yaml root@114.55.151.88:/opt/astrbot/data/plugins/astrbot_pet_outbox/
ssh root@114.55.151.88 "docker exec astrbot python -m py_compile /AstrBot/data/plugins/astrbot_pet_outbox/main.py && docker restart astrbot"
```

它干两件事：
1. 截她的回复（`on_decorating_result` → `event.get_result().chain`，**注意不是** `message_obj`，那是收到的消息），写进 `/opt/astrbot/data/plugin_data/astrbot_plugin_pet_outbox/outbox.jsonl`，一行一条 `{ts,id,type,text,at,repeat,date,where}`；
2. 认「提醒我 9 点喝水」这类话，写 `type:"reminder"` 的行，桌宠收到就加提醒。

⚠️ 数据目录名带 `astrbot_` 前缀：`plugin_data/astrbot_plugin_pet_outbox/`。

---

## 7. 已踩过的坑（照抄结论，别再踩）

| 现象 | 原因 | 做法 |
| --- | --- | --- |
| 语音 `0x80045040` | exe 在带 Low IL 标签的工作区目录里跑，SAPI 开不了口 | 装到 `%LOCALAPPDATA%\Programs\DafeiyuPet` |
| 说话 `0x8004503A` | 设备直出（`Speak(text,0/1/2/3)`）在这台机不通 | 只走内存流：`SpMemoryStream` + 手写 44 字节 WAV 头 |
| `No voice installed`（System.Speech）/ `0x800455A0`（WinRT） | 两条路都不通 | 用 COM `SAPI.SpVoice` |
| 拖动跟不上 / 拖一下就不动 / 一松手弹回原位 | ①`MouseMove` 里 `\|\| _dragging` 把后续事件全挡了 ②坐标混了物理像素与 DIP ③贴边时硬夹回屏内 | 守卫只判捕获；坐标一律走 `PointToScreen(e.GetPosition(this))`；拖动中不夹，松手只保证 60px 露在屏里 |
| 点鱼没反应 | 事件挂在 `PetImage` 上，只认鱼身那块矩形 | 挂到 `Root`（整扇窗都能拖） |
| 气泡挡住点击 | 气泡会盖住鱼头上方 | `BubbleHost` 设 `IsHitTestVisible=False` |
| 改 `reminders.json` 不生效 | 启动时读进内存 | 15 秒内自动比对 mtime 重读 |
| 转述总说「连不上服务器 20 秒没回」 | 每 5 秒拉一次、ssh 慢就报错 | 改一条 `tail -F` 长连接，断了才退避重连，报错压到 30 分钟一次 |
| 两个实例打架 | 没有互斥 | `Global\DafeiyuPet.SingleInstance` |

---

## 8. 现在的已知问题 / 接着可以做

1. **拖动手感**：2026-10-26 修了三个病根（守卫、坐标、硬夹），**还没在真机上让人试过**——接手第一件事就是拖两下确认。
2. **热键**：`Hotkey` 只支持单个字母/数字；按住 `Ctrl/Alt/Shift/Win` 不触发；「加提醒」窗口开着时不抢键。想支持组合键得换成 `RegisterHotKey` + 低级键盘钩子（现在用的是 50 ms 轮询 `GetAsyncKeyState`，简单、够用、不装钩子）。
3. **语音音质**：SAPI 就那个味。想更可爱走 GPT-SoVITS（`GptSovits.cs` 已经有雏形，`127.0.0.1:9880`），或者讨论过的 edge-tts / CosyVoice2。
4. **多台电脑**：`bridges.json` 那套多桥目前只在「鱼管台」（另一个项目 `D:\ds\dafeiyu\BotPanel`）做了家里这台；服务器 relay 还只绑 18080，`astrbot_plugin_localpc` 也没有「选哪台」的参数。
5. **表情**：只有一张 `feiyu.png`，`dsh-feiyu-mood` 里还有 `face-good/ok/great/sad/worry.png`（448×352）可以拿来做情绪切换。
6. **仓库**：`DafeiyuPet` 独立仓库还没建（GitHub 上 `hcr116/DafeiyuPet` 不存在）；现在寄存在 `hcr116/archive-202302` 的 `dafeiyu-pet` 分支上。

---

## 9. 变更记录（倒序）

| 日期 | 内容 |
| --- | --- |
| 2026-10-26 | 说话改**按住 U**（全局热键轮询），左键专职拖动；修拖动三处病根；事件挂到 `Root` |
| 2026-10-26 | outbox 改一条 ssh 长连接（`tail -F`）+ 退避重连 + 报错压噪 |
| 2026-10-25 | 本地语音打通（COM SAPI + 内存流）；装到 `%LOCALAPPDATA%`；提醒热重载 |
| 2026-10-25 | QQ 转述、`astrbot_pet_outbox` 插件、单文件发布、单实例、托盘 |
| 2026-10-25 | v0.2 骨架：WPF 透明窗口、气泡、提醒、配置 |

---

## 10. 一句话交接

`dotnet publish` 出单文件 → 拷到 `%LOCALAPPDATA%\Programs\DafeiyuPet` → 跑 `装开机自启.bat`。
要对话就把 `bridge-plugin/` 装进 DSH；要 QQ 转述就要 `server-plugin/` 在服务器上跑。

> 🔑 **密钥规矩（主人的硬要求）**：这个仓库里**不放任何私钥**，公司/别的电脑**不许拷贝家里那把 `_hcr116.pem`**。
> 没有私钥的机器上，`Ssh` 这一段会连不上 —— 那是**预期行为**：那台机器只做开发和构建，气泡、提醒、语音、桥都照常，只有 QQ 转述不工作。
> 真要在别的机器启用转述，让它生成**它自己的**密钥、由管理员加到服务器 `authorized_keys`，用完撤掉；不要复制家里的。
