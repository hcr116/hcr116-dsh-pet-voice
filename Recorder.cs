using System.IO;
using NAudio.Wave;

namespace DafeiyuPet;

/// <summary>
/// 按住左键的时候录，松手交给本鲸。
///
/// 只认一种格式：**16 kHz / 单声道 / PCM16**。DSH 那边的转写服务只吃这个
/// （它逐字段核对 RIFF 头，多一位采样率都算坏音频），所以录的时候就要成这个格式，
/// 不能录完再随手转。内存里攒原始 PCM，Stop 的时候自己拼一个 44 字节的 WAV 头。
/// </summary>
public sealed class Recorder : IDisposable
{
    private const int SampleRate = 16000;
    private const int Channels = 1;
    private const int BitsPerSample = 16;

    private readonly object _lock = new();
    private readonly MemoryStream _pcm = new();
    private WaveInEvent? _mic;
    private bool _started;

    /// <summary>这次录了多久（秒）。</summary>
    public double Seconds
    {
        get { lock (_lock) return _pcm.Length / (double)(SampleRate * Channels * BitsPerSample / 8); }
    }

    /// <summary>音量大不大（0~1 的峰值），用来看用户到底有没有出声。</summary>
    public double Peak { get; private set; }

    /// <summary>开始录。系统里没有可用麦克风会抛异常，调用方接住就行。</summary>
    public void Start()
    {
        if (_started) return;
        lock (_lock) { _pcm.SetLength(0); Peak = 0; }

        _mic = new WaveInEvent
        {
            WaveFormat = new WaveFormat(SampleRate, BitsPerSample, Channels),
            BufferMilliseconds = 40,
            NumberOfBuffers = 3,
        };
        _mic.DataAvailable += OnData;
        _mic.StartRecording();
        _started = true;
    }

    private void OnData(object? sender, WaveInEventArgs e)
    {
        if (e.BytesRecorded <= 0) return;
        lock (_lock)
        {
            _pcm.Write(e.Buffer, 0, e.BytesRecorded);
            for (int i = 0; i + 1 < e.BytesRecorded; i += 2)
            {
                short s = (short)(e.Buffer[i] | (e.Buffer[i + 1] << 8));
                double v = Math.Abs(s) / 32768.0;
                if (v > Peak) Peak = v;
            }
        }
    }

    /// <summary>停止录音，返回完整的 WAV 字节。没录到东西返回 null。</summary>
    public byte[]? Stop()
    {
        if (!_started) return null;
        _started = false;
        try
        {
            _mic?.StopRecording();
            _mic?.Dispose();
        }
        catch { }
        _mic = null;

        byte[] pcm;
        lock (_lock) pcm = _pcm.ToArray();
        if (pcm.Length < SampleRate * 2 * 200 / 1000) return null; // 不到 200ms 当没录
        return Wrap(pcm);
    }

    /// <summary>直接丢掉这次录音（拖动窗口时误触发的）。</summary>
    public void Cancel()
    {
        if (!_started) return;
        _started = false;
        try
        {
            _mic?.StopRecording();
            _mic?.Dispose();
        }
        catch { }
        _mic = null;
        lock (_lock) _pcm.SetLength(0);
    }

    private static byte[] Wrap(byte[] pcm)
    {
        using var ms = new MemoryStream(44 + pcm.Length);
        using var w = new BinaryWriter(ms);
        const int byteRate = SampleRate * Channels * BitsPerSample / 8;
        w.Write("RIFF"u8.ToArray());
        w.Write(36 + pcm.Length);
        w.Write("WAVE"u8.ToArray());
        w.Write("fmt "u8.ToArray());
        w.Write(16);              // PCM 的 fmt 块长
        w.Write((short)1);        // PCM
        w.Write((short)Channels);
        w.Write(SampleRate);
        w.Write(byteRate);
        w.Write((short)(Channels * BitsPerSample / 8)); // blockAlign
        w.Write((short)BitsPerSample);
        w.Write("data"u8.ToArray());
        w.Write(pcm.Length);
        w.Write(pcm);
        w.Flush();
        return ms.ToArray();
    }

    public void Dispose() => Cancel();
}
