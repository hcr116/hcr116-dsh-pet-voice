using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Media;
using System.Runtime.InteropServices;
using System.Text;

namespace DafeiyuPet;

/// <summary>
/// 本地语音：走 Windows 自带的 SAPI（COM: SAPI.SpVoice → SAPI.SpMemoryStream）。
/// 合成到内存再交给 SoundPlayer 放，不碰声卡也不联网，0 token 0 元。
/// 每条都新建 SpVoice：复用同一个实例在这台机器上会报 0x80045040。
/// </summary>
public static class Voice
{
    private static readonly object Gate = new();
    private static SoundPlayer? _player;
    private static int _seq;
    private static string _lastVoice = "";

    public static string CurrentVoice
    {
        get { lock (Gate) return _lastVoice; }
    }

    /// <summary>系统里装着的音色（SAPI 列表）。</summary>
    public static string[] AvailableVoices()
    {
        var list = new List<string>();
        object? tokens = null;
        try
        {
            dynamic? v = Create();
            if (v == null) return Array.Empty<string>();
            tokens = v.GetVoices();
            foreach (object raw in (System.Collections.IEnumerable)tokens)
            {
                dynamic tok = raw;
                try { list.Add((string)tok.GetDescription()); } catch { }
                finally { if (Marshal.IsComObject(raw)) Marshal.ReleaseComObject(raw); }
            }
        }
        catch { }
        finally
        {
            if (tokens != null && Marshal.IsComObject(tokens)) Marshal.ReleaseComObject(tokens);
        }
        return list.ToArray();
    }

    private static dynamic? Create()
    {
        var progId = Type.GetTypeFromProgID("SAPI.SpVoice");
        if (progId == null) return null;
        return Activator.CreateInstance(progId);
    }

    /// <summary>把一条气泡念出来。新的会掐掉上一条。</summary>
    public static void Speak(string text, VoiceConfig cfg, Action<string> log)
    {
        if (cfg == null || !cfg.Enabled) return;
        var clean = Clean(text);
        if (clean.Length == 0) return;

        var mySeq = System.Threading.Interlocked.Increment(ref _seq);

        void Work()
        {
            try
            {
                dynamic? v = Create();
                if (v == null) { log("voice: 建 SpVoice 失败"); return; }

                try { PickVoice(v, cfg.Name, log); } catch (Exception e) { log("voice: 选音色失败 " + e.Message); }
                try { v.Rate = Math.Clamp(cfg.Rate / 10, -10, 10); } catch { }
                try { v.Volume = Math.Clamp((int)Math.Round(cfg.Volume * 100), 0, 100); } catch { }

                // 先挂内存流，再开口：这样 SAPI 不会去打开声卡
                var memType = Type.GetTypeFromProgID("SAPI.SpMemoryStream");
                if (memType == null) { log("voice: 没有 SAPI.SpMemoryStream"); return; }
                dynamic ms = Activator.CreateInstance(memType)!;
                try { ms.Format.Type = 22; } catch { }   // 22 = 22kHz 16bit 单声道
                v.AudioOutputStream = ms;
                v.Speak(clean, 0);   // 0 = 同步

                const int rate = 22050, bits = 16, chans = 1;
                byte[] data = (byte[])(ms.GetData() ?? Array.Empty<byte>());
                v.AudioOutputStream = null;

                if (mySeq != _seq) return;
                if (data.Length == 0) { log("voice: 合成出来是空的"); return; }

                var wav = WrapWav(data, rate, bits, chans);
                lock (Gate)
                {
                    _player = new SoundPlayer(new MemoryStream(wav));
                    _player.Play();
                }
                log($"voice: {clean.Length} 字 → {data.Length} 字节（{rate}Hz/{bits}bit/{chans}ch）");
            }
            catch (Exception ex)
            {
                log($"voice err: 0x{ex.HResult:X8} {ex.GetType().Name} {ex.Message}");
            }
        }

        // 放到后台 MTA 线程跑：SAPI 在这台机器上只有干净线程才喘气
        System.Threading.Tasks.Task.Run(Work);
    }

    /// <summary>按名字挑音色；没指定就挑中文（Huihui 优先）。</summary>
    private static void PickVoice(dynamic v, string? wanted, Action<string> log)
    {
        object? tokens = null;
        try
        {
            tokens = v.GetVoices();
            object? chosen = null;
            string chosenDesc = "";
            string? huihui = null;
            object? huihuiTok = null;
            string? chinese = null;
            object? chineseTok = null;

            foreach (object raw in (System.Collections.IEnumerable)tokens)
            {
                dynamic tok = raw;
                string desc = "";
                try { desc = (string)tok.GetDescription(); } catch { }
                if (desc.Length == 0) continue;

                if (!string.IsNullOrWhiteSpace(wanted) &&
                    desc.IndexOf(wanted!, StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    chosen = raw; chosenDesc = desc; break;
                }
                if (huihuiTok == null && desc.Contains("Huihui", StringComparison.OrdinalIgnoreCase))
                {
                    huihuiTok = raw; huihui = desc;
                }
                if (chineseTok == null && desc.Contains("Chinese", StringComparison.OrdinalIgnoreCase))
                {
                    chineseTok = raw; chinese = desc;
                }
            }

            if (chosen == null && huihuiTok != null) { chosen = huihuiTok; chosenDesc = huihui!; }
            if (chosen == null && chineseTok != null) { chosen = chineseTok; chosenDesc = chinese!; }
            if (chosen == null) return;

            v.Voice = chosen;
            _lastVoice = chosenDesc;
        }
        finally
        {
            if (tokens != null && Marshal.IsComObject(tokens)) Marshal.ReleaseComObject(tokens);
        }
    }

    /// <summary>闭嘴。</summary>
    public static void Stop()
    {
        lock (Gate)
        {
            System.Threading.Interlocked.Increment(ref _seq);
            try { _player?.Stop(); } catch { }
        }
    }

    /// <summary>给裸 PCM 套 WAV 头，SoundPlayer 才认。</summary>
    private static byte[] WrapWav(byte[] pcm, int rate, int bits, int chans)
    {
        if (chans <= 0) chans = 1;
        if (bits <= 0) bits = 16;
        int blockAlign = chans * bits / 8;
        int dataLen = pcm.Length;
        using var ms = new MemoryStream(44 + dataLen);
        using var bw = new BinaryWriter(ms);
        bw.Write(Encoding.ASCII.GetBytes("RIFF"));
        bw.Write(36 + dataLen);
        bw.Write(Encoding.ASCII.GetBytes("WAVEfmt "));
        bw.Write(16);
        bw.Write((short)1);           // PCM
        bw.Write((short)chans);
        bw.Write(rate);
        bw.Write(rate * blockAlign);
        bw.Write((short)blockAlign);
        bw.Write((short)bits);
        bw.Write(Encoding.ASCII.GetBytes("data"));
        bw.Write(dataLen);
        bw.Write(pcm);
        bw.Flush();
        return ms.ToArray();
    }

    /// <summary>去掉表情/标记，别把 ⏰ 也念出来。</summary>
    private static string Clean(string text)
    {
        var sb = new StringBuilder(text.Length);
        foreach (var ch in text)
        {
            if (char.IsSurrogate(ch)) continue;
            var cat = char.GetUnicodeCategory(ch);
            if (cat is System.Globalization.UnicodeCategory.OtherSymbol
                or System.Globalization.UnicodeCategory.OtherNotAssigned) continue;
            if (ch is '*' or '`' or '#' or '>' or '|') continue;
            sb.Append(ch);
        }
        return sb.ToString().Trim();
    }
}
