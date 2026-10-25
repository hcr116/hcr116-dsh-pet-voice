using System.Threading;
using System.Windows;

namespace DafeiyuPet;

public partial class App : System.Windows.Application
{
    private Mutex? _one;

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        _one = new Mutex(true, @"Global\DafeiyuPet.SingleInstance", out var fresh);
        if (!fresh)
        {
            System.Windows.MessageBox.Show("大肥鱼已经在桌上了，右下角托盘里找她。", "大肥鱼桌宠",
                MessageBoxButton.OK, MessageBoxImage.Information);
            Shutdown();
            return;
        }

        var cfg = PetConfig.Load();
        var win = new MainWindow(cfg);
        MainWindow = win;
        win.Closed += (_, _) => Shutdown();
        win.Show();
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _one?.Dispose();
        base.OnExit(e);
    }
}
