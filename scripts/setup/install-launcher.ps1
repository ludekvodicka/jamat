[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('Install', 'Disable')][string]$Action,
    [Parameter(Mandatory = $true)][string]$Destination,
    [Parameter(Mandatory = $true)][string]$ExpectedUserSid,
    [Parameter(Mandatory = $true)][string]$ExpectedConfigIdentity,
    [Parameter(Mandatory = $true)][string]$ResultFile,
    [string]$ConfigFile,
    [string]$GatewayAddress,
    [switch]$Elevated
)
$ErrorActionPreference = 'Stop'
$script:problem = 'Windows could not configure the launcher.'
$script:taskName = 'JamatLauncher'
$script:taskPath = '\Jamat\'
# Older installers registered the task in this folder. Built from char codes so the public leak gate's owner token stays out of the source.
$script:legacyTaskPath = '\' + (-join [char[]](73, 110, 118, 101, 110, 116, 105, 99)) + '\'

function Fail-Setup([string]$Message) {
    $script:problem = $Message
    throw $Message
}

function Full-Path([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path) -or $Path -match '["\x00\r\n]' -or -not [IO.Path]::IsPathRooted($Path)) {
        Fail-Setup 'Windows setup received an invalid path.'
    }
    return [IO.Path]::GetFullPath($Path).TrimEnd('\')
}

function Assert-PlainDirectory([string]$Path) {
    $cursor = $Path
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                Fail-Setup 'The launcher installation directory contains an unsupported link or file.'
            }
        }
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
}

function Write-Json([string]$Path, $Value) {
    $temporary = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 12), (New-Object Text.UTF8Encoding($false)))
        if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($temporary, $Path, [NullString]::Value) }
        else { [IO.File]::Move($temporary, $Path) }
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

function Hash-Text([string]$Value) {
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value)))).Replace('-', '').ToLowerInvariant() }
    finally { $hash.Dispose() }
}

function Read-Task([string]$Path) {
    return Get-ScheduledTask -TaskName $script:taskName -TaskPath $Path -ErrorAction SilentlyContinue
}

function Task-Fingerprint([string]$Path) {
    return Hash-Text (Export-ScheduledTask -TaskName $script:taskName -TaskPath $Path)
}

function Task-Path($Metadata) {
    if ($Metadata) { return $Metadata.task.path }
    return $script:taskPath
}

function Assert-Task($Metadata, [string]$Fingerprint) {
    $path = Task-Path $Metadata
    $task = Read-Task $path
    if ($task -and (-not $Metadata -or -not $Fingerprint -or (Task-Fingerprint $path) -cne $Fingerprint)) {
        Fail-Setup 'The JamatLauncher scheduled task was created or changed elsewhere. It has been preserved.'
    }
    return $task
}

function Rule-Fingerprint($Rule) {
    $values = [ordered]@{}
    foreach ($part in @($Rule,
        (Get-NetFirewallApplicationFilter -AssociatedNetFirewallRule $Rule),
        (Get-NetFirewallAddressFilter -AssociatedNetFirewallRule $Rule),
        (Get-NetFirewallPortFilter -AssociatedNetFirewallRule $Rule),
        (Get-NetFirewallServiceFilter -AssociatedNetFirewallRule $Rule),
        (Get-NetFirewallInterfaceFilter -AssociatedNetFirewallRule $Rule),
        (Get-NetFirewallInterfaceTypeFilter -AssociatedNetFirewallRule $Rule),
        (Get-NetFirewallSecurityFilter -AssociatedNetFirewallRule $Rule))) {
        $properties = [ordered]@{}
        foreach ($property in ($part.CimInstanceProperties | Sort-Object Name)) {
            if ($property.Name -notin @('Status', 'StatusCode', 'PrimaryStatus', 'EnforcementStatus')) {
                $properties[$property.Name] = $property.Value
            }
        }
        $values[$part.CimClass.CimClassName] = $properties
    }
    return Hash-Text ($values | ConvertTo-Json -Depth 12 -Compress)
}

function Assert-Rule($Metadata, [string]$Fingerprint) {
    if (-not $Metadata) { return $null }
    $rule = Get-NetFirewallRule -Name $Metadata.firewall.name -ErrorAction SilentlyContinue
    if ($rule -and (-not $Fingerprint -or (Rule-Fingerprint $rule) -cne $Fingerprint)) {
        Fail-Setup 'The launcher firewall rule was changed elsewhere. It has been preserved.'
    }
    return $rule
}

