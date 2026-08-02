param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9._-]{8,120}$')]
  [string]$PipeName,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-f0-9-]{36}$')]
  [string]$DaemonInstanceId,

  [Parameter(Mandatory = $true)]
  [int]$ProtocolVersion,

  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 2147483647)]
  [int]$DaemonPid,

  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 9223372036854775807)]
  [long]$DaemonStartTimeUtcTicks,

  [int]$MaxConnections = 32
)

$ErrorActionPreference = 'Stop'
$token = $env:TSUKIORI_IPC_BOOTSTRAP_TOKEN
if ([string]::IsNullOrWhiteSpace($token) -or $token.Length -lt 32) {
  throw 'TSUKIORI_IPC_BOOTSTRAP_TOKEN must contain at least 32 characters'
}

if (-not ('Tsukiori.Windows.PipePeer' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Threading;

namespace Tsukiori.Windows {
  public static class PipePeer {
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    private const uint TOKEN_QUERY = 0x0008;

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetNamedPipeClientProcessId(IntPtr pipe, out uint clientProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    public static uint GetClientProcessId(IntPtr pipe) {
      if (!GetNamedPipeClientProcessId(pipe, out uint pid)) {
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      }
      return pid;
    }

    public static string GetProcessUserSid(uint pid) {
      IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
      if (process == IntPtr.Zero) {
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      }
      try {
        if (!OpenProcessToken(process, TOKEN_QUERY, out IntPtr token)) {
          throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }
        try {
          using (WindowsIdentity identity = new WindowsIdentity(token)) {
            return identity.User.Value;
          }
        } finally {
          CloseHandle(token);
        }
      } finally {
        CloseHandle(process);
      }
    }
  }

  public static class ParentWatchdog {
    public static void Start(int parentPid, long expectedStartTicks, long toleranceTicks) {
      Thread thread = new Thread(() => {
        try {
          using (Process parent = Process.GetProcessById(parentPid)) {
            long actualStartTicks = parent.StartTime.ToUniversalTime().Ticks;
            if (Math.Abs(actualStartTicks - expectedStartTicks) > toleranceTicks) {
              Environment.Exit(0);
            }
            parent.WaitForExit();
            Environment.Exit(0);
          }
        } catch (ArgumentException) {
          Environment.Exit(0);
        } catch (InvalidOperationException) {
          Environment.Exit(0);
        }
      });
      thread.IsBackground = true;
      thread.Name = "TsukioriDaemonParentWatchdog";
      thread.Start();
    }
  }
}
'@
}

[Tsukiori.Windows.ParentWatchdog]::Start(
  $DaemonPid,
  $DaemonStartTimeUtcTicks,
  [TimeSpan]::FromSeconds(5).Ticks
)

$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$utf8 = [System.Text.UTF8Encoding]::new($false)
$events = @(
  [ordered]@{ streamSequence = 1; type = 'daemon.started'; payload = [ordered]@{ state = 'running' } },
  [ordered]@{ streamSequence = 2; type = 'runtime.summary'; payload = [ordered]@{ activeHandles = 0 } }
)
$shutdownRequested = $false

function Write-JsonLine {
  param(
    [Parameter(Mandatory = $true)]$Writer,
    [Parameter(Mandatory = $true)]$Value
  )
  $Writer.WriteLine(($Value | ConvertTo-Json -Compress -Depth 12))
  $Writer.Flush()
}

function Write-Audit {
  param([string]$Type, [string]$Reason, [string]$ConnectionEpoch)
  $record = [ordered]@{
    type = $Type
    reason = $Reason
    connectionEpoch = $ConnectionEpoch
    at = '<timestamp>'
  }
  [Console]::Error.WriteLine(($record | ConvertTo-Json -Compress))
}

function Get-Proof {
  param([string]$Challenge)
  $data = $utf8.GetBytes($Challenge + '|' + $DaemonInstanceId + '|' + $ProtocolVersion)
  $key = $utf8.GetBytes($token)
  $hmac = [System.Security.Cryptography.HMACSHA256]::new($key)
  try {
    return [Convert]::ToHexString($hmac.ComputeHash($data)).ToLowerInvariant()
  } finally {
    $hmac.Dispose()
    [Array]::Clear($key, 0, $key.Length)
  }
}



for ($connectionIndex = 0; $connectionIndex -lt $MaxConnections; $connectionIndex += 1) {
  $options = [System.IO.Pipes.PipeOptions]::Asynchronous -bor
    [System.IO.Pipes.PipeOptions]::WriteThrough -bor
    [System.IO.Pipes.PipeOptions]::CurrentUserOnly
  $server = [System.IO.Pipes.NamedPipeServerStream]::new(
    $PipeName,
    [System.IO.Pipes.PipeDirection]::InOut,
    1,
    [System.IO.Pipes.PipeTransmissionMode]::Byte,
    $options,
    65536,
    65536
  )
  if ($connectionIndex -eq 0) {
    [Console]::Out.WriteLine((([ordered]@{
  type = 'pipe.ready'
  pipeName = $PipeName
  daemonInstanceId = $DaemonInstanceId
  protocolVersion = $ProtocolVersion
  aclMode = 'current_user_only'
  expectedPeerSid = '<current-user-sid>'
}) | ConvertTo-Json -Compress))
[Console]::Out.Flush()
  }
  $reader = $null
  $writer = $null
  $epoch = [Guid]::NewGuid().ToString('N')
  try {
    $server.WaitForConnection()
    $peerPid = [Tsukiori.Windows.PipePeer]::GetClientProcessId(
      $server.SafePipeHandle.DangerousGetHandle()
    )
    $peerSid = [Tsukiori.Windows.PipePeer]::GetProcessUserSid($peerPid)
    if ($peerSid -ne $currentSid) {
      Write-Audit 'peer.rejected' 'sid_mismatch' $epoch
      $server.Disconnect()
      continue
    }
    Write-Audit 'peer.verified' 'current_user_sid' $epoch

    $reader = [System.IO.StreamReader]::new($server, $utf8, $false, 4096, $true)
    $writer = [System.IO.StreamWriter]::new($server, $utf8, 4096, $true)
    $writer.AutoFlush = $true
    $challengeBytes = [byte[]]::new(32)
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($challengeBytes)
    $challenge = [Convert]::ToHexString($challengeBytes).ToLowerInvariant()
    [Array]::Clear($challengeBytes, 0, $challengeBytes.Length)

    Write-JsonLine $writer ([ordered]@{
      type = 'ipc.challenge'
      daemonInstanceId = $DaemonInstanceId
      protocolVersion = $ProtocolVersion
      challenge = $challenge
      connectionEpoch = $epoch
    })

    $authLine = $reader.ReadLine()
    if ($null -eq $authLine -or $authLine.Length -gt 65536) {
      Write-Audit 'auth.rejected' 'missing_or_oversized' $epoch
      continue
    }
    try {
      $auth = $authLine | ConvertFrom-Json -Depth 12
    } catch {
      Write-JsonLine $writer ([ordered]@{ type = 'ipc.error'; code = 'invalid_json' })
      Write-Audit 'auth.rejected' 'invalid_json' $epoch
      continue
    }
    if ($auth.type -ne 'ipc.authenticate') {
      Write-JsonLine $writer ([ordered]@{ type = 'ipc.error'; code = 'authentication_required' })
      Write-Audit 'auth.rejected' 'wrong_message' $epoch
      continue
    }
    if ([int]$auth.protocolVersion -ne $ProtocolVersion) {
      Write-JsonLine $writer ([ordered]@{ type = 'ipc.error'; code = 'incompatible_protocol' })
      Write-Audit 'auth.rejected' 'incompatible_protocol' $epoch
      continue
    }
    if ([string]$auth.daemonInstanceId -ne $DaemonInstanceId) {
      Write-JsonLine $writer ([ordered]@{ type = 'ipc.error'; code = 'stale_instance' })
      Write-Audit 'auth.rejected' 'stale_instance' $epoch
      continue
    }

    $expectedProof = Get-Proof $challenge
    $providedProof = [string]$auth.proof
    $expectedBytes = $utf8.GetBytes($expectedProof)
    $providedBytes = $utf8.GetBytes($providedProof)
    $proofValid = $expectedBytes.Length -eq $providedBytes.Length -and
      [System.Security.Cryptography.CryptographicOperations]::FixedTimeEquals(
        $expectedBytes,
        $providedBytes
      )
    [Array]::Clear($expectedBytes, 0, $expectedBytes.Length)
    [Array]::Clear($providedBytes, 0, $providedBytes.Length)
    if (-not $proofValid) {
      Write-JsonLine $writer ([ordered]@{ type = 'ipc.error'; code = 'invalid_proof' })
      Write-Audit 'auth.rejected' 'invalid_proof' $epoch
      continue
    }

    Write-JsonLine $writer ([ordered]@{
      type = 'ipc.authenticated'
      daemonInstanceId = $DaemonInstanceId
      protocolVersion = $ProtocolVersion
      connectionEpoch = $epoch
      peerIdentityVerified = $true
      snapshotVersion = 1
      streamId = $DaemonInstanceId
      latestStreamSequence = 2
    })
    Write-Audit 'auth.accepted' 'challenge_response' $epoch

    while ($server.IsConnected) {
      $line = $reader.ReadLine()
      if ($null -eq $line) {
        break
      }
      if ($line.Length -gt 65536) {
        Write-JsonLine $writer ([ordered]@{ jsonrpc = '2.0'; id = $null; error = [ordered]@{ code = 'message_too_large' } })
        Write-Audit 'request.rejected' 'message_too_large' $epoch
        break
      }
      try {
        $request = $line | ConvertFrom-Json -Depth 12
      } catch {
        Write-JsonLine $writer ([ordered]@{ jsonrpc = '2.0'; id = $null; error = [ordered]@{ code = 'invalid_json' } })
        Write-Audit 'request.rejected' 'invalid_json' $epoch
        continue
      }
      if ($request.jsonrpc -ne '2.0' -or [string]::IsNullOrWhiteSpace([string]$request.id)) {
        Write-JsonLine $writer ([ordered]@{ jsonrpc = '2.0'; id = $null; error = [ordered]@{ code = 'invalid_request' } })
        Write-Audit 'request.rejected' 'invalid_envelope' $epoch
        continue
      }
      if ($request.method -eq 'daemon.ping') {
        Write-JsonLine $writer ([ordered]@{
          jsonrpc = '2.0'
          id = [string]$request.id
          result = [ordered]@{
            daemonInstanceId = $DaemonInstanceId
            connectionEpoch = $epoch
            pid = $DaemonPid
            protocolVersion = $ProtocolVersion
          }
        })
        continue
      }
      if ($request.method -eq 'daemon.shutdown') {
        Write-JsonLine $writer ([ordered]@{
          jsonrpc = '2.0'
          id = [string]$request.id
          result = [ordered]@{
            accepted = $true
            daemonInstanceId = $DaemonInstanceId
          }
        })
        $shutdownRequested = $true
        break
      }
      if ($request.method -ne 'stream.subscribe') {
        Write-JsonLine $writer ([ordered]@{ jsonrpc = '2.0'; id = [string]$request.id; error = [ordered]@{ code = 'method_not_found' } })
        Write-Audit 'request.rejected' 'method_not_found' $epoch
        continue
      }

      $last = $request.params.lastStreamSequence
      $snapshot = $request.params.knownSnapshotVersion
      if ($last -isnot [int] -and $last -isnot [long]) {
        Write-JsonLine $writer ([ordered]@{ jsonrpc = '2.0'; id = [string]$request.id; error = [ordered]@{ code = 'invalid_params' } })
        Write-Audit 'request.rejected' 'invalid_params' $epoch
        continue
      }
      if ([long]$last -lt 0 -or [long]$last -gt 2) {
        Write-JsonLine $writer ([ordered]@{ jsonrpc = '2.0'; id = [string]$request.id; error = [ordered]@{ code = 'invalid_params' } })
        Write-Audit 'request.rejected' 'invalid_sequence' $epoch
        continue
      }

      $mode = if ([long]$snapshot -eq 1) { 'incremental' } else { 'snapshot' }
      $selected = if ($mode -eq 'incremental') {
        @($events | Where-Object { $_.streamSequence -gt [long]$last })
      } else {
        @($events)
      }
      Write-JsonLine $writer ([ordered]@{
        jsonrpc = '2.0'
        id = [string]$request.id
        result = [ordered]@{
          mode = $mode
          snapshot = if ($mode -eq 'snapshot') {
            [ordered]@{ version = 1; daemonState = 'running'; openSessions = @() }
          } else { $null }
          streamId = $DaemonInstanceId
          latestStreamSequence = 2
          events = [object[]]$selected
        }
      })
    }
  } catch {
    Write-Audit 'connection.error' $_.Exception.GetType().Name $epoch
  } finally {
    Write-Audit 'connection.closed' 'transport_closed' $epoch
    if ($null -ne $reader) { try { $reader.Dispose() } catch { Write-Audit 'connection.cleanup' 'reader_pipe_broken' $epoch } }
    if ($null -ne $writer) { try { $writer.Dispose() } catch { Write-Audit 'connection.cleanup' 'writer_pipe_broken' $epoch } }
    try { $server.Dispose() } catch { Write-Audit 'connection.cleanup' 'server_pipe_broken' $epoch }
  }
  if ($shutdownRequested) { break }
}
