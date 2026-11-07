@echo off
REM Builds "Flickr Photo Analyzer.exe" next to start.bat, with the app icon embedded.
REM Uses the C# compiler that ships with Windows, so nothing to install.
REM To change the icon, edit make_icon.ps1, run it, then run this again.

setlocal
cd /d "%~dp0"
set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" (
  echo Couldn't find the .NET Framework C# compiler ^(csc.exe^).
  pause
  exit /b 1
)
if not exist app.ico powershell -NoProfile -ExecutionPolicy Bypass -File make_icon.ps1
"%CSC%" /nologo /target:winexe /optimize /win32icon:app.ico /r:System.Windows.Forms.dll /out:"..\Flickr Photo Analyzer.exe" Launcher.cs
if errorlevel 1 (
  echo Build failed.
  pause
  exit /b 1
)
echo Built "Flickr Photo Analyzer.exe". Right-click it and choose Pin to taskbar.