function Launcher-Command($Runtime) {
    return '"' + $Runtime.nodePath + '" "' + $Runtime.entryPath + '" "' + $Runtime.configFile + '"'
}

function Read-Installation([string]$Directory) {
    $file = Join-Path $Directory 'installation.json'
    if (-not (Test-Path -LiteralPath $file)) { return $null }
    $metadata = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
    $release = Full-Path $metadata.runtime.directory
    if ($metadata.schemaVersion -ne 1 -or $metadata.enabled -isnot [bool] -or
        $metadata.ownerSid -cne $ExpectedUserSid -or $metadata.ownerId -notmatch '^[a-f0-9]{32}$' -or
        [IO.Path]::GetDirectoryName($release) -ine (Join-Path $Directory 'releases') -or
        [IO.Path]::GetFileName($release) -notmatch '^[a-f0-9]{32}$' -or
        $metadata.task.name -cne $script:taskName -or $metadata.task.path -cnotin @($script:taskPath, $script:legacyTaskPath) -or
        $metadata.task.fingerprint -notmatch '^[a-f0-9]{64}$' -or
        $metadata.firewall.name -cne ('JamatLauncher-' + $metadata.ownerId) -or
        $metadata.firewall.fingerprint -notmatch '^[a-f0-9]{64}$' -or
        $metadata.runtime.nodePath -ine (Join-Path $release 'node.exe') -or
        $metadata.runtime.entryPath -ine (Join-Path $release 'launcher.cjs') -or
        $metadata.runtime.configFile -ine (Join-Path $release 'config.json') -or
        $metadata.runtime.vbsPath -ine (Join-Path $release 'start.vbs') -or
        $metadata.runtime.commandLine -cne (Launcher-Command $metadata.runtime) -or
        $metadata.firewall.program -ine $metadata.runtime.nodePath) {
        Fail-Setup 'Stored launcher ownership could not be verified. Existing setup has been preserved.'
    }
    Assert-PlainDirectory $release
    return $metadata
}

function Owned-Processes($Metadata) {
    foreach ($candidate in (Get-CimInstance Win32_Process -Filter "Name = 'node.exe'")) {
        if ($candidate.ExecutablePath -ieq $Metadata.runtime.nodePath -and
            $candidate.CommandLine -ceq $Metadata.runtime.commandLine) {
            $owner = Invoke-CimMethod -InputObject $candidate -MethodName GetOwnerSid
            if ($owner.ReturnValue -ne 0 -or $owner.Sid -cne $Metadata.ownerSid) {
                Fail-Setup 'The launcher process belongs to another Windows account. It has been preserved.'
            }
            $candidate
        }
    }
}

function Send-Maintenance($Metadata, [ValidateSet('pause', 'resume')][string]$Operation) {
    $config = Get-Content -LiteralPath $Metadata.runtime.configFile -Raw | ConvertFrom-Json
    if ($config.key -notmatch '^[a-fA-F0-9]{64}$') { Fail-Setup 'The installed launcher configuration could not be verified.' }
    $key = New-Object byte[] 32
    for ($i = 0; $i -lt 32; $i++) { $key[$i] = [Convert]::ToByte($config.key.Substring($i * 2, 2), 16) }
    $timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString()
    $nonce = [Guid]::NewGuid().ToString('N')
    $path = '/api/' + $Operation
    $hmac = New-Object Security.Cryptography.HMACSHA256
    $hmac.Key = $key
    try { $signature = ([BitConverter]::ToString($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes("POST`n$path`n$timestamp`n$nonce")))).Replace('-', '').ToLowerInvariant() }
    finally { $hmac.Dispose() }
    $request = [Net.HttpWebRequest]::Create([Uri]::new([Uri]$config.publicUrl, $path))
    $request.Method = 'POST'
    $request.ContentLength = 0
    $request.Proxy = $null
    $request.AllowAutoRedirect = $false
    $request.Timeout = 3000
    $request.ReadWriteTimeout = 3000
    $request.Headers['X-Jamat-Timestamp'] = $timestamp
    $request.Headers['X-Jamat-Nonce'] = $nonce
    $request.Headers['X-Jamat-Signature'] = $signature
    $response = $null
    try {
        try { $response = $request.GetResponse() }
        catch [Net.WebException] {
            if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 409) {
                $_.Exception.Response.Close()
                Fail-Setup 'Jamat is still starting; try again after it finishes.'
            }
            if ($_.Exception.Response) { $_.Exception.Response.Close() }
            Fail-Setup 'The running launcher could not prepare for setup. Existing processes have been preserved.'
        }
        if ([int]$response.StatusCode -ne 200) { Fail-Setup 'The running launcher refused setup.' }
        $reader = New-Object IO.StreamReader($response.GetResponseStream())
        try {
            $buffer = New-Object char[] 16385
            $length = $reader.ReadBlock($buffer, 0, $buffer.Length)
            if ($length -lt 1 -or $length -ge $buffer.Length) { Fail-Setup 'The running launcher returned an invalid response.' }
            $value = (-join $buffer[0..($length - 1)]) | ConvertFrom-Json
            if ($value.ok -ne $true) { Fail-Setup 'The running launcher refused setup.' }
        } finally { $reader.Dispose() }
    } finally { if ($response) { $response.Close() } }
}

