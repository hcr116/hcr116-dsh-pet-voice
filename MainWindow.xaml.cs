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

    private WinForms.NotifyIcon? _tray;
    private WinForms.ToolStripMenuItem? _muteItem;
    private WinForms.ToolStripMenuItem? _linkItem;
    private WinForms.ToolStripMenuItem? _showItem;
    private WinForms.ToolStripMenuItem? _voiceItem;

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
            StartFeed();
            _clock.Tick += (_, _) => TickReminders();
            _clock.Start();
            _bubbleHide.Tick += (_, _) => { _bubbleHide.Stop(); HideBubble(); };
            Say(_store.Items.Count > 0
                ? $"本鲸在。今天记着 {_store.Items.Count(x => x.Enabled)} 条提醒。"
                : "本鲸在。有什么事，右键点我。");
        };

        try { _reminderMtime = File.GetLastWriteTime(PetConfig.ReminderPath); } catch { }
        PetImage.MouseLeftButtonDown += OnPetMouseDown;
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
        m.Items.Add(new WinForms.ToolStripMenuItem("打开提醒文件", null, (_, _) => OpenFolder(PetConfig.ReminderPath)));

        m.Items.Add(new WinForms.ToolStripSeparator());

        _linkItem = new WinForms.ToolStripMenuItem("连服务器（QQ 那边的话）", null, (_, _) => ToggleLink())
        {
            CheckOnClick = false,
        };
        m.Items.Add(_linkItem);

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
            _voiceItem.Text = on ? "朗读（本地语音，开着）" : "朗读（本地语音，关着）";
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

    private void OpenAddReminder()
    {
        var dlg = new AddReminderWindow { Owner = IsVisible ? this : null };
        if (dlg.ShowDialog() == true && dlg.Result != null)
        {
            _store.Add(dlg.Result);
            Say($"记下了：{dlg.Result.Label} {dlg.Result.Text}");
        }
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

    // ---------------- 生命周期 ----------------

    private void OnPetMouseDown(object sender, MouseButtonEventArgs e)
    {
        if (e.ClickCount >= 2)
        {
            ToggleVisible();
            return;
        }
        try { DragMove(); }
        catch { }
        ClampToWorkArea();
        _cfg.Left = Left;
        _cfg.Top = Top;
        _cfg.Save();
        RefreshMenuLabels();
    }

    protected override void OnClosed(EventArgs e)
    {
        _cfg.Left = Left;
        _cfg.Top = Top;
        _cfg.Save();
        _feed?.Stop();
        if (_tray != null) { _tray.Visible = false; _tray.Dispose(); }
        base.OnClosed(e);
        System.Windows.Application.Current.Shutdown();
    }
}
