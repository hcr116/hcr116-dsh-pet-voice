using System;
using System.IO;
using System.Media;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;

namespace DafeiyuPet;

/// <summary>
/// 本地 GPT-SoVITS（v2pro 整合包，api_v2.py 起在 127.0.0.1:9880）。
/// 零样本：给一小段参考音 + 那段话的文字，它照着这个嗓子念任意文本。
///
/// 为什么走这个而不是 SAPI：SAPI 的 Huihui 是二十年前的拼接音，一听就是机器。
/// 代价：api_v2.py 得常驻（约 3 GB 显存），挂了就静默退回 SAPI。
/// </summary>
public static class GptSovits
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(60) };
    private static readonly object Gate = new();
    private static SoundPlayer? _player;

    /// <summary>念一句。成功返回 null，失败返回原因（调用方退回 SAPI）。</summary>
    public static async Task<string?> SpeakAsync(string text, VoiceConfig cfg, Action<string> log)
    {
        var url = string.IsNullOrWhiteSpace(cfg.LocalUrl) ? "http://127.0.0.1:9880" : cfg.LocalUrl!.TrimEnd('/');
        var refWav = (cfg.LocalRefAudio ?? "").Trim();
        if (refWav.Length == 0) return "没配参考音（voice.localRefAudio）";
        if (!File.Exists(refWav)) return "参考音不见了：" + refWav;

        var payload = new
        {
            text,
            text_lang = string.IsNullOrWhiteSpace(cfg.LocalTextLang) ? "zh" : cfg.LocalTextLang,
            ref_audio_path = refWav,
            prompt_text = cfg.LocalPromptText ?? "",
            prompt_lang = string.IsNullOrWhiteSpace(cfg.LocalTextLang) ? "zh" : cfg.LocalTextLang,
            speed_factor = Math.Clamp(1.0 + cfg.Rate / 100.0, 0.5, 2.0),
            media_type = "wav",
            streaming_mode = false,
        };

        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, url + "/tts");
            req.Content = new StringContent(
                JsonSerializer.Serialize(payload),
                Encoding.UTF8,
                "application/json");

            using var res = await Http.SendAsync(req).ConfigureAwait(false);
            if (!res.IsSuccessStatusCode)
            {
                var why = await res.Content.ReadAsStringAsync().ConfigureAwait(false);
                if (why.Length > 160) why = why[..160];
                return $"GPT-SoVITS HTTP {(int)res.StatusCode}：{why}";
            }

            var wav = await res.Content.ReadAsByteArrayAsync().ConfigureAwait(false);
            if (wav.Length < 200) return "GPT-SoVITS 回了空音频";

            lock (Gate)
            {
                _player = new SoundPlayer(new MemoryStream(wav));
                _player.Play();
            }
            log($"voice[local]: {text.Length} 字 → {wav.Length} 字节（{url}）");
            return null;
        }
        catch (Exception ex)
        {
            return "GPT-SoVITS 连不上：" + ex.Message;
        }
    }

    public static void Stop()
    {
        lock (Gate)
        {
            try { _player?.Stop(); } catch { }
        }
    }

    /// <summary>服务在不在（换嗓子前先问一声，省得切过去又没声）。</summary>
    public static async Task<bool> PingAsync(string? url)
    {
        var Base = string.IsNullOrWhiteSpace(url) ? "http://127.0.0.1:9880" : url!.TrimEnd('/');
        try
        {
            using var res = await Http.GetAsync(Base + "/docs").ConfigureAwait(false);
            return res.IsSuccessStatusCode;
        }
        catch { return false; }
    }
}