function Stop-OwnedLauncher($Metadata, [ref]$Fingerprint, [ref]$Paused) {
    if (@(Owned-Processes $Metadata).Count -gt 0) {
        $Paused.Value = $true
        Send-Maintenance $Metadata 'pause'
    }
    $task = Assert-Task $Metadata $Fingerprint.Value
    if ($task) {
        Disable-ScheduledTask -TaskName $script:taskName -TaskPath $Metadata.task.path | Out-Null
        $Fingerprint.Value = Task-Fingerprint $Metadata.task.path
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    do {
        $processes = @(Owned-Processes $Metadata)
        if ($processes.Count -gt 0 -and -not $Paused.Value) {
            $Paused.Value = $true
            Send-Maintenance $Metadata 'pause'
        }
        foreach ($candidate in $processes) {
            $live = [Diagnostics.Process]::GetProcessById($candidate.ProcessId)
            try {
                # Keep an open handle so a recycled PID cannot become a different kill target.
                $null = $live.Handle
                if (-not $live.HasExited) {
                    if ($live.MainModule.FileName -ine $Metadata.runtime.nodePath -or
                        [Math]::Abs(($live.StartTime.ToUniversalTime() - $candidate.CreationDate.ToUniversalTime()).TotalMilliseconds) -gt 1) {
                        Fail-Setup 'The launcher process changed during setup. It has been preserved.'
                    }
                    $live.Kill()
                    if (-not $live.WaitForExit(5000)) { Fail-Setup 'The launcher did not stop. Try again after it finishes.' }
                }
            } finally { $live.Dispose() }
        }
        $task = Assert-Task $Metadata $Fingerprint.Value
        if (@(Owned-Processes $Metadata).Count -eq 0 -and (-not $task -or $task.State -notin @('Running', 'Queued'))) { return }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    Fail-Setup 'The launcher task did not stop. Existing Jamat sessions have been preserved.'
}

function New-OwnedRule($Metadata) {
    if (Get-NetFirewallRule -Name $Metadata.firewall.name -ErrorAction SilentlyContinue) {
        Fail-Setup 'A launcher firewall rule appeared during setup. It has been preserved.'
    }
    New-NetFirewallRule -Name $Metadata.firewall.name -DisplayName 'Jamat fixed-profile launcher' `
        -Description ('JamatLauncher owner ' + $Metadata.ownerId) -Direction Inbound -Action Allow `
        -Enabled True -Protocol TCP -LocalAddress $Metadata.firewall.localAddress `
        -LocalPort $Metadata.firewall.localPort -RemoteAddress $Metadata.firewall.remoteAddress `
        -Program $Metadata.firewall.program -Profile Any -EdgeTraversalPolicy Block | Out-Null
    $Metadata.firewall.fingerprint = Rule-Fingerprint (Get-NetFirewallRule -Name $Metadata.firewall.name)
}

function Wait-OwnedLauncher($Metadata) {
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    do {
        $task = Assert-Task $Metadata $Metadata.task.fingerprint
        if ($task -and $task.State -eq 'Running' -and @(Owned-Processes $Metadata).Count -eq 1) { return }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    Fail-Setup 'Windows registered the launcher but could not start its task.'
}

function Validate-Config([string]$Node, [string]$Entry, [string]$File) {
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $Node
    $info.Arguments = '"' + $Entry + '" --check "' + $File + '"'
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $child = [Diagnostics.Process]::Start($info)
    try {
        $stdout = $child.StandardOutput.ReadToEndAsync()
        $stderr = $child.StandardError.ReadToEndAsync()
        if (-not $child.WaitForExit(15000)) {
            $child.Kill()
            $child.WaitForExit()
            Fail-Setup 'Launcher configuration validation timed out.'
        }
        $null = $stdout.GetAwaiter().GetResult()
        $null = $stderr.GetAwaiter().GetResult()
        if ($child.ExitCode -ne 0) { Fail-Setup 'The selected Jamat profile or launcher configuration is invalid.' }
    } finally { $child.Dispose() }
}

function Prepare-Release([string]$Directory, $Previous) {
    if (-not $ConfigFile -or -not $GatewayAddress) { Fail-Setup 'The launcher configuration and gateway are required.' }
    $gateway = $null
    if (-not [Net.IPAddress]::TryParse($GatewayAddress, [ref]$gateway) -or
        $gateway.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) {
        Fail-Setup 'The launcher gateway must be an IPv4 address.'
    }
    $config = Get-Content -LiteralPath (Full-Path $ConfigFile) -Raw | ConvertFrom-Json
    if ($config.configIdentity -cne $ExpectedConfigIdentity) { Fail-Setup 'The launcher configuration belongs to a different Jamat profile.' }
    $required = @('node.exe', 'launcher.cjs', 'package.json', 'install-launcher.ps1', 'README.md', 'LICENSE', 'NODE-LICENSE.txt', 'WS-LICENSE.txt')
    foreach ($name in $required) {
        if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $name) -PathType Leaf)) {
            Fail-Setup 'The bundled launcher is incomplete. Reinstall or rebuild Jamat before enabling it.'
        }
    }
    Validate-Config (Join-Path $PSScriptRoot 'node.exe') (Join-Path $PSScriptRoot 'launcher.cjs') (Full-Path $ConfigFile)
    $release = Join-Path (Join-Path $Directory 'releases') ([Guid]::NewGuid().ToString('N'))
    Assert-PlainDirectory $release
    New-Item -ItemType Directory -Path $release | Out-Null
    foreach ($name in $required) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $release $name) }
    $runtime = [pscustomobject]@{
        directory = $release; nodePath = Join-Path $release 'node.exe'; entryPath = Join-Path $release 'launcher.cjs'
        configFile = Join-Path $release 'config.json'; vbsPath = Join-Path $release 'start.vbs'; commandLine = ''
    }
    $runtime.commandLine = Launcher-Command $runtime
    Write-Json $runtime.configFile $config
    [IO.File]::WriteAllLines($runtime.vbsPath, @('Set shell = CreateObject("WScript.Shell")',
        ('exitCode = shell.Run("' + $runtime.commandLine.Replace('"', '""') + '", 0, True)'),
        'WScript.Quit exitCode'), [Text.Encoding]::Unicode)
    $owner = if ($Previous) { $Previous.ownerId } else { [Guid]::NewGuid().ToString('N') }
    $url = [Uri]$config.publicUrl
    return [pscustomobject]@{
        schemaVersion = 1; enabled = $true; configDir = $config.configDir; configIdentity = $config.configIdentity
        runtimeChannel = $config.runtimeChannel; ownerSid = $ExpectedUserSid; ownerId = $owner; gatewayAddress = $GatewayAddress
        task = [pscustomobject]@{ name = $script:taskName; path = $script:taskPath; fingerprint = '' }
        firewall = [pscustomobject]@{ name = 'JamatLauncher-' + $owner; fingerprint = ''; localAddress = $url.Host
            localPort = $url.Port; remoteAddress = $GatewayAddress; program = $runtime.nodePath }
        runtime = $runtime
    }
}

