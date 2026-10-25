using System.Windows;
using System.Windows.Controls;

namespace DafeiyuPet;

public partial class AddReminderWindow : Window
{
    public Reminder? Result { get; private set; }

    public AddReminderWindow()
    {
        InitializeComponent();
        var next = DateTime.Now.AddHours(1);
        TxtTime.Text = next.ToString("HH:mm");
        TxtDate.Text = DateTime.Now.ToString("yyyy-MM-dd");
        CmbRepeat.SelectionChanged += (_, _) =>
            DateRow.Visibility = CmbRepeat.SelectedIndex == 1 ? Visibility.Visible : Visibility.Collapsed;
        Loaded += (_, _) => TxtWhat.Focus();
    }

    private void OnCancel(object sender, RoutedEventArgs e)
    {
        DialogResult = false;
        Close();
    }

    private void OnOk(object sender, RoutedEventArgs e)
    {
        var what = (TxtWhat.Text ?? "").Trim();
        var at = (TxtTime.Text ?? "").Trim();
        if (what.Length == 0) { Err.Text = "总得写点什么。"; return; }
        if (!TimeSpan.TryParse(at, out var ts) || ts.TotalHours >= 24 || ts < TimeSpan.Zero)
        {
            Err.Text = "时间写成 HH:mm，比如 09:30。";
            return;
        }
        var once = CmbRepeat.SelectedIndex == 1;
        string? date = null;
        if (once)
        {
            var d = (TxtDate.Text ?? "").Trim();
            if (!DateTime.TryParse(d, out var dt)) { Err.Text = "日期写成 yyyy-MM-dd。"; return; }
            date = dt.ToString("yyyy-MM-dd");
        }
        Result = new Reminder
        {
            Text = what,
            At = ts.ToString(@"hh\:mm"),
            Repeat = once ? "once" : "daily",
            Date = date,
        };
        DialogResult = true;
        Close();
    }
}
