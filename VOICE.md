# 大肥鱼桌宠 · 声音这一块（口播 + 三条嗓子 + 克隆嗓）

> 这份文件讲**声音**。功能清单看 [`README.md`](README.md)，接手环境看 [`HANDOFF.md`](HANDOFF.md)，
> 规则与分期看 [`设计文档.md`](设计文档.md) §3。

## 一句话架构

```
DSH 里她回一句
   └─ dsh-pet-bridge 挑出「口播句」（有 `口播：` 就只念那行，没有就规则兜底）
        └─ 桌宠 /feed 取到 → 气泡显示 → Voice.Speak() 念出来
                                     ├─ sapi   ：Windows 本地语音（离线、0 花费、机械音）
                                     ├─ local  ：本机 GPT-SoVITS（克隆嗓，最像人，要常驻服务）
                                     └─ azure  ：微软神经语音（联网，要 key）
```

口播和嗓子是两件事：**口播**决定「念哪一句」，**嗓子**决定「用什么声音念」。

---

## 1. 口播：只念一句

- 规则实现在 `bridge-plugin/index.js:82-135`（`口播上限 = 40`）。
- 优先级：
  1. 回复里有 `口播：……`（也认 `口播词：` / `播报：`）→ 只念这一行；
  2. 没有 → 按规则从回复里挑一句（跳过表格行、代码块、路径、清单）；
  3. 太长 → 在逗号/句号处切第一句，最多 40 字。
- 单测：`cd bridge-plugin && node speech-test.mjs`（6 例，不联网、不需要 DSH）。
- 它是**约定不是协议**：不写 `口播：` 也能用，只是那句可能不够贴。

## 2. 三条嗓子怎么选

配置在 `%APPDATA%\DafeiyuPet\config.json` 的 `Voice` 段（改完重启桌宠）：

| `Voice.Provider` | 是什么 | 花费 | 依赖 |
| --- | --- | --- | --- |
| `sapi`（默认） | Windows 自带 SAPI（Microsoft Huihui / Yaoyao） | 0 | 无 |
| `local` | 本机 GPT-SoVITS v2pro，**克隆嗓** | 0（只吃电/显存） | `127.0.0.1:9880` 常驻 |
| `azure` | Azure 语音服务（zh-CN-XiaoxiaoNeural 等） | 按字符计费 |  key + 联网 |

**降级链**（`Voice.cs:61-100`）：`local` 打不通 / 参考音不见 / 合成超时 → 自动退回 SAPI；
`azure` 没 key 或网络失败 → 同样退回 SAPI。**任何一处失败都不会让你听不到声音，也不会弹错窗**，
只会在 `%APPDATA%\DafeiyuPet\pet.log` 里留一行 `voice[local] 没成，退回 SAPI：…`。

### 配置示例

```jsonc
"Voice": {
  "Enabled": true,
  "Provider": "local",              // sapi | local | azure
  "Rate": 0,                         // 语速偏移，负=慢
  "Pitch": 8,                        // 音高偏移（只对 SAPI 生效）
  "Volume": 0.9,

  // local（克隆嗓）
  "LocalUrl": "http://127.0.0.1:9880",
  "LocalRefAudio": "D:\\DafeiyuVoice\\ref\\dwg_0002.wav",
  "LocalPromptText": "什么嘛，这么简单的事情，你居然专门跑来问我。",
  "LocalTextLang": "zh",

  // azure
  "AzureKey": "",
  "AzureRegion": "eastasia",
  "AzureVoice": "zh-CN-XiaoxiaoNeural"
}
```

## 3. 克隆嗓：本机 GPT-SoVITS 是怎么装的

**状态（2026-10-26）**：走的是**零样本克隆**，不是微调。
给一小段参考音 + 那段话的原文，`api_v2.py` 就照着这个嗓子念任意文本。

