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
    /// <summary>语音（本地合成，不联网不花钱）。</summary>
    public VoiceConfig Voice { get; set; } = new();

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
}

public sealed class SshFeedConfig
{
    public bool Enabled { get; set; } = true;
    public string Host { get; set; } = "root@114.55.151.88";
    /// <summary>私钥路径。BotPanel 那个 key 一样，挪走了就改这里。</summary>
    public string Key { get; set; } = @"D:\ds\dafeiyu\_hcr116.pem";
    /// <summary>服务器上的 outbox 文件（astrbot_pet_outbox 插件写的）。</summary>
    public string Remote { get; set; } = "/opt/astrbot/data/plugin_data/astrbot_plugin_pet_outbox/outbox.jsonl";
    public int IntervalSeconds { get; set; } = 5;
}
