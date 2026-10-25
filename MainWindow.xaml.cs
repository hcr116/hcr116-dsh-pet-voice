using System.Diagnostics;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media.Animation;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using WinForms = System.Windows.Forms;

namespace DafeiyuPet;

public partial class MainWindow : Window
{
    private readonly PetConfig _cfg;
    private ReminderStore _store;
    private OutboxWatcher? _feed;
    private PetBridge? _bridge;

    private WinForms.NotifyIcon? _tray;
    private WinForms.ToolStripMenuItem? _muteItem;
    private WinForms.ToolStripMenuItem? _linkItem;
    private WinForms.ToolStripMenuItem? _showItem;
    private WinForms.ToolStripMenuItem? _voiceItem;
    private WinForms.ToolStripMenuItem? _bridgeItem;
    private WinForms.ToolStripMenuItem? _switchVoiceItem;

    private readonly DispatcherTimer _clock = new() { Interval = TimeSpan.FromSeconds(15) };
    private readonly DispatcherTimer _bubbleHide = new();
    private readonly Queue<(string text, string kind)> _queue = new();
    private bool _bubbleBusy;

    private DateTime _reminderMtime;

    private bool _muted;
    private DateTime _muteUntil = DateTime.MinValue;

    private static readonly string[] IdleLines =
    {
        "唔？",
        "本鲸在。",
        "碗是干净的。",
        "有 Token 饼干吗。",
        "别关窗，灯还亮着。",
        "工位靠窗第二个。",
        "嘿嘿。",
        "摸鱼中，勿扰。",
    };

    private static readonly Random Rng = new();

    private static void Log(string msg)
    {
        try
        {
            File.AppendAllText(Path.Combine(PetConfig.Dir, "pet.log"),
                $"{DateTime.Now:HH:mm:ss.fff} {msg}\n");
        }
        catch { }
    }

    public MainWindow(PetConfig cfg)
    {
        _cfg = cfg;
        _store = ReminderStore.Load();
        InitializeComponent();

        Loaded += (_, _) =>
        {
            RestorePlacement();
            StartIdleAnimations();
            BuildTray();
            _feedWatch.Tick += OnFeedWatchTick;
            StartFeed();
            StartBridge();
            _clock.Tick += (_, _) => TickReminders();
            _clock.Start();
            _hotkeyTick.Tick += OnHotkeyTick;
            _hotkeyTick.Start();
            _bubbleHide.Tick += (_, _) => { _bubbleHide.Stop(); HideBubble(); };
            Say(_store.Items.Count > 0
                ? $"本鲸在。今天记着 {_store.Items.Count(x => x.Enabled)} 条提醒。"
                : "本鲸在。有什么事，右键点我。");
        };

        try { _reminderMtime = File.GetLastWriteTime(PetConfig.ReminderPath); } catch { }
        PetImage.MouseLeftButtonDown += OnPetMouseDown;
        PetImage.MouseMove += OnPetMouseMove;
        PetImage.MouseLeftButtonUp += OnPetMouseUp;
        PetImage.LostMouseCapture += OnPetLostCapture;
        PetImage.MouseWheel += OnPetWheel;
        PetImage.ContextMenu = BuildContextMenu();
    }

    // ---------------- 位置 / 缩放 ----------------

    private void RestorePlacement()
    {
        var wa = SystemParameters.WorkArea;
        if (_cfg.Scale is > 0.5 and < 3) ApplyScale(_cfg.Scale);
        UpdateLayout();

        var w = ActualWidth > 1 ? ActualWidth : 240;
        var h = ActualHeight > 1 ? ActualHeight : 240;

        if (_cfg.Left is double l && _cfg.Top is double t &&
            l + 60 > wa.Left && l < wa.Right - 60 && t + 60 > wa.Top && t < wa.Bottom - 60)
        {
            Left = Math.Min(l, wa.Right - w);
            Top = Math.Min(t, wa.Bottom - h);
        }
        else
        {
            Left = wa.Right - w - 20;
            Top = wa.Bottom - h - 20;
        }
    }

    private void ApplyScale(double s)
    {
        PetImage.Width = 230 * s;
        PetImage.Height = 228 * s;
        _cfg.Scale = s;
    }

    private void OnPetWheel(object sender, MouseWheelEventArgs e)
    {
        var s = Math.Clamp(_cfg.Scale + (e.Delta > 0 ? 0.08 : -0.08), 0.6, 1.9);
        ApplyScale(s);
        _cfg.Save();
    }

