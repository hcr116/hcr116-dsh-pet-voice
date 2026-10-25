using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace DafeiyuPet;

public sealed class FeedItem
{
    public double Ts { get; set; }
    public string Id { get; set; } = "";
    public string Text { get; set; } = "";
    /// <summary>msg = 她在 QQ 说的话；reminder = 从 QQ 下发的提醒</summary>
    public string Type { get; set; } = "msg";
    public string? At { get; set; }
    public string? Repeat { get; set; }
    public string? Date { get; set; }
    /// <summary>来源（群 / 私聊），只用于显示</summary>
    public string? Where { get; set; }
}

/// <summary>
/// 轮询服务器上的 outbox.jsonl：那是 astrbot_pet_outbox 插件写的大肥鱼发言。
/// 走 ssh 一次性取文件尾巴（不是 tail -f），每次几秒，断了下次自动重来。
/// </summary>
public sealed class OutboxWatcher
{
    private readonly PetConfig _cfg;
    private readonly CancellationTokenSource _cts = new();
    private readonly JsonSerializerOptions _json = new() { PropertyNameCaseInsensitive = true };
    private DateTime _lastErrorShown = DateTime.MinValue;

    public event Action<FeedItem>? Item;
    public event Action<string>? Error;

    private double _lastTs;
    private string _lastId = "";

    private sealed class State
    {
        public double LastTs { get; set; }
        public string LastId { get; set; } = "";
    }

    public OutboxWatcher(PetConfig cfg)
    {
        _cfg = cfg;
        try
        {
            if (File.Exists(PetConfig.StatePath))
            {
                var st = JsonSerializer.Deserialize<State>(File.ReadAllText(PetConfig.StatePath), _json);
                if (st != null) { _lastTs = st.LastTs; _lastId = st.LastId; }
            }
        }
        catch { }
    }

    private void SaveState()
    {
        try
        {
            File.WriteAllText(PetConfig.StatePath,
                JsonSerializer.Serialize(new State { LastTs = _lastTs, LastId = _lastId }, _json));
        }
        catch { }
    }

    public void Start()
    {
        if (!_cfg.Ssh.Enabled) return;
        _ = Task.Run(LoopAsync);
    }

    public void Stop() => _cts.Cancel();

    private async Task LoopAsync()
    {
        var ct = _cts.Token;
        var every = Math.Max(2, _cfg.Ssh.IntervalSeconds);
        while (!ct.IsCancellationRequested)
        {
            try
            {
                var text = await FetchAsync(ct).ConfigureAwait(false);
                if (!string.IsNullOrWhiteSpace(text))
                {
                    foreach (var line in text.Split('\n'))
                    {
                        var l = line.Trim();
                        if (l.Length < 2) continue;
                        FeedItem? it;
                        try { it = JsonSerializer.Deserialize<FeedItem>(l, _json); } catch { continue; }
                        if (it == null || string.IsNullOrWhiteSpace(it.Text)) continue;
                        if (it.Ts < _lastTs - 0.001) continue;
                        if (Math.Abs(it.Ts - _lastTs) < 0.001 && it.Id == _lastId) continue;
                        if (it.Ts > _lastTs || it.Id != _lastId)
                        {
                            _lastTs = Math.Max(_lastTs, it.Ts);
                            _lastId = it.Id;
                        }
                        Item?.Invoke(it);
                    }
                    SaveState();
                }
            }
            catch (OperationCanceledException) { break; }
            catch (Exception ex)
            {
                // 服务器连不上：最多 5 分钟烦一次
                if (DateTime.Now - _lastErrorShown > TimeSpan.FromMinutes(5))
                {
                    _lastErrorShown = DateTime.Now;
                    Error?.Invoke("连不上服务器：" + ex.Message);
                }
            }
            try { await Task.Delay(TimeSpan.FromSeconds(every), ct).ConfigureAwait(false); }
            catch (OperationCanceledException) { break; }
        }
    }

    private async Task<string> FetchAsync(CancellationToken ct)
    {
        var psi = new ProcessStartInfo("ssh.exe")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            StandardOutputEncoding = System.Text.Encoding.UTF8,
        };
        psi.ArgumentList.Add("-i"); psi.ArgumentList.Add(_cfg.Ssh.Key);
        psi.ArgumentList.Add("-o"); psi.ArgumentList.Add("BatchMode=yes");
        psi.ArgumentList.Add("-o"); psi.ArgumentList.Add("StrictHostKeyChecking=no");
        psi.ArgumentList.Add("-o"); psi.ArgumentList.Add("ConnectTimeout=8");
        psi.ArgumentList.Add("-o"); psi.ArgumentList.Add("LogLevel=ERROR");
        psi.ArgumentList.Add(_cfg.Ssh.Host);
        psi.ArgumentList.Add("tail -c 400000 '" + _cfg.Ssh.Remote + "' 2>/dev/null");

        using var p = Process.Start(psi) ?? throw new InvalidOperationException("ssh.exe 没起来");
        using var reg = ct.Register(() => { try { if (!p.HasExited) p.Kill(true); } catch { } });
        var outp = await p.StandardOutput.ReadToEndAsync(ct).ConfigureAwait(false);
        var err = await p.StandardError.ReadToEndAsync(ct).ConfigureAwait(false);
        await p.WaitForExitAsync(ct).ConfigureAwait(false);
        if (p.ExitCode != 0 && string.IsNullOrWhiteSpace(outp))
            throw new InvalidOperationException(string.IsNullOrWhiteSpace(err) ? "ssh 退出码 " + p.ExitCode : err.Trim());
        return outp;
    }
}
