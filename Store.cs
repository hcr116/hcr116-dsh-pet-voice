using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace DafeiyuPet;

public sealed class Reminder
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N")[..8];
    public string Text { get; set; } = "";
    /// <summary>HH:mm</summary>
    public string At { get; set; } = "09:00";
    /// <summary>daily / once</summary>
    public string Repeat { get; set; } = "daily";
    /// <summary>仅 once 用：yyyy-MM-dd</summary>
    public string? Date { get; set; }
    public bool Enabled { get; set; } = true;
    /// <summary>上次响的时间（yyyy-MM-dd HH:mm），防重复响。</summary>
    public string? LastFired { get; set; }

    [JsonIgnore]
    public string Label => Repeat == "once" ? $"{Date} {At}" : $"每天 {At}";
}

public sealed class ReminderStore
{
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        WriteIndented = true,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public List<Reminder> Items { get; set; } = new();

    public static ReminderStore Load()
    {
        try
        {
            if (File.Exists(PetConfig.ReminderPath))
            {
                var s = JsonSerializer.Deserialize<ReminderStore>(File.ReadAllText(PetConfig.ReminderPath), JsonOpts);
                if (s != null) return s;
            }
        }
        catch { }
        return new ReminderStore();
    }

    public void Save()
    {
        try { File.WriteAllText(PetConfig.ReminderPath, JsonSerializer.Serialize(this, JsonOpts)); } catch { }
    }

    public void Add(Reminder r)
    {
        if (Items.Any(x => x.Id == r.Id)) return;
        Items.Add(r);
        Save();
    }

    /// <summary>到点该响的：同一分钟只响一次（LastFired 存到分钟）。</summary>
    public List<Reminder> Due(DateTime now)
    {
        var hit = new List<Reminder>();
        var hhmm = now.ToString("HH:mm");
        var stamp = now.ToString("yyyy-MM-dd HH:mm");
        foreach (var r in Items)
        {
            if (!r.Enabled || r.At != hhmm) continue;
            if (r.LastFired == stamp) continue;
            if (r.Repeat == "once")
            {
                if (string.IsNullOrWhiteSpace(r.Date) || r.Date != now.ToString("yyyy-MM-dd")) continue;
            }
            r.LastFired = stamp;
            if (r.Repeat == "once") r.Enabled = false;   // 一次性的响完就退休
            hit.Add(r);
        }
        if (hit.Count > 0) Save();
        return hit;
    }
}