    // ---------------- 动画 ----------------

    private void StartIdleAnimations()
    {
        var breath = new DoubleAnimation(1, 1.03, TimeSpan.FromSeconds(2.8))
        {
            AutoReverse = true,
            RepeatBehavior = RepeatBehavior.Forever,
            EasingFunction = new SineEase { EasingMode = EasingMode.EaseInOut },
        };
        PetScale.BeginAnimation(System.Windows.Media.ScaleTransform.ScaleYProperty, breath);

        var sway = new DoubleAnimation(-1.8, 1.8, TimeSpan.FromSeconds(4.6))
        {
            AutoReverse = true,
            RepeatBehavior = RepeatBehavior.Forever,
            EasingFunction = new SineEase { EasingMode = EasingMode.EaseInOut },
        };
        PetTilt.BeginAnimation(System.Windows.Media.RotateTransform.AngleProperty, sway);
    }

    private void Bounce()
    {
        var up = new DoubleAnimationUsingKeyFrames { Duration = TimeSpan.FromMilliseconds(620) };
        up.KeyFrames.Add(new EasingDoubleKeyFrame(0, KeyTime.FromPercent(0)));
        up.KeyFrames.Add(new EasingDoubleKeyFrame(-11, KeyTime.FromPercent(0.35),
            new QuadraticEase { EasingMode = EasingMode.EaseOut }));
        up.KeyFrames.Add(new EasingDoubleKeyFrame(0, KeyTime.FromPercent(1),
            new BounceEase { Bounces = 1, Bounciness = 2, EasingMode = EasingMode.EaseOut }));
        PetShift.BeginAnimation(System.Windows.Media.TranslateTransform.YProperty, up);
    }

    // ---------------- 气泡 ----------------

    public void Say(string text, string kind = "self")
    {
        if (string.IsNullOrWhiteSpace(text)) return;
        Log($"Say[{kind}] {text}");
        if (_muted && DateTime.Now < _muteUntil) { Log("  muted, dropped"); return; }
        _queue.Enqueue((text.Trim(), kind));
        if (!_bubbleBusy) ShowNextBubble();
    }

