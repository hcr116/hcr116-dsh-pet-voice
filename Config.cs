using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace DafeiyuPet;

/// <summary>桌宠的全部可调项，存在 %APPDATA%\DafeiyuPet\config.json，改完重启生效。</summary>
public sealed class PetConfig
{
    public SshFeedConfig Ssh { get; set; } = new();
    /// <summary>一条气泡留多久（秒）。</summary>
    public int BubbleSeconds { get; set; } = 12;
    /// <summary>窗口位置（null = 右下角自动放）。</summary>
    public double? Left { get; set; }
    public double? Top { get; set; }
    /// <summary>窗口缩放（1 = 原始大小）。</summary>
    public double Scale { get; set; } = 1.0;
    /// <summary>按住说话的热键：单个字母/数字，默认 U。改了要重启。</summary>
    public string Hotkey { get; set; } = "U";
    /// <summary>语音（本地合成，不联网不花钱）。</summary>
    public VoiceConfig Voice { get; set; } = new();
    /// <summary>跟本鲸说话（DSH 里的 dsh-pet-bridge 插件）。</summary>
    public BridgeConfig Bridge { get; set; } = new();

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        WriteIndented = true,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public static string Dir
    {
        get
        {
            var d = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "DafeiyuPet");
            Directory.CreateDirectory(d);
            return d;
        }
    }

    public static string ConfigPath => Path.Combine(Dir, "config.json");
    public static string ReminderPath => Path.Combine(Dir, "reminders.json");
    public static string StatePath => Path.Combine(Dir, "state.json");

    public static PetConfig Load()
    {
        try
        {
            if (File.Exists(ConfigPath))
                return JsonSerializer.Deserialize<PetConfig>(File.ReadAllText(ConfigPath), JsonOpts) ?? new PetConfig();
        }
        catch { /* 配置坏了就用默认值，别让桌宠起不来 */ }
        var c = new PetConfig();
        c.Save();
        return c;
    }

    public void Save()
    {
        try { File.WriteAllText(ConfigPath, JsonSerializer.Serialize(this, JsonOpts)); } catch { }
    }
}

public sealed class VoiceConfig
{
    /// <summary>开不开朗读。</summary>
    public bool Enabled { get; set; } = true;
    /// <summary>指定音色名（null = 自动挑 Yaoyao → Huihui → Kangkang）。</summary>
    public string? Name { get; set; }
    /// <summary>语速偏移，百分比，负数更慢。</summary>
    public int Rate { get; set; } = 0;
    /// <summary>音高偏移，百分比，正数更嫩。</summary>
    public int Pitch { get; set; } = 8;
    /// <summary>音量 0~1。</summary>
    public double Volume { get; set; } = 0.9;

    // ── 走哪条嗓子 ──────────────────────────────────────────
    /// <summary>sapi = 本地 Windows 语音（机械音，离线免费）；local = 本地 GPT-SoVITS（像人，要常驻服务）；azure = 微软神经语音（要 key）。</summary>
    public string Provider { get; set; } = "sapi";

    /// <summary>本地 GPT-SoVITS 的地址（api_v2.py 默认 9880）。</summary>
    public string? LocalUrl { get; set; } = "http://127.0.0.1:9880";

    /// <summary>参考音：一小段要克隆的嗓子（5~10 秒，wav 最好）。</summary>
    public string? LocalRefAudio { get; set; } = @"D:\DafeiyuVoice\ref\dwg_0002.wav";

    /// <summary>参考音里说的那句话（一字不差，写错了音色会飘）。</summary>
    public string? LocalPromptText { get; set; } = "什么嘛，这么简单的事情，你居然专门跑来问我。";

    /// <summary>语言：zh / en / ja。</summary>
    public string? LocalTextLang { get; set; } = "zh";

    /// <summary>Azure 语音资源的密钥（门户 → 语音服务 → 密钥和终结点）。</summary>
    public string? AzureKey { get; set; }

    /// <summary>Azure 区域，比如 eastasia / japaneast / southeastasia。</summary>
    public string? AzureRegion { get; set; } = "eastasia";

    /// <summary>Azure 音色短名，比如 zh-CN-XiaoxiaoNeural（温柔）/ zh-CN-XiaoyiNeural（活泼）。</summary>
    public string? AzureVoice { get; set; } = "zh-CN-XiaoxiaoNeural";
}

public sealed class SshFeedConfig
{
    public bool Enabled { get; set; } = true;
    public string Host { get; set; } = "root@114.55.151.88";
    /// <summary>私钥路径。BotPanel 那个 key 一样，挪走了就改这里。</summary>
    // 仓库里不含私钥：这个默认值是空的。
    // 要在某台机器上启用 QQ 转述，就在那台机器的 %APPDATA%\\DafeiyuPet\\config.json 里自己填 Key。
    public string Key { get; set; } = "";
    /// <summary>服务器上的 outbox 文件（astrbot_pet_outbox 插件写的）。</summary>
    public string Remote { get; set; } = "/opt/astrbot/data/plugin_data/astrbot_plugin_pet_outbox/outbox.jsonl";
    public int IntervalSeconds { get; set; } = 5;
}

public sealed class BridgeConfig
{
    /// <summary>开不开「跟本鲸说话」（DSH 没开的时候会安静失败，最多 5 分钟提醒一次）。</summary>
    public bool Enabled { get; set; } = true;
    /// <summary>桥的地址。端口要和 ~/.dsh/pet-bridge.json 里的 port 对上。</summary>
    public string Url { get; set; } = "http://127.0.0.1:43110";
    /// <summary>她说完一句后，最快几秒来取一次。</summary>
    public int IntervalSeconds { get; set; } = 2;
}
