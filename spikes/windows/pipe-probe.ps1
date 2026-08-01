param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("server", "client")]
  [string]$Mode,
  [Parameter(Mandatory = $true)]
  [string]$PipeName,
  [string]$ReadyFile,
  [string]$ReportFile,
  [string]$Message = "ping"
)

$ErrorActionPreference = "Stop"

if ($Mode -eq "server") {
  if (-not $ReadyFile -or -not $ReportFile) {
    throw "server mode requires ReadyFile and ReportFile"
  }

  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $sid = $identity.User
  $options = [System.IO.Pipes.PipeOptions](
    [int][System.IO.Pipes.PipeOptions]::Asynchronous -bor
    [int][System.IO.Pipes.PipeOptions]::CurrentUserOnly
  )
  $report = $null

  for ($index = 0; $index -lt 2; $index++) {
    $server = [System.IO.Pipes.NamedPipeServerStream]::new(
      $PipeName,
      [System.IO.Pipes.PipeDirection]::InOut,
      1,
      [System.IO.Pipes.PipeTransmissionMode]::Byte,
      $options,
      4096,
      4096
    )
    try {
      if ($index -eq 0) {
        $actualSecurity = [System.IO.Pipes.PipesAclExtensions]::GetAccessControl($server)
        $rules = @($actualSecurity.GetAccessRules(
          $true,
          $true,
          [System.Security.Principal.SecurityIdentifier]
        ))
        $report = [ordered]@{
          currentUserOnly = $true
          currentSid = $sid.Value
          ownerSid = $actualSecurity.GetOwner(
            [System.Security.Principal.SecurityIdentifier]
          ).Value
          accessRuleCount = $rules.Count
          accessRules = @($rules | ForEach-Object {
            [ordered]@{
              sid = $_.IdentityReference.Value
              type = $_.AccessControlType.ToString()
              rights = $_.PipeAccessRights.ToString()
            }
          })
          sddl = $actualSecurity.GetSecurityDescriptorSddlForm(
            [System.Security.AccessControl.AccessControlSections]::All
          )
          acceptedConnections = 0
        }
        [IO.File]::WriteAllText(
          $ReportFile,
          ($report | ConvertTo-Json -Depth 8),
          [Text.UTF8Encoding]::new($false)
        )
        [IO.File]::WriteAllText($ReadyFile, "ready", [Text.UTF8Encoding]::new($false))
      }

      $server.WaitForConnection()
      $reader = [IO.StreamReader]::new(
        $server,
        [Text.UTF8Encoding]::new($false),
        $false,
        1024,
        $true
      )
      $writer = [IO.StreamWriter]::new(
        $server,
        [Text.UTF8Encoding]::new($false),
        1024,
        $true
      )
      $writer.AutoFlush = $true
      try {
        $received = $reader.ReadLine()
        $writer.WriteLine("ack:$received")
        $report.acceptedConnections++
      }
      finally {
        $reader.Dispose()
        $writer.Dispose()
      }
    }
    finally {
      $server.Dispose()
    }
  }

  [IO.File]::WriteAllText(
    $ReportFile,
    ($report | ConvertTo-Json -Depth 8),
    [Text.UTF8Encoding]::new($false)
  )
  exit 0
}

$client = [System.IO.Pipes.NamedPipeClientStream]::new(
  ".",
  $PipeName,
  [System.IO.Pipes.PipeDirection]::InOut,
  [System.IO.Pipes.PipeOptions]::None
)
try {
  $client.Connect(10000)
  $reader = [IO.StreamReader]::new(
    $client,
    [Text.UTF8Encoding]::new($false),
    $false,
    1024,
    $true
  )
  $writer = [IO.StreamWriter]::new(
    $client,
    [Text.UTF8Encoding]::new($false),
    1024,
    $true
  )
  $writer.AutoFlush = $true
  try {
    $writer.WriteLine($Message)
    $response = $reader.ReadLine()
    [ordered]@{
      connected = $client.IsConnected
      response = $response
    } | ConvertTo-Json -Compress
  }
  finally {
    $reader.Dispose()
    $writer.Dispose()
  }
}
finally {
  $client.Dispose()
}