| 东西 | 位置 | 大小 | 进仓库？ |
| --- | --- | --- | --- |
| GPT-SoVITS v2pro 整合包 | `D:\DafeiyuVoice\GPT-SoVITS-v2pro-20250604\` | 14.2 GB | ❌（太大） |
| 预训练模型 | 上面 `GPT_SoVITS\pretrained_models\` | 4.38 GB | ❌ |
| 参考音 | `D:\DafeiyuVoice\ref\dwg_0002.wav` | 286 KB | ❌（是别人的声音，别传公开仓） |
| 数据集（做微调才用） | `D:\DafeiyuVoice\dataset\` | 0.34 GB | ❌ |
| 启动脚本 | `D:\DafeiyuVoice\start-tts.vbs` | 1 KB | ❌（路径写死在本机） |

所以：**代码在仓库里，模型和参考音不在**。换一台机器要自己装一份（见 §5）。

### 启动 / 自启

```bat
:: 手动起（双击也行），隐藏窗口，端口已被占就直接退出
D:\DafeiyuVoice\start-tts.vbs
```

- 它执行 `runtime\python.exe api_v2.py -a 127.0.0.1 -p 9880`；
- 起完要等 **15~25 秒**加载模型，这期间桌宠自动用 SAPI；
- 开机自启：把同一个 vbs 拷到 `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\大肥鱼语音服务.vbs`；
- 停：任务管理器结束命令行里带 `api_v2.py` 的 python；显存占用约 **3 GB**。

### 参考音怎么用才对

- 5~10 秒、干净、单人、无背景音乐（wav 最好）；
- `LocalPromptText` 必须和参考音里**说的一字不差**，写错了音色会飘、语速会怪；
- 想换嗓子：换一个 wav + 改 `LocalRefAudio`，不用重新训练。

### 想更稳（微调）的话

`dataset/` 就是给这个准备的（`prepare_training.py` 切分 + 标注）。
微调产物放 `GPT_SoVITS\SoVITS_weights\*.pth` 与 `GPT_weights\*.ckpt`，
再在 `api_v2.py` 的请求里带 `*_weights_path`。**这块现在没做**，是留给后面的。

## 4. 常见报错对照

| 现象 | 原因 | 怎么办 |
| --- | --- | --- |
| 声音是机械音 | 克隆嗓没连上，退回了 SAPI | 看 `pet.log` 有没有 `voice[local] 没成`；先确认 9880 `/docs` 能开 |
| `0x80045040` | 从工作区目录跑 exe（低完整性标签），SAPI 打不开声卡 | 装到 `%LOCALAPPDATA%\Programs\DafeiyuPet` 再跑 |
| 念出来是别人的腔调 | 参考音 / `LocalPromptText` 对不上 | 换一段参考音，文字逐字核对 |
| 第一次说话没声 | 模型还在加载（15~25 秒） | 等一会，第二次就正常 |
| Azure 不响 | 没填 `AzureKey` 或区域不对 | 填 key/区域；不填就保持 `sapi` 或 `local` |

## 5. 公司电脑接着做，声音这块怎么起步

1. **先能编译**：`git clone -b dafeiyu-pet … && dotnet publish …` —— 声音代码全在，默认 `sapi`，开箱就能响。
2. **想听克隆嗓**：自己下一份 GPT-SoVITS v2pro 整合包，放到那台机器的 `D:\DafeiyuVoice\GPT-SoVITS-v2pro-20250604\`，
   再准备一段自己的参考音 + 原文，改 `config.json` 的 `LocalRefAudio` / `LocalPromptText` / `Provider = "local"`。
3. **不要拷家里的私钥**（主人的硬规矩）：没有私钥那台机器只是没有 QQ 转述，声音、气泡、桥都照常。
4. **Azure 那条**是备选，`AzureKey` 各人各自填，别提交。

## 6. 还没做 / 可以接着做的

- [ ] Azure 那条只验证过接口，没做音色挑选 UI；
- [ ] 克隆嗓的**流式**播放（现在整段下载完再放，长句有 1~2 秒空档）；
- [ ] 微调模型（比零样本稳，但要训练时间 + 显存）；
- [ ] 情绪分档（开心/委屈换参考音，现在只有一条嗓子）；
- [ ] `edge-tts`（免费、不用 key，但要联网）作为 `sapi` 和 `azure` 之间的第四档。

---

改完记得：`dotnet publish` → 覆盖 `%LOCALAPPDATA%\Programs\DafeiyuPet\DafeiyuPet.exe` → 重启桌宠（托盘「退出」再开）。
