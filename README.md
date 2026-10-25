# 大肥鱼桌宠（DafeiyuPet）

桌面右下角一只大肥鱼，跟 DSH 面板、AstrBot 面板都没关系，双击就能跑。

- 会**提醒你**：到点冒气泡 + 托盘气泡通知。
- 会**转述她在 QQ 里说的话**：服务器上的 `astrbot_pet_outbox` 插件把她的发言写进 `outbox.jsonl`，桌宠每 5 秒 ssh 拉一次。
- 在 QQ 里跟她说「**提醒我 9:30 喝水**」「**每天 21 点提醒我吃药**」，提醒会顺着同一条链路下发到桌面。

## 用法

| 操作 | 效果 |
| --- | --- |
| 左键拖 | 挪位置（位置会记住） |
| 双击 | 收进托盘 / 叫回来 |
| 滚轮 | 放大缩小（0.6~1.9） |
| 右键 | 加提醒 / 说两句 / 打开提醒文件 / 收进托盘 / 退出 |
| 托盘图标 | 双击显示隐藏；右键有「加提醒…」「静音 1 小时」「连服务器」开关 |

单实例：已经在跑的时候再双击，只会弹一句「大肥鱼已经在桌上了」。

## 文件在哪

```
%APPDATA%\DafeiyuPet\config.json      # 配置（ssh、气泡时长、位置、缩放）
%APPDATA%\DafeiyuPet\reminders.json   # 提醒清单，可以直接用记事本改
%APPDATA%\DafeiyuPet\state.json       # 读到服务器的哪一条了（别手改，删了会重放）
%APPDATA%\DafeiyuPet\pet.log          # 最近的说的话和 feed 记录，排障用
```

`reminders.json` 长这样，改完不用重启（15 秒内发现文件变了就重读）：

```json
{
  "Items": [
    { "Id": "a1", "Text": "喝水", "At": "15:30", "Repeat": "daily", "Enabled": true },
    { "Id": "a2", "Text": "交周报", "At": "18:00", "Repeat": "once", "Date": "2026-10-27", "Enabled": true }
  ]
}
```

`config.json` 关键项：

```json
{
  "Ssh": {
    "Enabled": true,
    "Host": "root@114.55.151.88",
    "Key": "D:\\ds\\dafeiyu\\_hcr116.pem",
    "Remote": "/opt/astrbot/data/plugin_data/astrbot_plugin_pet_outbox/outbox.jsonl",
    "IntervalSeconds": 5
  },
  "BubbleSeconds": 12,
  "Voice": {
    "Enabled": true,
    "Name": null,
    "Rate": 0,
    "Pitch": 8,
    "Volume": 0.9
  }
}
```

- `Ssh.Enabled=false` 或托盘里「连服务器」取消勾选 → 只做本地提醒。
- 私钥换了就改 `Key`；服务器换了就改 `Host` / `Remote`。
- 断线不会弹一堆错，5 分钟最多烦一次。

## 语音

用的是 **Windows 自带的 SAPI**（`SAPI.SpVoice` + `SAPI.SpMemoryStream`）：合成到内存、再交给 `SoundPlayer` 放。

- **不联网、不调用任何模型、0 token、0 元。** 一句 15 字大概合成 4 秒音频（22 kHz / 16 bit），本机几毫秒就完。
- 音色自动挑中文女声（`Microsoft Huihui Desktop`）；想换就填 `Voice.Name`（跑起来之前的日志里会打印系统装着的音色）。
- `Voice.Rate` 是语速（-50~50，负的更慢），`Voice.Pitch` 没用上（SAPI 不支持调音高，留着占位），`Volume` 0~1。
- 托盘菜单「朗读（本地语音）」、右键「朗读（开/关）」都能立刻开关；关掉就不再念。

⚠️ 坑：**不能直接从 `D:\ds\dafeiyu\Pet\...` 里跑这个 exe。** 那个目录带 DSH 沙盒的低完整性标签，进程里 SAPI 会报
`0x80045040`（能建流、不能开口），念不出声。装到 `%LOCALAPPDATA%\Programs\DafeiyuPet\` 就正常。

## 编译 / 发布

```bat
cd /d D:\DafeiyuPet
dotnet publish -c Release -r win-x64 --self-contained false -p:PublishSingleFile=true -o publish
```

产物：`publish\DafeiyuPet.exe`（约 500 KB，图已经嵌进去，挪到哪都能跑）。
需要 .NET 9 桌面运行时（本机已装 `Microsoft.WindowsDesktop.App 9.0.15`）。

## 安装 / 开机自启

跑一次 `装开机自启.bat`：它会把 exe 复制到 `%LOCALAPPDATA%\Programs\DafeiyuPet\`，
再在「启动」文件夹里建快捷方式（`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\大肥鱼桌宠.lnk`）。

手工装也一样：**复制到 `%LOCALAPPDATA%\Programs\DafeiyuPet\` 再建快捷方式**，别原地跑。

## 服务器那头

插件源码在 archive 仓的 `BotPanel/server/pet-outbox/`，部署路径 `/opt/astrbot/data/plugins/astrbot_pet_outbox/`，数据在
`/opt/astrbot/data/plugin_data/astrbot_plugin_pet_outbox/outbox.jsonl`（超过 2 MB 自动只留最后 800 行）。

它只干两件事：她发言 → 追加 `{"type":"msg"}`；认出「提醒我 …」→ 追加 `{"type":"reminder"}`。不碰唤醒、不改人格、不调模型。
装了它之后**要 `docker restart astrbot`** 才加载。

## 已知小事

- 只从 outbox 读「她说的」，不读群里别人说的（要的话在插件里加过滤就行）。
- 提醒按分钟精度，同一条同一分钟只响一次；`once` 响完自动变 `Enabled:false`，不删。
- 气泡是窗口的一部分：气泡出现时窗口会变高，程序会反向挪窗口让鱼原地不动。
