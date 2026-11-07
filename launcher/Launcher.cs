// Flickr Photo Analyzer launcher: a small Windows exe with the app's icon, so it can be
// pinned to the taskbar or Start. It runs start.bat in a minimized window, or, if the app
// is already running, just opens it in the browser.
//
// The exe looks for start.bat in its own folder, then the folder above it.
// Written for the C# 5 compiler that ships with Windows
// (C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe), so no newer syntax.
// Build with launcher\build.bat.

using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Text.RegularExpressions;
using System.Windows.Forms;

static class Launcher
{
    const string Title = "Flickr Photo Analyzer";

    [STAThread]
    static int Main()
    {
        string exeDir = AppDomain.CurrentDomain.BaseDirectory;
        string appDir = FindAppDir(exeDir);
        if (appDir == null)
        {
            MessageBox.Show("Couldn't find start.bat.\n\nKeep this program in the Flickr Photo Analyzer folder (next to start.bat).", Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }

        int port = ReadPort(appDir);
        if (IsListening(port))
        {
            OpenUrl("http://127.0.0.1:" + port + "/");
            return 0;
        }

        if (FindOnPath("node.exe") == null)
        {
            DialogResult r = MessageBox.Show("Node.js isn't installed. The analyzer needs it to run.\n\nOpen nodejs.org to download it?", Title, MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
            if (r == DialogResult.Yes) OpenUrl("https://nodejs.org/");
            return 1;
        }

        // start.bat opens the browser itself once the server is up.
        var psi = new ProcessStartInfo("cmd.exe", "/c \"" + Path.Combine(appDir, "start.bat") + "\"");
        psi.WorkingDirectory = appDir;
        psi.UseShellExecute = true;
        psi.WindowStyle = ProcessWindowStyle.Minimized;
        try { Process.Start(psi); }
        catch (Exception e)
        {
            MessageBox.Show("Couldn't start the analyzer:\n\n" + e.Message, Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
        return 0;
    }

    static string FindAppDir(string exeDir)
    {
        string dir = exeDir.TrimEnd('\\');
        for (int i = 0; i < 2 && dir != null; i++)
        {
            if (File.Exists(Path.Combine(dir, "start.bat")) && File.Exists(Path.Combine(dir, "server.js"))) return dir;
            DirectoryInfo parent = Directory.GetParent(dir);
            dir = parent == null ? null : parent.FullName;
        }
        return null;
    }

    static int ReadPort(string appDir)
    {
        string env = Environment.GetEnvironmentVariable("PORT");
        int p;
        if (!string.IsNullOrEmpty(env) && int.TryParse(env, out p)) return p;
        try
        {
            string cfg = Path.Combine(appDir, "config.json");
            if (File.Exists(cfg))
            {
                Match m = Regex.Match(File.ReadAllText(cfg), "\"port\"\\s*:\\s*(\\d+)");
                if (m.Success && int.TryParse(m.Groups[1].Value, out p)) return p;
            }
        }
        catch { }
        return 5177;
    }

    static bool IsListening(int port)
    {
        try
        {
            using (var c = new TcpClient())
            {
                IAsyncResult ar = c.BeginConnect("127.0.0.1", port, null, null);
                if (!ar.AsyncWaitHandle.WaitOne(400)) return false;
                c.EndConnect(ar);
                return true;
            }
        }
        catch { return false; }
    }

    static string FindOnPath(string exe)
    {
        string path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string d in path.Split(';'))
        {
            try
            {
                string f = Path.Combine(d.Trim().Trim('"'), exe);
                if (d.Trim().Length > 0 && File.Exists(f)) return f;
            }
            catch { }
        }
        return null;
    }

    static void OpenUrl(string url)
    {
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
    }
}
