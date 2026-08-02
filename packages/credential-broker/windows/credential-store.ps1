param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('write', 'read', 'delete')]
  [string]$Operation,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^Tsukiori/[a-f0-9]{64}$')]
  [string]$Target
)

$ErrorActionPreference = 'Stop'

if (-not ('Tsukiori.Security.CredentialNative' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

namespace Tsukiori.Security {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct NativeCredential {
    public UInt32 Flags;
    public UInt32 Type;
    [MarshalAs(UnmanagedType.LPWStr)] public string TargetName;
    [MarshalAs(UnmanagedType.LPWStr)] public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    [MarshalAs(UnmanagedType.LPWStr)] public string TargetAlias;
    [MarshalAs(UnmanagedType.LPWStr)] public string UserName;
  }

  public static class CredentialNative {
    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredWrite(ref NativeCredential credential, UInt32 flags);

    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);

    [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredDelete(string target, UInt32 type, UInt32 flags);

    [DllImport("advapi32.dll", EntryPoint = "CredFree", SetLastError = false)]
    public static extern void CredFree(IntPtr buffer);
  }
}
'@
}

$genericType = 1
$persistLocalMachine = 2
$utf8 = [Text.UTF8Encoding]::new($false)

if ($Operation -eq 'write') {
  $value = [Console]::In.ReadToEnd()
  $bytes = $utf8.GetBytes($value)
  if ($bytes.Length -eq 0 -or $bytes.Length -gt 2560) { throw 'Credential payload size is invalid' }
  $pointer = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
  try {
    [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $pointer, $bytes.Length)
    $credential = [Tsukiori.Security.NativeCredential]::new()
    $credential.Type = $genericType
    $credential.TargetName = $Target
    $credential.UserName = 'Tsukiori'
    $credential.CredentialBlobSize = $bytes.Length
    $credential.CredentialBlob = $pointer
    $credential.Persist = $persistLocalMachine
    if (-not [Tsukiori.Security.CredentialNative]::CredWrite([ref]$credential, 0)) {
      throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())
    }
    [Console]::Out.Write('{"stored":true}')
  } finally {
    [Array]::Clear($bytes, 0, $bytes.Length)
    [Runtime.InteropServices.Marshal]::FreeHGlobal($pointer)
  }
  exit 0
}

if ($Operation -eq 'read') {
  $pointer = [IntPtr]::Zero
  if (-not [Tsukiori.Security.CredentialNative]::CredRead($Target, $genericType, 0, [ref]$pointer)) {
    throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())
  }
  try {
    $credential = [Runtime.InteropServices.Marshal]::PtrToStructure(
      $pointer, [type][Tsukiori.Security.NativeCredential]
    )
    $bytes = [byte[]]::new($credential.CredentialBlobSize)
    [Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob, $bytes, 0, $bytes.Length)
    try {
      $value = $utf8.GetString($bytes)
      $encoded = [Convert]::ToBase64String($utf8.GetBytes($value))
      [Console]::Out.Write('{"value":"' + $encoded + '"}')
    } finally {
      [Array]::Clear($bytes, 0, $bytes.Length)
    }
  } finally {
    [Tsukiori.Security.CredentialNative]::CredFree($pointer)
  }
  exit 0
}

$deleted = [Tsukiori.Security.CredentialNative]::CredDelete($Target, $genericType, 0)
if (-not $deleted -and [Runtime.InteropServices.Marshal]::GetLastWin32Error() -ne 1168) {
  throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())
}
[Console]::Out.Write('{"deleted":' + $(if ($deleted) { 'true' } else { 'false' }) + '}')
