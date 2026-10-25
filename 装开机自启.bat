@echo off
setlocal EnableExtensions
chcp 65001 >nul

rem 1) 把桌宠装到 %LOCALAPPDATA%\Programs\DafeiyuPet
rem 2) 在「启动」文件夹建快捷方式，开机自动出现
rem 注意：必须装在 %LOCALAPPDATA%，不能直接从 D:\ds\dafeiyu 里跑 ——
rem       那个目录带低完整性标签，进程里 SAPI 语音会报 0x80045040 念不出声。

set "SRC=%~dp0publish\DafeiyuPet.exe"
set "DST=%LOCALAPPDATA%\Programs\DafeiyuPet"

if not exist "%SRC%" (
    echo [x] 找不到 %SRC%
    echo     先跑：dotnet publish -c Release -r win-x64 --self-contained false -p:PublishSingleFile=true -o publish
    pause
    exit /b 1
)

if not exist "%DST%" mkdir "%DST%"
taskkill /IM DafeiyuPet.exe /F >nul 2>&1
copy /Y "%SRC%" "%DST%\DafeiyuPet.exe" >nul
if errorlevel 1 (
    echo [x] 复制失败，先关掉正在跑的大肥鱼再试。
    pause
    exit /b 1
)

set "EXE=%DST%\DafeiyuPet.exe"
set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\大肥鱼桌宠.lnk"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%LNK%');" ^
  "$s.TargetPath='%EXE%';" ^
  "$s.WorkingDirectory='%DST%';" ^
  "$s.Description='大肥鱼桌宠';" ^
  "$s.Save()"

if errorlevel 1 (
    echo [x] 建快捷方式失败。
    pause
    exit /b 1
)

echo [ok] 已装到：%DST%
echo [ok] 已加入开机启动：%LNK%
echo      现在双击 %EXE% 就能看到大肥鱼。
pause
