using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;

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
/// 从服务器上的 outbox.jsonl 读大肥鱼说了什么（astrbot_pet_outbox 插件写的）。
///
/// 2026-10-25 改版：原来是「每 5 秒开一次 ssh，拉一次文件尾巴」，
/// 一天 700 多次握手，网络一抖就 20 秒超时，桌面上隔一会儿蹦一句「连不上服务器」。
/// 现在改成**一条长连接**：ssh 里先印一遍尾巴，再用 tail -F 挂着等新行，
/// 断了自动重连（2s→4s→…→30s 退避），只在「连续断超过 1 分钟」时提醒，30 分钟最多一次。
/// </summary>
public sealed class OutboxWatcher
{
    private readonly PetConfig _cfg;
    private readonly CancellationTokenSource _cts = new();
    private readonly System.Text.Json.JsonSerializerOptions _json =
        new() { PropertyNameCaseInsensitive = true };
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

    private static void Log(string msg)
    {
        try
        {
            File.AppendAllText(Path.Combine(PetConfig.Dir, "pet.log"),
                $"{DateTime.Now:HH:mm:ss.fff} feed: {msg}\n");
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
        if (string.IsNullOrWhiteSpace(_cfg.Ssh.Key))
        {
            Log("没有配私钥，QQ 转述关着（这不影响气泡、提醒、语音、桥）");
            return;
        }
        _ = Task.Run(StreamLoopAsync);
    }

    public void Stop() => _cts.Cancel();

    /// <summary>最近一次收到数据的时间。外面靠它判断「是不是卡死了」。</summary>
    public DateTime LastOk { get; private set; }

    private async Task StreamLoopAsync()
    {
        var ct = _cts.Token;
        var backoff = TimeSpan.FromSeconds(2);
        var downSince = DateTime.MinValue;

        while (!ct.IsCancellationRequested)
        {
            var before = LastOk;
            try
            {
                await FollowAsync(ct).ConfigureAwait(false);
                if (ct.IsCancellationRequested) break;
                // 连接被服务器/网络结束了
                if (downSince == DateTime.MinValue) downSince = DateTime.Now;
                Log("连接结束，准备重连");
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                if (downSince == DateTime.MinValue) downSince = DateTime.Now;
                Log("断开 " + ex.Message);
                ReportIfDownLongEnough(downSince, ex.Message);
            }

            // 这次连上过（收到过数据）→ 退避清零
            if (LastOk > before) { backoff = TimeSpan.FromSeconds(2); downSince = DateTime.MinValue; }

            try { await Task.Delay(backoff, ct).ConfigureAwait(false); }
            catch (OperationCanceledException) { break; }
            backoff = TimeSpan.FromSeconds(Math.Min(30, backoff.TotalSeconds * 2));
        }
    }

    /// <summary>断了多久才值得打扰主人：连续 1 分钟以上，且 30 分钟最多一次。</summary>
    private void ReportIfDownLongEnough(DateTime downSince, string reason)
    {
        var down = DateTime.Now - downSince;
        if (down < TimeSpan.FromSeconds(60)) return;
        if (DateTime.Now - _lastErrorShown < TimeSpan.FromMinutes(30)) return;
        _lastErrorShown = DateTime.Now;
        Error?.Invoke("连不上服务器（断了 " + (int)down.TotalMinutes + " 分钟）：" + reason);
    }

    /// <summary>一条长连接：先给存量，再跟着文件长。</summary>
    private async Task FollowAsync(CancellationToken ct)
    {
        var psi = new ProcessStartInfo("ssh.exe")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
        };
        psi.ArgumentList.Add("-i"); psi.ArgumentList.Add(_cfg.Ssh.Key);
        psi.ArgumentList.Add("-o"); psi.ArgumentList.Add("BatchMode=yes");
        psi.ArgumentList.Add("-o"); psi.ArgumentList.Add("StrictHostKeyChecking=no");
        psi.ArgumentList.Add("-o"); psi.ArgumentList.Add("ConnectTimeout=8");
        psi.ArgumentList.Add("-o"); psi.ArgumentList.Add("ServerAliveInterval=15");
        psi.ArgumentList.Add("-o"); psi.ArgumentList.Add("ServerAliveCountMax=4");
        psi.ArgumentList.Add("-o"); psi.ArgumentList.Add("LogLevel=ERROR");
        psi.ArgumentList.Add(_cfg.Ssh.Host);
        var remote = _cfg.Ssh.Remote.Replace("'", "'\\''");
        psi.ArgumentList.Add(
            "tail -c 400000 '" + remote + "' 2>/dev/null; exec tail -F -n 0 '" + remote + "' 2>/dev/null");

        using var p = Process.Start(psi) ?? throw new InvalidOperationException("ssh.exe 没起来");
        using var reg = ct.Register(() => { try { if (!p.HasExited) p.Kill(true); } catch { } });

        var errTask = p.StandardError.ReadToEndAsync();

        string? line;
        while ((line = await p.StandardOutput.ReadLineAsync(ct).ConfigureAwait(false)) != null)
        {
            LastOk = DateTime.Now;
            HandleLine(line);
        }

        await p.WaitForExitAsync(ct).ConfigureAwait(false);
        var err = (await errTask.ConfigureAwait(false)).Trim();
        throw new InvalidOperationException(
            string.IsNullOrWhiteSpace(err) ? "ssh 退出码 " + p.ExitCode : err);
    }

    private void HandleLine(string line)
    {
        var l = line.Trim();
        if (l.Length < 2) return;
        FeedItem? it;
        try { it = JsonSerializer.Deserialize<FeedItem>(l, _json); } catch { return; }
        if (it == null || string.IsNullOrWhiteSpace(it.Text)) return;
        if (it.Ts < _lastTs - 0.001) return;
        if (Math.Abs(it.Ts - _lastTs) < 0.001 && it.Id == _lastId) return;
        if (it.Ts > _lastTs || it.Id != _lastId)
        {
            _lastTs = Math.Max(_lastTs, it.Ts);
            _lastId = it.Id;
        }
        SaveState();
        Item?.Invoke(it);
    }
}
