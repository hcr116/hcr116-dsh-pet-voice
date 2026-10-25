using System;
using System.IO;
using System.Media;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;
using System.Xml;

namespace DafeiyuPet;

/// <summary>
/// 微软 Azure 语音（神经 TTS）：「官方」那条路，声音是 Xiaoxiao/Xiaoyi 这批，
/// 跟 SAPI 的 Huihui 不是一个年代的东西。
///
/// 计费按字符：免费层 F0 每月 50 万字符，桌宠一天念几十句根本用不完。
/// 要 key + 区域，都在 Azure 门户里「语音服务」资源的「密钥和终结点」页。
///
/// 输出格式故意选 **riff-24khz-16bit-mono-pcm**（PCM WAV），
/// 这样能直接喂给 SoundPlayer，跟 SAPI 那条路共用一套播放/刹车逻辑。
/// </summary>
public static class AzureVoice
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(20) };
    private static readonly object Gate = new();
    private static SoundPlayer? _player;

    /// <summary>试听时用的一句。</summary>
    public const string Sample = "唔，我是深洵。这条是试听，声音还喜欢吗。";

    /// <summary>念一句。成功返回 null，失败返回原因（调用方会退回 SAPI）。</summary>
    public static async Task<string?> SpeakAsync(string text, VoiceConfig cfg, Action<string> log)
    {
        var key = (cfg.AzureKey ?? "").Trim();
        var region = (cfg.AzureRegion ?? "").Trim();
        if (key.Length == 0) return "没填 Azure key";
        if (region.Length == 0) return "没填 Azure 区域（比如 eastasia）";

        var voice = string.IsNullOrWhiteSpace(cfg.AzureVoice) ? "zh-CN-XiaoxiaoNeural" : cfg.AzureVoice!.Trim();
        var 率 = Math.Clamp(cfg.Rate, -50, 50);
        var ssml =
            $"<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>" +
            $"<voice name='{XmlEscape(voice)}'>" +
            $"<prosody rate='{(率 >= 0 ? "+" : "")}{率}%'>{XmlEscape(text)}</prosody>" +
            "</voice></speak>";

        try
        {
            using var req = new HttpRequestMessage(
                HttpMethod.Post,
                $"https://{region}.tts.speech.microsoft.com/cognitiveservices/v1");
            req.Headers.TryAddWithoutValidation("Ocp-Apim-Subscription-Key", key);
            req.Headers.TryAddWithoutValidation("User-Agent", "DafeiyuPet/1.0");
            req.Headers.TryAddWithoutValidation("X-Microsoft-OutputFormat", "riff-24khz-16bit-mono-pcm");
            req.Content = new StringContent(ssml, Encoding.UTF8, "application/ssml+xml");

            using var res = await Http.SendAsync(req).ConfigureAwait(false);
            if (!res.IsSuccessStatusCode)
            {
                var why = await res.Content.ReadAsStringAsync().ConfigureAwait(false);
                if (why.Length > 160) why = why[..160];
                return $"Azure HTTP {(int)res.StatusCode}：{why}";
            }

            var wav = await res.Content.ReadAsByteArrayAsync().ConfigureAwait(false);
            if (wav.Length < 100) return "Azure 回了个空音频";

            lock (Gate)
            {
                _player = new SoundPlayer(new MemoryStream(wav));
                _player.Play();
            }
            log($"voice[azure]: {text.Length} 字 → {wav.Length} 字节（{voice} / {region}）");
            return null;
        }
        catch (Exception ex)
        {
            return "Azure 连不上：" + ex.Message;
        }
    }

    public static void Stop()
    {
        lock (Gate)
        {
            try { _player?.Stop(); } catch { }
        }
    }

    private static string XmlEscape(string s)
    {
        var sb = new StringBuilder(s.Length + 8);
        foreach (var c in s)
        {
            switch (c)
            {
                case '&': sb.Append("&amp;"); break;
                case '<': sb.Append("&lt;"); break;
                case '>': sb.Append("&gt;"); break;
                case '"': sb.Append("&quot;"); break;
                case '\'': sb.Append("&apos;"); break;
                default: sb.Append(c); break;
            }
        }
        return sb.ToString();
    }
}
