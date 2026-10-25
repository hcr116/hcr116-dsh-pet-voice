using System.Net.Http;
using System.Text;
using System.Text.Json;

namespace DafeiyuPet;

/// <summary>
/// 连本鲸（DSH 里的 dsh-pet-bridge 插件，默认 http://127.0.0.1:43110）。
/// 说话走 POST /say，她的回答从 GET /feed?after=N 取回来朗读。只碰本机回环，不联网。
/// </summary>
public sealed class PetBridge
{
    private readonly PetConfig _cfg;
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(10) };
    /// <summary>认字单独一个客户端：录 30 秒的话，转写可能要好几秒到十几秒。</summary>
    private readonly HttpClient _stt = new() { Timeout = TimeSpan.FromSeconds(90) };
    private readonly CancellationTokenSource _cts = new();
    private readonly JsonSerializerOptions _json = new() { PropertyNameCaseInsensitive = true };

    private long _last;
    private double _ignoreBefore;   // ms；比它老的回复不念（那是上一轮欠的，时序会乱）
    private DateTime _lastErrorShown = DateTime.MinValue;

    /// <summary>丢掉此刻之前排着的旧回复：新的一问只接新的答。ts 是毫秒。</summary>
    public void 只念新的() => _ignoreBefore = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    /// <summary>她回了一句话（已经在后台线程，要用 Dispatcher 回 UI）。</summary>
    public event Action<string>? Reply;
    /// <summary>连不上之类，最多 5 分钟烦一次。</summary>
    public event Action<string>? Error;

    public PetBridge(PetConfig cfg)
    {
        _cfg = cfg;
    }


    private string Base
    {
        get
        {
            var url = _cfg.Bridge?.Url;
            if (string.IsNullOrWhiteSpace(url)) url = "http://127.0.0.1:43110";
            return url.TrimEnd('/');
        }
    }

    public void Start()
    {
        if (_cfg.Bridge is not { Enabled: true }) return;
        // 刚起来时不念陈年旧账：DSH 那边排着的往轮回答一律作废，只接从现在起的新话
        只念新的();
        _ = Task.Run(LoopAsync);
    }

    public void Stop()
    {
        try { _cts.Cancel(); } catch { }
    }

    /// <summary>把一句话递给本鲸。成功返回 null，失败返回原因。</summary>
    public async Task<string?> SendAsync(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return "没字";
        try
        {
            using var body = new StringContent(
                JsonSerializer.Serialize(new { text }), Encoding.UTF8, "application/json");
            using var res = await _http.PostAsync(Base + "/say", body, _cts.Token).ConfigureAwait(false);
            var raw = await res.Content.ReadAsStringAsync(_cts.Token).ConfigureAwait(false);
            if (res.IsSuccessStatusCode) return null;
            var reason = ReadError(raw);
            return string.IsNullOrWhiteSpace(reason) ? "HTTP " + (int)res.StatusCode : reason;
        }
        catch (OperationCanceledException) { return "桌宠正在退出"; }
        catch (Exception ex) { return Short(ex); }
    }

    /// <summary>探一下桥在不在。</summary>
    public async Task<bool> PingAsync()
    {
        try
        {
            using var res = await _http.GetAsync(Base + "/ping", _cts.Token).ConfigureAwait(false);
            return res.IsSuccessStatusCode;
        }
        catch { return false; }
    }

    /// <summary>
    /// 把一段录音交给本鲸那边转成字（DSH 自带 SenseVoice，桌宠不装模型）。
    /// 返回的 <see cref="TranscribeResult.Text"/> 为空时看 <see cref="TranscribeResult.Error"/>。
    /// </summary>
    public async Task<TranscribeResult> TranscribeAsync(byte[] wav)
    {
        if (wav == null || wav.Length < 200) return TranscribeResult.Fail("没说上话");

        var 超时 = TimeSpan.FromSeconds(60);
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(_cts.Token);
        cts.CancelAfter(超时);

        try
        {
            using var body = new ByteArrayContent(wav);
            body.Headers.TryAddWithoutValidation("Content-Type", "audio/wav");

            using var res = await _stt.PostAsync(Base + "/stt", body, cts.Token).ConfigureAwait(false);
            var raw = await res.Content.ReadAsStringAsync(cts.Token).ConfigureAwait(false);

            if (res.IsSuccessStatusCode)
            {
                using var doc = JsonDocument.Parse(raw);
                var root = doc.RootElement;
                var text = root.TryGetProperty("text", out var t) ? (t.GetString() ?? "") : "";
                if (string.IsNullOrWhiteSpace(text)) return TranscribeResult.Fail("没听清");
                return new TranscribeResult { Text = text.Trim(), Ok = true };
            }

            // 425 = 模型还没准备好（第一次要下 200 多 MB）
            if ((int)res.StatusCode == 425)
                return TranscribeResult.Preparing(Phase(raw), Progress(raw));

            return TranscribeResult.Fail(ReadError(raw) ?? ("HTTP " + (int)res.StatusCode));
        }
        catch (OperationCanceledException) when (!_cts.IsCancellationRequested)
        {
            return TranscribeResult.Fail("认字认太久，算了");
        }
        catch (OperationCanceledException) { return TranscribeResult.Fail("桌宠正在退出"); }
        catch (Exception ex) { return TranscribeResult.Fail(Short(ex)); }
    }

    private static string? Phase(string raw)
    {
        try
        {
            using var doc = JsonDocument.Parse(raw);
            if (doc.RootElement.TryGetProperty("phase", out var p) && p.ValueKind == JsonValueKind.String)
                return p.GetString();
        }
        catch { }
        return null;
    }

    private static double? Progress(string raw)
    {
        try
        {
            using var doc = JsonDocument.Parse(raw);
            if (doc.RootElement.TryGetProperty("progress", out var p) && p.ValueKind == JsonValueKind.Number)
                return p.GetDouble();
        }
        catch { }
        return null;
    }

    private async Task LoopAsync()
    {
        var ct = _cts.Token;
        var every = Math.Max(1, _cfg.Bridge?.IntervalSeconds ?? 2);
        while (!ct.IsCancellationRequested)
        {
            try
            {
                var raw = await _http.GetStringAsync(Base + "/feed?after=" + _last, ct).ConfigureAwait(false);
                var feed = JsonSerializer.Deserialize<FeedEvent>(raw, _json);
                if (feed?.Items is { Count: > 0 })
                {
                    foreach (var item in feed.Items)
                    {
                        if (item == null || string.IsNullOrWhiteSpace(item.Text)) continue;
                        if (item.Seq > _last) _last = item.Seq;
                        // 上一轮没念完的旧答，进过收件箱但已经过时了：跳过，别把顺序念乱
                        if (_ignoreBefore > 0 && item.Ts <= _ignoreBefore) continue;
                        Reply?.Invoke(item.Text!.Trim());
                    }
                }
                if (feed?.Last is long last && last > _last) _last = last;
            }
            catch (OperationCanceledException) { break; }
            catch (Exception)
            {
                // 本鲸没开（DSH 没启动 / 插件没加载）：最多 15 分钟提示一次
                if (DateTime.Now - _lastErrorShown > TimeSpan.FromMinutes(15))
                {
                    _lastErrorShown = DateTime.Now;
                    Error?.Invoke("本鲸还没上线（DSH 那边没开？）");
                }
            }
            try { await Task.Delay(TimeSpan.FromSeconds(every), ct).ConfigureAwait(false); }
            catch (OperationCanceledException) { break; }
        }
    }

    private static string? ReadError(string raw)
    {
        try
        {
            using var doc = JsonDocument.Parse(raw);
            if (doc.RootElement.TryGetProperty("error", out var e)) return e.GetString();
        }
        catch { }
        return null;
    }

    private static string Short(Exception ex)
    {
        var msg = ex.Message;
        if (ex is HttpRequestException) return "本鲸不在（" + msg + "）";
        return msg;
    }

    private sealed class FeedEvent
    {
        public List<FeedReply>? Items { get; set; }
        public long? Last { get; set; }
    }

    private sealed class FeedReply
    {
        public long Seq { get; set; }
        public string? Text { get; set; }
        public double Ts { get; set; }
    }

}

/// <summary>一次转写的结果：要么有字，要么有原因，要么在准备模型。</summary>
public sealed class TranscribeResult
{
    public bool Ok { get; init; }
    public string? Text { get; init; }
    public string? Error { get; init; }
    /// <summary>第一次用，模型还在下/还在起（知道就好，别当失败）。</summary>
    public bool IsPreparing { get; init; }
    public string? Phase { get; init; }
    public double? Progress { get; init; }

    public static TranscribeResult Fail(string reason) => new() { Error = reason };

    public static TranscribeResult Preparing(string? phase, double? progress)
        => new() { IsPreparing = true, Phase = phase, Progress = progress, Error = "本鲸还在准备耳朵" };
}