function Register-OwnedTask($Metadata) {
    if (Read-Task $Metadata.task.path) { Fail-Setup 'A JamatLauncher task appeared during setup. It has been preserved.' }
    $taskAction = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\wscript.exe') `
        -Argument ('"' + $Metadata.runtime.vbsPath + '"') -WorkingDirectory $Metadata.runtime.directory
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $ExpectedUserSid
    $principal = New-ScheduledTaskPrincipal -UserId $ExpectedUserSid -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $script:taskName -TaskPath $Metadata.task.path -Action $taskAction -Trigger $trigger `
        -Principal $principal -Settings $settings -Description ('JamatLauncher owner ' + $Metadata.ownerId) | Out-Null
    $Metadata.task.fingerprint = Task-Fingerprint $Metadata.task.path
}

function Invoke-SetupTransaction([string]$Directory) {
    $metadataFile = Join-Path $Directory 'installation.json'
    $previous = Read-Installation $Directory
    if ($Action -eq 'Disable' -and $previous -and $previous.configIdentity -cne $ExpectedConfigIdentity) {
        Fail-Setup 'The launcher belongs to another profile. Open that Jamat to disable it.'
    }
    $taskFingerprint = if ($previous) { $previous.task.fingerprint } else { '' }
    $previousTask = Assert-Task $previous $taskFingerprint
    $previousRule = Assert-Rule $previous $(if ($previous) { $previous.firewall.fingerprint } else { '' })
    $previousTaskPath = Task-Path $previous
    $taskXml = if ($previousTask) { Export-ScheduledTask -TaskName $script:taskName -TaskPath $previousTaskPath } else { $null }
    $wasRunning = $previous -and (@(Owned-Processes $previous).Count -gt 0 -or ($previousTask -and $previousTask.State -in @('Running', 'Queued')))
    if ($Action -eq 'Disable' -and -not $previous) { return }
    $next = if ($Action -eq 'Install') { Prepare-Release $Directory $previous } else { $null }
    $paused = $false
    $removedTask = $false
    $removedRule = $false
    $newTask = $false
    $newRule = $false
    $metadataChanged = $false
    $committed = $false
    try {
        if ($previous) { Stop-OwnedLauncher $previous ([ref]$taskFingerprint) ([ref]$paused) }
        if (Assert-Task $previous $taskFingerprint) {
            Unregister-ScheduledTask -TaskName $script:taskName -TaskPath $previousTaskPath -Confirm:$false
            $removedTask = $true
        }
        if (Assert-Rule $previous $(if ($previous) { $previous.firewall.fingerprint } else { '' })) {
            Remove-NetFirewallRule -Name $previous.firewall.name
            $removedRule = $true
        }
        if ($Action -eq 'Install') {
            New-OwnedRule $next
            $newRule = $true
            Register-OwnedTask $next
            $newTask = $true
            Write-Json $metadataFile $next
            $metadataChanged = $true
            $installedConfig = Get-Content -LiteralPath $next.runtime.configFile -Raw | ConvertFrom-Json
            Write-Json (Join-Path $Directory 'pairing.json') @{
                publicUrl = $installedConfig.publicUrl; key = $installedConfig.key; gatewayAddress = $next.gatewayAddress
            }
            $committed = $true
            $null = Assert-Task $next $next.task.fingerprint
            Start-ScheduledTask -TaskName $script:taskName -TaskPath $next.task.path
            Wait-OwnedLauncher $next
        } elseif ($Action -eq 'Disable') {
            $disabled = $previous | ConvertTo-Json -Depth 12 | ConvertFrom-Json
            $disabled.enabled = $false
            Write-Json $metadataFile $disabled
        } else { Fail-Setup 'Unknown launcher setup action.' }
    } catch {
        if ($committed) {
            Fail-Setup 'Windows installed the launcher but could not confirm that it is running. Retry enabling it in Jamat Settings.'
        }
        $failure = $script:problem
        $restored = $true
        try {
            if ($newTask) {
                $newFingerprint = $next.task.fingerprint
                $newPaused = $false
                Stop-OwnedLauncher $next ([ref]$newFingerprint) ([ref]$newPaused)
                if (Assert-Task $next $newFingerprint) {
                    Unregister-ScheduledTask -TaskName $script:taskName -TaskPath $next.task.path -Confirm:$false
                }
            }
            if ($newRule -and (Assert-Rule $next $next.firewall.fingerprint)) { Remove-NetFirewallRule -Name $next.firewall.name }
            if ($removedRule -and $previousRule) { New-OwnedRule $previous }
            $taskChanged = $previous -and $taskFingerprint -cne $previous.task.fingerprint
            if ($taskXml -and ($removedTask -or $taskChanged)) {
                if ($removedTask -and (Read-Task $previousTaskPath)) { Fail-Setup 'A changed scheduled task prevented restoring the previous setup.' }
                if (-not $removedTask) { $null = Assert-Task $previous $taskFingerprint }
                Register-ScheduledTask -TaskName $script:taskName -TaskPath $previousTaskPath -Xml $taskXml -Force | Out-Null
                $previous.task.fingerprint = Task-Fingerprint $previousTaskPath
                if ($wasRunning -and @(Owned-Processes $previous).Count -eq 0) {
                    Start-ScheduledTask -TaskName $script:taskName -TaskPath $previousTaskPath
                    Wait-OwnedLauncher $previous
                }
            }
            if ($previous -and ($metadataChanged -or $removedRule -or $taskChanged)) { Write-Json $metadataFile $previous }
            elseif ($metadataChanged) { Remove-Item -LiteralPath $metadataFile -Force }
        } catch { $restored = $false }
        finally {
            if ($previous -and $paused -and @(Owned-Processes $previous).Count -gt 0) {
                try { Send-Maintenance $previous 'resume' } catch { $restored = $false }
            }
        }
        if (-not $restored) { Fail-Setup 'Windows setup failed and the previous launcher could not be fully restored. Review its Windows task before retrying.' }
        Fail-Setup $failure
    }
}

function Invoke-LauncherSetup {
    $lock = $null
    $exitCode = 1
    try {
        $directory = Full-Path $Destination
        $resultPath = Full-Path $ResultFile
        if ($directory.TrimEnd('\') -eq [IO.Path]::GetPathRoot($directory).TrimEnd('\')) {
            Fail-Setup 'The launcher destination must be an application directory.'
        }
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        if ($ExpectedUserSid -notmatch '^S-1-[0-9-]+$' -or $identity.User.Value -cne $ExpectedUserSid) {
            Fail-Setup 'Approve Windows setup using the same Windows account as Jamat.'
        }
        $principal = New-Object Security.Principal.WindowsPrincipal($identity)
        if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
            if ($Elevated) { Fail-Setup 'Windows administrator approval was not granted.' }
            $arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath,
                '-Action', $Action, '-Destination', $directory, '-ExpectedUserSid', $ExpectedUserSid,
                '-ExpectedConfigIdentity', $ExpectedConfigIdentity, '-ResultFile', $resultPath, '-Elevated')
            if ($ConfigFile) { $arguments += @('-ConfigFile', (Full-Path $ConfigFile)) }
            if ($GatewayAddress) { $arguments += @('-GatewayAddress', $GatewayAddress) }
            foreach ($argument in $arguments) {
                if ($argument -match '["\x00\r\n]') { Fail-Setup 'Windows setup received an invalid argument.' }
            }
            try {
                $child = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') `
                    -ArgumentList (($arguments | ForEach-Object { '"' + $_ + '"' }) -join ' ') -Verb RunAs -WindowStyle Hidden -PassThru
                try { $child.WaitForExit(); $exitCode = $child.ExitCode }
                finally { $child.Dispose() }
            } catch { Fail-Setup 'Windows administrator approval was cancelled or could not be completed.' }
            if (-not (Test-Path -LiteralPath $resultPath)) { Fail-Setup 'Windows setup did not return a result.' }
        } else {
            Assert-PlainDirectory $directory
            New-Item -ItemType Directory -Path $directory -Force | Out-Null
            try { $lock = [IO.File]::Open((Join-Path $directory 'setup.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
            catch { Fail-Setup 'Another launcher setup operation is still running. Try again after it finishes.' }
            Invoke-SetupTransaction $directory
            Write-Json $resultPath @{ ok = $true; problem = $null }
            $exitCode = 0
        }
    } catch {
        try { Write-Json (Full-Path $ResultFile) @{ ok = $false; problem = $script:problem } } catch { }
    } finally { if ($lock) { $lock.Dispose() } }
    exit $exitCode
}

if ($MyInvocation.InvocationName -ne '.') { Invoke-LauncherSetup }