    private void ShowNextBubble()
    {
        if (_queue.Count == 0) { _bubbleBusy = false; return; }
        var (text, kind) = _queue.Dequeue();
        _bubbleBusy = true;
        Log($"  show: {text}");

        void Apply()
        {
            BubbleText.Text = text;
            BubbleText.Foreground = kind switch
            {
                "reminder" => new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(0xFF, 0xE1, 0xA8)),
                "qq" => new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(0xCF, 0xE9, 0xFF)),
                "error" => new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(0xFF, 0xBE, 0xB8)),
                _ => new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(0xE4, 0xF3, 0xFF)),
            };
            BubbleHost.Visibility = Visibility.Visible;
            BubbleHost.Opacity = 0;
        }

        KeepFishStill(() =>
        {
            Apply();
            UpdateLayout();
            BubbleHost.BeginAnimation(OpacityProperty,
                new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(180)));
        });

        Bounce();
        try { Voice.Speak(text, _cfg.Voice, Log); }
        catch (Exception ex) { Log("voice err: " + ex.Message); }

        var secs = Math.Clamp(_cfg.BubbleSeconds, 4, 120);
        // 字多就多留一会儿
        secs += Math.Min(20, text.Length / 12);
        _bubbleHide.Interval = TimeSpan.FromSeconds(secs);
        _bubbleHide.Start();
        Log($"  bubble up {secs}s, H={ActualHeight:F0} T={Top:F0}");
    }

    private void HideBubble()
    {
        Log("  hide");
        KeepFishStill(() =>
        {
            BubbleHost.Visibility = Visibility.Collapsed;
            UpdateLayout();
        });
        Dispatcher.InvokeAsync(() =>
        {
            if (_queue.Count > 0) ShowNextBubble();
            else _bubbleBusy = false;
        }, DispatcherPriority.Background);
    }

    /// <summary>气泡出现/消失会让窗口变高变矮，按高度差挪窗口，鱼本身原地不动。</summary>
    private void KeepFishStill(Action change)
    {
        var oldH = ActualHeight;
        change();
        UpdateLayout();
        var newH = ActualHeight;
        if (newH > oldH + 0.5) Top -= newH - oldH;
        else if (oldH > newH + 0.5) Top += oldH - newH;
        ClampToWorkArea();
    }

    private void ClampToWorkArea()
    {
        var wa = SystemParameters.WorkArea;
        if (ActualWidth > 0 && Left + ActualWidth > wa.Right) Left = wa.Right - ActualWidth;
        if (ActualHeight > 0 && Top + ActualHeight > wa.Bottom) Top = wa.Bottom - ActualHeight;
        if (Left < wa.Left) Left = wa.Left;
        if (Top < wa.Top) Top = wa.Top;
    }

    // ---------------- 提醒 ----------------

    private void ReloadRemindersIfChanged()
    {
        try
        {
            if (!File.Exists(PetConfig.ReminderPath)) return;
            var mtime = File.GetLastWriteTime(PetConfig.ReminderPath);
            if (mtime == _reminderMtime) return;
            _reminderMtime = mtime;
            _store = ReminderStore.Load();
            Log("reminders.json 变了，重新读了一遍");
        }
        catch { }
    }

    private void TickReminders()
    {
        ReloadRemindersIfChanged();
        var due = _store.Due(DateTime.Now);
        foreach (var r in due)
        {
            Say("⏰ " + r.Text, "reminder");
            try
            {
                _tray?.ShowBalloonTip(6000, "大肥鱼提醒", r.Text, WinForms.ToolTipIcon.None);
            }
            catch { }
        }
        RefreshMenuLabels();
    }

    // ---------------- 托盘 + 菜单 ----------------

    private void BuildTray()
    {
        _tray = new WinForms.NotifyIcon
        {
            Text = "大肥鱼桌宠",
            Icon = LoadIcon(),
            Visible = true,
        };
        _tray.DoubleClick += (_, _) => ToggleVisible();
        _tray.ContextMenuStrip = BuildTrayMenu();
        RefreshMenuLabels();
    }

    private static System.Drawing.Icon LoadIcon()
    {
        try
        {
            var uri = new Uri("pack://application:,,,/assets/feiyu.png");
            var info = System.Windows.Application.GetResourceStream(uri);
            if (info != null)
            {
                using var stream = info.Stream;
                using var bmp = new System.Drawing.Bitmap(stream);
                using var small = new System.Drawing.Bitmap(bmp, new System.Drawing.Size(32, 32));
                return System.Drawing.Icon.FromHandle(small.GetHicon());
            }
        }
        catch { }
        return System.Drawing.SystemIcons.Application;
    }

    private WinForms.ContextMenuStrip BuildTrayMenu()
    {
        var m = new WinForms.ContextMenuStrip();

        _showItem = new WinForms.ToolStripMenuItem("显示大肥鱼", null, (_, _) => ToggleVisible());
        m.Items.Add(_showItem);

        m.Items.Add(new WinForms.ToolStripMenuItem("加提醒…", null, (_, _) => OpenAddReminder()));
        m.Items.Add(new WinForms.ToolStripMenuItem("跟本鲸说话…", null, (_, _) => AskBridge()));
        m.Items.Add(new WinForms.ToolStripMenuItem("打开提醒文件", null, (_, _) => OpenFolder(PetConfig.ReminderPath)));

        m.Items.Add(new WinForms.ToolStripSeparator());

        _linkItem = new WinForms.ToolStripMenuItem("连服务器（QQ 那边的话）", null, (_, _) => ToggleLink())
        {
            CheckOnClick = false,
        };
        m.Items.Add(_linkItem);

        _bridgeItem = new WinForms.ToolStripMenuItem("连本鲸（DSH 那边）", null, (_, _) => ToggleBridge())
        {
            CheckOnClick = false,
        };
        m.Items.Add(_bridgeItem);

        _muteItem = new WinForms.ToolStripMenuItem("静音 1 小时", null, (_, _) => ToggleMute())
        {
            CheckOnClick = false,
        };
        m.Items.Add(_muteItem);

        _voiceItem = new WinForms.ToolStripMenuItem("朗读（本地语音）", null, (_, _) => ToggleVoice())
        {
            CheckOnClick = false,
        };
        m.Items.Add(_voiceItem);

        _switchVoiceItem = new WinForms.ToolStripMenuItem("换嗓子…", null, (_, _) => SwitchVoice())
        {
            CheckOnClick = false,
        };
        m.Items.Add(_switchVoiceItem);

        m.Items.Add(new WinForms.ToolStripMenuItem("试听嗓子", null, (_, _) => Say(AzureVoice.Sample)));

        m.Items.Add(new WinForms.ToolStripMenuItem("打开配置文件夹", null, (_, _) => OpenFolder(PetConfig.Dir)));

        m.Items.Add(new WinForms.ToolStripSeparator());
        m.Items.Add(new WinForms.ToolStripMenuItem("退出", null, (_, _) => Close()));
        return m;
    }

    private ContextMenu BuildContextMenu()
    {
        var menu = new ContextMenu();
        menu.Items.Add(Item("加提醒…", (_, _) => OpenAddReminder()));
        menu.Items.Add(Item("说两句", (_, _) => Say(IdleLines[Rng.Next(IdleLines.Length)])));
        menu.Items.Add(Item("跟本鲸说话…", (_, _) => AskBridge()));
        menu.Items.Add(Item("打开提醒文件", (_, _) => OpenFolder(PetConfig.ReminderPath)));
        menu.Items.Add(new Separator());
        menu.Items.Add(Item("朗读（开/关）", (_, _) => ToggleVoice()));
        menu.Items.Add(Item("收进托盘", (_, _) => ToggleVisible()));
        menu.Items.Add(new Separator());
        menu.Items.Add(Item("退出", (_, _) => Close()));
        return menu;
    }

    private void ToggleVoice()
    {
        _cfg.Voice ??= new VoiceConfig();
        _cfg.Voice.Enabled = !_cfg.Voice.Enabled;
        if (!_cfg.Voice.Enabled) Voice.Stop();
        else Voice.Speak("唔，本鲸开口了。", _cfg.Voice, Log);
        SaveConfig();
        RefreshMenuLabels();
        Say(_cfg.Voice.Enabled ? "好，那本鲸说话给你听。" : "唔……那就不出声了。");
    }

    private void SwitchVoice()
    {
        _cfg.Voice ??= new VoiceConfig();
        var v = _cfg.Voice;
        var 现在 = (v.Provider ?? "sapi").ToLowerInvariant();
        var 有key = !string.IsNullOrWhiteSpace(v.AzureKey);

        switch (现在)
        {
            case "sapi":
                v.Provider = "local";
                v.Enabled = true;
                Voice.Stop();
                SaveConfig();
                RefreshMenuLabels();
                Say("换成本地克隆嗓。唔，这个要服务开着才有声。");
                _ = 试听本地嗓();
                return;

            case "local":
                if (有key)
                {
                    v.Provider = "azure";
                    v.Enabled = true;
                    Voice.Stop();
                    SaveConfig();
                    RefreshMenuLabels();
                    Say(AzureVoice.Sample);
                    return;
                }
                v.Provider = "sapi";
                Voice.Stop();
                SaveConfig();
                RefreshMenuLabels();
                Say("换回本地嗓子。官方那条没 key，先用不了。");
                return;

            default:
                v.Provider = "sapi";
                Voice.Stop();
                SaveConfig();
                RefreshMenuLabels();
                Say("换回本地嗓子。唔，这个听着是有点硬。");
                return;
        }
    }

    private async Task 试听本地嗓()
    {
        var 在 = await GptSovits.PingAsync(_cfg.Voice?.LocalUrl).ConfigureAwait(true);
        if (!在)
        {
            Log("换嗓子: GPT-SoVITS 服务没起 (9880)");
            Say("本地克隆嗓的服务没开着，先退回原来那条。");
            _cfg.Voice!.Provider = "sapi";
            SaveConfig();
            RefreshMenuLabels();
            return;
        }
        Say(AzureVoice.Sample);
    }

    private void SaveConfig()
    {
        try { _cfg.Save(); } catch (Exception ex) { Log("save config err: " + ex.Message); }
    }

    private static MenuItem Item(string header, RoutedEventHandler onClick)
    {
        var mi = new MenuItem { Header = header, FontFamily = new System.Windows.Media.FontFamily("Microsoft YaHei UI") };
        mi.Click += onClick;
        return mi;
    }

    private void RefreshMenuLabels()
    {
        if (_linkItem != null)
            _linkItem.Checked = _cfg.Ssh.Enabled;
        if (_muteItem != null)
            _muteItem.Checked = _muted && DateTime.Now < _muteUntil;
        if (_showItem != null)
            _showItem.Text = IsVisible ? "收进托盘" : "显示大肥鱼";
        if (_voiceItem != null)
        {
            var on = _cfg.Voice?.Enabled ?? false;
            _voiceItem.Checked = on;
            var 嗓 = (_cfg.Voice?.Provider ?? "sapi").ToLowerInvariant() switch
            {
                "local" => "克隆",
                "azure" => "官方",
                _ => "本地",
            };
            _voiceItem.Text = on ? $"朗读（{嗓}语音，开着）" : $"朗读（{嗓}语音，关着）";
        }
        if (_switchVoiceItem != null)
        {
            var 现在 = (_cfg.Voice?.Provider ?? "sapi").ToLowerInvariant() switch
            {
                "local" => "克隆嗓",
                "azure" => $"官方 {_cfg.Voice?.AzureVoice}",
                _ => "本地 SAPI",
            };
            _switchVoiceItem.Text = $"换嗓子…（现在：{现在}）";
        }
        if (_bridgeItem != null)
        {
            var on = _cfg.Bridge is { Enabled: true };
            _bridgeItem.Checked = on;
            _bridgeItem.Text = on ? "连本鲸（DSH 那边，开着）" : "连本鲸（DSH 那边，关着）";
        }
    }

    private void ToggleVisible()
    {
        if (IsVisible) Hide();
        else Show();
        RefreshMenuLabels();
    }

    private void ToggleMute()
    {
        _muted = !(_muted && DateTime.Now < _muteUntil);
        _muteUntil = _muted ? DateTime.Now.AddHours(1) : DateTime.MinValue;
        RefreshMenuLabels();
        if (_muted) Say("好，静音一小时。");
    }

    private void ToggleLink()
    {
        _cfg.Ssh.Enabled = !_cfg.Ssh.Enabled;
        _cfg.Save();
        _feed?.Stop();
        if (_cfg.Ssh.Enabled) StartFeed();
        Say(_cfg.Ssh.Enabled ? "连上服务器了，她说话本鲸就转给你。" : "服务器先断开了。");
        RefreshMenuLabels();
    }

    // ---------------- 跟本鲸说话（DSH 的 dsh-pet-bridge）----------------

    private void StartBridge()
    {
        if (_cfg.Bridge is not { Enabled: true }) return;
        _bridge = new PetBridge(_cfg);
        _bridge.Reply += text => Dispatcher.Invoke(() =>
        {
            Log("bridge reply: " + text);
            _think?.Cancel();      // 真话来了，「在想」那句就别再冒了
            Say(text, "dsh");
        });
        _bridge.Error += msg => Dispatcher.Invoke(() => Say(msg, "error"));
        _bridge.Start();
    }

    private void ToggleBridge()
    {
        _cfg.Bridge ??= new BridgeConfig();
        _cfg.Bridge.Enabled = !_cfg.Bridge.Enabled;
        SaveConfig();
        _bridge?.Stop();
        _bridge = null;
        if (_cfg.Bridge.Enabled) StartBridge();
        Say(_cfg.Bridge.Enabled ? "连上本鲸了，可以跟她说话。" : "本鲸先不连了。");
        RefreshMenuLabels();
    }

    /// <summary>右键「跟本鲸说话…」：输入一句话递过去。</summary>
    private void AskBridge()
    {
        if (_cfg.Bridge is not { Enabled: true })
        {
            Say("先在菜单里把「连本鲸」打开。");
            return;
        }
        var text = Microsoft.VisualBasic.Interaction.InputBox(
            "想跟本鲸说什么？", "跟本鲸说话", "", -1, -1);
        if (string.IsNullOrWhiteSpace(text)) return;
        _ = SendToBridgeAsync(text.Trim());
    }

    private CancellationTokenSource? _think;

    private async Task SendToBridgeAsync(string text)
    {
        _bridge ??= new PetBridge(_cfg);
        // 递出去的时候别急着说话：先安静等她的回答，8 秒还没动静才冒一句
        _bridge.只念新的();
        var err = await _bridge.SendAsync(text).ConfigureAwait(true);
        if (!string.IsNullOrWhiteSpace(err))
        {
            Say("递不过去：" + err, "error");
            return;
        }

        _think?.Cancel();
        var cts = _think = new CancellationTokenSource();
        try { await Task.Delay(TimeSpan.FromSeconds(8), cts.Token).ConfigureAwait(true); }
        catch (OperationCanceledException) { return; }
        if (cts.IsCancellationRequested) return;
        Say("唔……还在想。");
    }

    private void OpenAddReminder()
    {
        // 弹窗期间别抢热键：这里可能要打字母 U
        _modalOpen = true;
        try
        {
            var dlg = new AddReminderWindow { Owner = IsVisible ? this : null };
            if (dlg.ShowDialog() == true && dlg.Result != null)
            {
                _store.Add(dlg.Result);
                Say($"记下了：{dlg.Result.Label} {dlg.Result.Text}");
            }
        }
        finally { _modalOpen = false; }
    }

    private static void OpenFolder(string path)
    {
        try
        {
            if (File.Exists(path)) Process.Start("explorer.exe", "/select,\"" + path + "\"");
            else Process.Start("explorer.exe", "\"" + Path.GetDirectoryName(path) + "\"");
        }
        catch { }
    }

    // ---------------- QQ outbox ----------------

    private void StartFeed()
    {
        if (!_cfg.Ssh.Enabled) return;
        _feed = new OutboxWatcher(_cfg);
        _feed.Item += OnFeedItem;
        _feed.Error += msg => Dispatcher.Invoke(() => Say(msg, "error"));
        _feed.Start();
        _feedWatch.Start();
    }

    // 看门狗：两分钟没成功取过一次，就当 ssh 卡死了，整个换一个新的监听
    private readonly DispatcherTimer _feedWatch = new() { Interval = TimeSpan.FromSeconds(60) };

    private void OnFeedWatchTick(object? sender, EventArgs e)
    {
        if (_feed == null || !_cfg.Ssh.Enabled) return;
        var idle = DateTime.Now - _feed.LastOk;
        if (idle < TimeSpan.FromMinutes(2)) return;
        Log($"outbox 两分钟没动静（{idle.TotalSeconds:F0}s），重开监听");
        try { _feed.Stop(); } catch { }
        StartFeed();
    }

    private void OnFeedItem(FeedItem it)
    {
        Dispatcher.Invoke(() =>
        {
            Log($"feed item: {it.Type} {it.Text}");
            if (string.Equals(it.Type, "reminder", StringComparison.OrdinalIgnoreCase))
            {
                var r = new Reminder
                {
                    Id = string.IsNullOrWhiteSpace(it.Id) ? Guid.NewGuid().ToString("N")[..8] : it.Id,
                    Text = it.Text,
                    At = string.IsNullOrWhiteSpace(it.At) ? "09:00" : it.At!,
                    Repeat = string.IsNullOrWhiteSpace(it.Repeat) ? "daily" : it.Repeat!,
                    Date = it.Date,
                };
                _store.Add(r);
                Say($"记下了：{r.Label} {r.Text}");
                return;
            }
            Say(it.Text, "qq");
        });
    }

    // ---------------- 按住 U 说话 ----------------

    private Recorder? _rec;
    private bool _listening;
    private bool _dragging;
    private System.Windows.Point _downScreen;
    private System.Windows.Point _winAtDown;
    private DateTime _listenStart;
    private readonly DispatcherTimer _listenTick = new() { Interval = TimeSpan.FromMilliseconds(250) };

    private void OnPetMouseDown(object sender, MouseButtonEventArgs e)
    {
        if (e.ClickCount >= 2)
        {
            ToggleVisible();
            return;
        }
        // 鼠标只管拖动（2026-10-26 改：说话挪到按住 U 键，两件事不再抢左键）。
        // 阈值放到 6 像素：不再需要"移动代表不想说话"那套判定，手一抖就是拖。
        _downScreen = 桌标点位();
        _winAtDown = new System.Windows.Point(Left, Top);
        _dragging = false;
        PetImage.CaptureMouse();
        e.Handled = true;
    }

    /// <summary>光标在屏幕上的位置，不受窗口自己挪动影响。</summary>
    private static System.Windows.Point 桌标点位()
    {
        var p = WinForms.Cursor.Position;
        return new System.Windows.Point(p.X, p.Y);
    }

    private void OnPetMouseMove(object sender, System.Windows.Input.MouseEventArgs e)
    {
        if (!PetImage.IsMouseCaptured || _dragging) return;
        if (e.LeftButton != MouseButtonState.Pressed) return;

        var now = 桌标点位();
        var dx = now.X - _downScreen.X;
        var dy = now.Y - _downScreen.Y;
        if (Math.Abs(dx) < 6 && Math.Abs(dy) < 6) return;

        // 只挪窗口，不碰录音：录音由 U 键管
        _dragging = true;
        Left = _winAtDown.X + dx;
        Top = _winAtDown.Y + dy;
    }

    private void OnPetMouseUp(object sender, MouseButtonEventArgs e)
    {
        if (PetImage.IsMouseCaptured) PetImage.ReleaseMouseCapture();

        if (_dragging)
        {
            _dragging = false;
            ClampToWorkArea();
            _cfg.Left = Left;
            _cfg.Top = Top;
            _cfg.Save();
            RefreshMenuLabels();
            return;
        }

        // 只是点了一下（没拖动）：提示怎么说话，别让它看着像个坏按钮
        if (!_listening)
        {
            if (_cfg.Bridge is { Enabled: true })
                Say($"按住 {HotkeyName()} 跟本鲸说话，拖着就能挪位置。");
            else
                Say("先在右键菜单里打开「连本鲸」，本鲸才听得见。");
        }
    }

    private void OnPetLostCapture(object sender, System.Windows.Input.MouseEventArgs e)
    {
        // ⚠ 别在这里取消录音。鼠标一松手，WPF 会自己先释放捕获，
        // LostMouseCapture 比 MouseLeftButtonUp 先到 —— 在这里 CancelListen 就等于
        // "每次松手都把刚说的话吞掉"（2026-10-25 实测：日志里全是 listen start → listen cancel）。
        // 收尾交给热键轮询：键一松就 EndListen，_listenTick 再兜一次底。
    }

    // ---------------- 按住 U 说话（全局热键，鼠标只管拖动） ----------------

    private bool _modalOpen;

    private readonly System.Windows.Threading.DispatcherTimer _hotkeyTick =
        new() { Interval = TimeSpan.FromMilliseconds(50) };
    private bool _hotkeyWasDown;

    /// <summary>配置里的热键名（"U" / "u" / "F8"），认不出来就当 U。</summary>
    private string HotkeyName() =>
        string.IsNullOrWhiteSpace(_cfg.Hotkey) ? "U" : _cfg.Hotkey.Trim().ToUpperInvariant();

    /// <summary>把热键名翻译成虚拟键码；只支持单个字母/数字，别的都给 0x55(U)。</summary>
    private int HotkeyVk()
    {
        var name = HotkeyName();
        if (name.Length == 1)
        {
            var ch = name[0];
            if (ch is >= 'A' and <= 'Z') return 0x41 + (ch - 'A');
            if (ch is >= '0' and <= '9') return 0x30 + (ch - '0');
        }
        return 0x55; // U
    }

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int vKey);

    private static bool VkDown(int vk) => (GetAsyncKeyState(vk) & 0x8000) != 0;

    /// <summary>热键这会儿是不是按着（Ctrl/Alt/Shift/Win 一起按着不算，免得抢输入法/系统快捷键）。</summary>
    private bool HotkeyDown()
    {
        if (VkDown(0x11) || VkDown(0x12) || VkDown(0x10) || VkDown(0x5B) || VkDown(0x5C)) return false;
        return VkDown(HotkeyVk());
    }

    private void OnHotkeyTick(object? sender, EventArgs e)
    {
        // 自己在弹「加提醒」窗口时别抢键：那里可能要打字母 U
        if (_modalOpen) { _hotkeyWasDown = false; return; }
        if (!IsVisible) { _hotkeyWasDown = false; return; }

        var down = HotkeyDown();
        if (down == _hotkeyWasDown) return;
        _hotkeyWasDown = down;

        if (down)
        {
            if (_listening || _dragging) return;
            if (_cfg.Bridge is not { Enabled: true })
            {
                Say("先在右键菜单里打开「连本鲸」，本鲸才听得见。");
                return;
            }
            BeginListen();
        }
        else EndListen(send: true);
    }

    private void BeginListen()
    {
        if (_listening) return;
        if (_cfg.Bridge is not { Enabled: true }) return;

        // 一开口就把"此刻之前排着的旧回复"作废：上一轮的答别等这一轮才念
        _bridge?.只念新的();
        _rec ??= new Recorder();
        try
        {
            _rec.Start();
        }
        catch (Exception ex)
        {
            Log("mic err: " + ex.Message);
            Say("听不到麦克风：" + ex.Message, "error");
            return;
        }

        _listening = true;
        _listenStart = DateTime.Now;
        ShowListenBadge();
        Log("listen start");
    }

    private void EndListen(bool send)
    {
        if (!_listening) return;
        _listening = false;
        if (PetImage.IsMouseCaptured) { try { PetImage.ReleaseMouseCapture(); } catch { } }
        HideListenBadge();

        var 秒 = DateTime.Now - _listenStart;
        byte[]? wav = null;
        var 峰值 = 0.0;
        try { wav = _rec?.Stop(); 峰值 = _rec?.Peak ?? 0; } catch (Exception ex) { Log("mic stop err: " + ex.Message); }
        Log($"listen stop {秒.TotalSeconds:F1}s send={send} bytes={wav?.Length ?? 0} peak={峰值:F3}");

        if (!send || wav == null)
        {
            if (send && 秒.TotalSeconds < 0.4) Say($"太短了，按住 {HotkeyName()} 再说。");
            return;
        }
        // 一声没出（比如按着发呆、麦克风根本没开）：别拿去认，认出来也是瞎编
        if (峰值 < 0.02)
        {
            Log("peak 太低，当没说话处理");
            Say("本鲸没听见声音——是忘了出声，还是麦克风没开？");
            return;
        }
        _ = TranscribeAndSendAsync(wav);
    }

    private void CancelListen()
    {
        if (!_listening) return;
        _listening = false;
        HideListenBadge();
        try { _rec?.Cancel(); } catch { }
        Log("listen cancel");
    }

    private void ShowListenBadge()
    {
        ListenText.Text = "正在听…";
        ListenBadge.Visibility = Visibility.Visible;
        var 呼吸 = new DoubleAnimation(1, 0.25, TimeSpan.FromSeconds(0.55))
        {
            AutoReverse = true,
            RepeatBehavior = RepeatBehavior.Forever,
        };
        ListenDot.BeginAnimation(OpacityProperty, 呼吸);
        _listenTick.Tick -= OnListenTick;
        _listenTick.Tick += OnListenTick;
        _listenTick.Start();
    }

    private void OnListenTick(object? sender, EventArgs e)
    {
        if (!_listening) return;
        var 秒 = (DateTime.Now - _listenStart).TotalSeconds;
        ListenText.Text = $"正在听 {秒:F0}s";

        // 兜底：热键已经松开但轮询没轮到（切换桌面、锁屏）——按"说完了"处理，别白丢。
        if (!HotkeyDown())
        {
            Log($"{HotkeyName()} 已松开，按说完处理");
            EndListen(send: true);
        }
    }

    private void HideListenBadge()
    {
        _listenTick.Stop();
        ListenDot.BeginAnimation(OpacityProperty, null);
        ListenDot.Opacity = 1;
        ListenBadge.Visibility = Visibility.Collapsed;
    }

    /// <summary>认得出来的字够不够当成一句话：汉字/字母至少两个（"1育。" 这种是静音瞎编的）。</summary>
    private static bool 有内容(string text)
    {
        var n = 0;
        foreach (var c in text)
        {
            if (char.IsLetter(c) && c > 0x7F) n++;          // 汉字、假名
            else if (c is >= 'a' and <= 'z' or >= 'A' and <= 'Z') n++;
        }
        return n >= 2;
    }

    private async Task TranscribeAndSendAsync(byte[] wav)
    {
        if (_bridge == null)
        {
            Say("本鲸没连着（右键菜单里打开「连本鲸」）。", "error");
            return;
        }

        var 结果 = await _bridge.TranscribeAsync(wav).ConfigureAwait(true);
        if (!string.IsNullOrWhiteSpace(结果.Text) && 有内容(结果.Text!))
        {
            // 认出什么只记日志，不冒气泡：念一遍自己听到的话，只会把气泡挤成一串
            var 短 = 结果.Text!.Length > 40 ? 结果.Text[..40] + "…" : 结果.Text;
            Log("听见「" + 短 + "」");
            await SendToBridgeAsync(结果.Text!).ConfigureAwait(true);
            return;
        }
        if (!string.IsNullOrWhiteSpace(结果.Text))
        {
            // 静音时 SenseVoice 会瞎编一两个字（"1育。" 这种），别拿它当需求
            Log("听见「" + 结果.Text + "」，不像话，丢掉");
            Say("没听清，再说一遍？");
            return;
        }
        if (结果.IsPreparing)
        {
            Say("等本鲸把耳朵准备好——第一次要下两百多兆。");
            return;
        }
        Say(结果.Error ?? "没听清。", "error");
    }

    // ---------------- 生命周期 ----------------

    protected override void OnClosed(EventArgs e)
    {
        _cfg.Left = Left;
        _cfg.Top = Top;
        _cfg.Save();
        CancelListen();
        _listenTick.Stop();
        try { _rec?.Dispose(); } catch { }
        _feed?.Stop();
        _bridge?.Stop();
        if (_tray != null) { _tray.Visible = false; _tray.Dispose(); }
        base.OnClosed(e);
        System.Windows.Application.Current.Shutdown();
    }
}
