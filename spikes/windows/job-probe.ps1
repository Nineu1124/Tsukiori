param(
  [ValidateSet("main", "parent", "child")]
  [string]$Mode = "main",
  [string]$ChildPidFile
)

$ErrorActionPreference = "Stop"

if ($Mode -eq "child") {
  Start-Sleep -Seconds 60
  exit 0
}

if ($Mode -eq "parent") {
  Start-Sleep -Milliseconds 1000
  $child = Start-Process pwsh -ArgumentList @(
    "-NoLogo",
    "-NoProfile",
    "-File",
    $PSCommandPath,
    "-Mode",
    "child"
  ) -PassThru -WindowStyle Hidden
  [IO.File]::WriteAllText(
    $ChildPidFile,
    $child.Id.ToString([Globalization.CultureInfo]::InvariantCulture),
    [Text.UTF8Encoding]::new($false)
  )
  Start-Sleep -Seconds 60
  exit 0
}

Add-Type -TypeDefinition @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class TsukioriJobObject {
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);

    [DllImport("kernel32.dll")]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int infoClass,
        IntPtr info,
        uint infoLength
    );

    [DllImport("kernel32.dll")]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    public static IntPtr CreateKillOnClose() {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) {
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }

        var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int length = Marshal.SizeOf(info);
        IntPtr pointer = Marshal.AllocHGlobal(length);
        try {
            Marshal.StructureToPtr(info, pointer, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, pointer, (uint)length)) {
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            }
        }
        finally {
            Marshal.FreeHGlobal(pointer);
        }
        return job;
    }

    public static void Assign(IntPtr job, Process process) {
        if (!AssignProcessToJobObject(job, process.Handle)) {
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }
    }

    public static void Close(IntPtr job) {
        if (!CloseHandle(job)) {
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }
    }
}
"@

function Test-ProcessAlive([int]$Id) {
  return $null -ne (Get-Process -Id $Id -ErrorAction SilentlyContinue)
}

function Get-Fingerprint([Diagnostics.Process]$Process) {
  $Process.Refresh()
  return [ordered]@{
    pid = $Process.Id
    startedAtTicks = $Process.StartTime.ToUniversalTime().Ticks
    executable = $Process.MainModule.FileName
  }
}

function Test-Fingerprint($Expected, $Actual) {
  return (
    $Expected.pid -eq $Actual.pid -and
    $Expected.startedAtTicks -eq $Actual.startedAtTicks -and
    [string]::Equals(
      $Expected.executable,
      $Actual.executable,
      [StringComparison]::OrdinalIgnoreCase
    )
  )
}

$work = if ($ChildPidFile) {
  Split-Path -Parent $ChildPidFile
}
else {
  Join-Path $env:TEMP ("tsukiori-job-" + [guid]::NewGuid().ToString("N"))
}
[void](New-Item -ItemType Directory -Force -Path $work)
$pidFile = Join-Path $work "child.pid"
$parent = $null
$unrelated = $null
$job = [IntPtr]::Zero

try {
  $parent = Start-Process pwsh -ArgumentList @(
    "-NoLogo",
    "-NoProfile",
    "-File",
    $PSCommandPath,
    "-Mode",
    "parent",
    "-ChildPidFile",
    $pidFile
  ) -PassThru -WindowStyle Hidden

  $job = [TsukioriJobObject]::CreateKillOnClose()
  [TsukioriJobObject]::Assign($job, $parent)

  $deadline = (Get-Date).AddSeconds(15)
  while (-not (Test-Path -LiteralPath $pidFile) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 50
  }
  if (-not (Test-Path -LiteralPath $pidFile)) {
    throw "child PID was not published"
  }
  $childPid = [int][IO.File]::ReadAllText($pidFile)
  if (-not (Test-ProcessAlive $childPid)) {
    throw "child process exited before job close"
  }

  [TsukioriJobObject]::Close($job)
  $job = [IntPtr]::Zero

  $deadline = (Get-Date).AddSeconds(10)
  while (
    ((Test-ProcessAlive $parent.Id) -or (Test-ProcessAlive $childPid)) -and
    (Get-Date) -lt $deadline
  ) {
    Start-Sleep -Milliseconds 50
  }
  $treeTerminated = (
    -not (Test-ProcessAlive $parent.Id) -and
    -not (Test-ProcessAlive $childPid)
  )

  $unrelated = Start-Process pwsh -ArgumentList @(
    "-NoLogo",
    "-NoProfile",
    "-File",
    $PSCommandPath,
    "-Mode",
    "child"
  ) -PassThru -WindowStyle Hidden
  $actual = Get-Fingerprint $unrelated
  $stale = [ordered]@{
    pid = $actual.pid
    startedAtTicks = $actual.startedAtTicks + 1
    executable = $actual.executable
  }
  $guardRejectedStaleIdentity = -not (Test-Fingerprint $stale $actual)
  $unrelatedSurvivedGuard = Test-ProcessAlive $unrelated.Id

  [ordered]@{
    jobAssigned = $true
    parentPidObserved = $parent.Id -gt 0
    childPidObserved = $childPid -gt 0
    treeTerminatedOnJobClose = $treeTerminated
    fingerprintFields = @("pid", "startedAtTicks", "executable")
    guardRejectedStaleIdentity = $guardRejectedStaleIdentity
    unrelatedSurvivedGuard = $unrelatedSurvivedGuard
  } | ConvertTo-Json -Depth 6
}
finally {
  if ($job -ne [IntPtr]::Zero) {
    [TsukioriJobObject]::Close($job)
  }
  foreach ($process in @($parent, $unrelated)) {
    if ($process -and -not $process.HasExited) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
  }
}
