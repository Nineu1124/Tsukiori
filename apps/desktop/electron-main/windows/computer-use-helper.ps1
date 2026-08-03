Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# This helper is deliberately small and single-shot.  The Electron main process
# owns the session lock and approval policy; this process only performs the
# already-authorized Windows API operation and returns bounded JSON.
Add-Type -ReferencedAssemblies 'System.Drawing' -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

public static class TsukioriComputerUseNative {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION U; }

  const uint INPUT_MOUSE = 0;
  const uint INPUT_KEYBOARD = 1;
  const uint KEYEVENTF_KEYUP = 0x0002;
  const uint KEYEVENTF_UNICODE = 0x0004;
  const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  const uint MOUSEEVENTF_LEFTUP = 0x0004;
  const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
  const uint MOUSEEVENTF_RIGHTUP = 0x0010;
  const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
  const uint MOUSEEVENTF_MIDDLEUP = 0x0040;

  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint numberOfInputs, INPUT[] inputs, int size);

  public static object Foreground() {
    var handle = GetForegroundWindow();
    if (handle == IntPtr.Zero) throw new InvalidOperationException("foreground_window_unavailable");
    RECT rect;
    if (!GetWindowRect(handle, out rect)) throw new InvalidOperationException("foreground_rect_unavailable");
    uint pid;
    GetWindowThreadProcessId(handle, out pid);
    var title = new StringBuilder(512);
    GetWindowText(handle, title, title.Capacity);
    return new { handle = handle.ToInt64(), pid, title = title.ToString(), rect = new { left = rect.Left, top = rect.Top, right = rect.Right, bottom = rect.Bottom }, screen = Screen() };
  }

  public static object Screen() {
    return new { left = GetSystemMetrics(76), top = GetSystemMetrics(77), width = GetSystemMetrics(78), height = GetSystemMetrics(79) };
  }

  public static void Move(int x, int y) {
    if (!SetCursorPos(x, y)) throw new InvalidOperationException("cursor_move_failed");
  }

  public static void Click(string button, int clicks) {
    if (clicks < 1 || clicks > 2) throw new ArgumentOutOfRangeException("clicks");
    uint down = button == "right" ? MOUSEEVENTF_RIGHTDOWN : button == "middle" ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_LEFTDOWN;
    uint up = button == "right" ? MOUSEEVENTF_RIGHTUP : button == "middle" ? MOUSEEVENTF_MIDDLEUP : MOUSEEVENTF_LEFTUP;
    for (var i = 0; i < clicks; i++) { mouse_event(down, 0, 0, 0, UIntPtr.Zero); mouse_event(up, 0, 0, 0, UIntPtr.Zero); }
  }

  static void SendKeys(INPUT[] inputs) {
    if (inputs.Length == 0) throw new InvalidOperationException("empty_keyboard_input");
    if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) != inputs.Length) throw new InvalidOperationException("keyboard_input_failed");
  }

  public static void TypeText(string text) {
    if (String.IsNullOrEmpty(text)) return;
    var inputs = new INPUT[text.Length * 2];
    for (var index = 0; index < text.Length; index++) {
      var scan = (ushort)text[index];
      inputs[index * 2] = new INPUT { type = INPUT_KEYBOARD, U = new INPUTUNION { ki = new KEYBDINPUT { wScan = scan, dwFlags = KEYEVENTF_UNICODE } } };
      inputs[index * 2 + 1] = new INPUT { type = INPUT_KEYBOARD, U = new INPUTUNION { ki = new KEYBDINPUT { wScan = scan, dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP } } };
    }
    SendKeys(inputs);
  }

  public static void KeyCombo(int[] virtualKeys) {
    var inputs = new INPUT[virtualKeys.Length * 2];
    for (var index = 0; index < virtualKeys.Length; index++) {
      var key = (ushort)virtualKeys[index];
      inputs[index] = new INPUT { type = INPUT_KEYBOARD, U = new INPUTUNION { ki = new KEYBDINPUT { wVk = key } } };
      inputs[virtualKeys.Length + index] = new INPUT { type = INPUT_KEYBOARD, U = new INPUTUNION { ki = new KEYBDINPUT { wVk = key, dwFlags = KEYEVENTF_KEYUP } } };
    }
    SendKeys(inputs);
  }

  public static object Capture(string path) {
    var screen = Screen();
    var left = (int)screen.GetType().GetProperty("left").GetValue(screen);
    var top = (int)screen.GetType().GetProperty("top").GetValue(screen);
    var width = (int)screen.GetType().GetProperty("width").GetValue(screen);
    var height = (int)screen.GetType().GetProperty("height").GetValue(screen);
    if (width <= 0 || height <= 0 || width > 10000 || height > 10000) throw new InvalidOperationException("screen_bounds_invalid");
    using (var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb)) {
      using (var graphics = Graphics.FromImage(bitmap)) graphics.CopyFromScreen(left, top, 0, 0, new Size(width, height), CopyPixelOperation.SourceCopy);
      bitmap.Save(path, ImageFormat.Png);
    }
    return new { width, height, path };
  }
}
'@

function Write-Response([object]$value) {
  $json = $value | ConvertTo-Json -Compress -Depth 8
  [Console]::Out.WriteLine($json)
}

try {
  $raw = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($raw) -or $raw.Length -gt 128000) { throw 'request_invalid' }
  $request = $raw | ConvertFrom-Json
  $command = [string]$request.command
  switch ($command) {
    'capability' { Write-Response @{ ok = $true; platform = 'windows'; helper = 'user32-gdi' }; break }
    'foreground' {
      $delayMs = if ($request.PSObject.Properties.Name -contains 'delayMs') { [int]$request.delayMs } else { 0 }
      if ($delayMs -gt 0) { Start-Sleep -Milliseconds ([Math]::Min($delayMs, 5000)) }
      $foreground = [TsukioriComputerUseNative]::Foreground()
      $process = $null
      try { $process = Get-Process -Id ([int]$foreground.pid) -ErrorAction Stop } catch { throw 'foreground_process_unavailable' }
      $path = ''
      $startTime = 0
      try { $path = [string]$process.MainModule.FileName } catch { }
      try { $startTime = [int64]$process.StartTime.ToFileTimeUtc() } catch { }
      Write-Response @{ ok = $true; pid = [int]$foreground.pid; path = $path; startTime = $startTime; title = [string]$foreground.title; rect = $foreground.rect; screen = $foreground.screen }
      break
    }
    'screenshot' {
      $path = [string]$request.path
      if ([string]::IsNullOrWhiteSpace($path) -or $path.Length -gt 1024) { throw 'screenshot_path_invalid' }
      $directory = Split-Path -Parent $path
      if (-not (Test-Path -LiteralPath $directory -PathType Container)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
      $capture = [TsukioriComputerUseNative]::Capture($path)
      Write-Response @{ ok = $true; width = $capture.width; height = $capture.height; path = $path }
      break
    }
    'mouse_move' { [TsukioriComputerUseNative]::Move([int]$request.x, [int]$request.y); Write-Response @{ ok = $true; action = 'mouse_move' }; break }
    'mouse_click' { [TsukioriComputerUseNative]::Click([string]$request.button, [int]$request.clicks); Write-Response @{ ok = $true; action = 'mouse_click' }; break }
    'keyboard_type' { [TsukioriComputerUseNative]::TypeText([string]$request.text); Write-Response @{ ok = $true; action = 'keyboard_type' }; break }
    'key_combo' {
      $codes = @($request.keys | ForEach-Object { [int]$_ })
      [TsukioriComputerUseNative]::KeyCombo($codes)
      Write-Response @{ ok = $true; action = 'key_combo' }
      break
    }
    default { throw 'command_unsupported' }
  }
} catch {
  Write-Response @{ ok = $false; code = 'helper_failed'; message = $_.Exception.Message }
  exit 1
}
