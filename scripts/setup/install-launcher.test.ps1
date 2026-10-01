$ErrorActionPreference = 'Stop'
$root = Join-Path ([IO.Path]::GetTempPath()) ('jamat installer test ' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
try {
    . (Join-Path $PSScriptRoot 'install-launcher.ps1') -Action Install -Destination $root `
        -ExpectedUserSid 'S-1-5-21-111-222-333-1001' -ExpectedConfigIdentity 'test-profile' -ResultFile (Join-Path $root 'result.json')
    $writeJson = (Get-Item Function:Write-Json).ScriptBlock
    $script:testRoot = $root
    $script:events = New-Object 'Collections.Generic.List[string]'
    $script:task = $null
    $script:rule = $null
    $script:next = $null
    $script:failRegistration = $false
    $script:failStart = $false
    $script:failMetadata = $false
    $script:busy = $false
    $script:fakeLive = $false
    $script:losePauseResponse = $false
    $script:pauseApplied = $false

    function Assert([bool]$Condition, [string]$Message) {
        if (-not $Condition) { throw $Message }
    }
    function Rejects([scriptblock]$Call, [string]$Pattern) {
        $caught = $null
        try { & $Call } catch { $caught = $_.Exception.Message }
        Assert ($caught -and $caught -match $Pattern) ('Expected refusal: ' + $Pattern)
    }
    function Fixture {
        $release = Join-Path (Join-Path $script:testRoot 'releases') ([Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $release -Force | Out-Null
        $runtime = [pscustomobject]@{
            directory = $release; nodePath = Join-Path $release 'node.exe'; entryPath = Join-Path $release 'launcher.cjs'
            configFile = Join-Path $release 'config.json'; vbsPath = Join-Path $release 'start.vbs'; commandLine = ''
        }
        $runtime.commandLine = Launcher-Command $runtime
        & $writeJson $runtime.configFile @{ publicUrl = 'http://192.0.2.1:3511'; key = ('ab' * 32) }
        $owner = 'a' * 32
        return [pscustomobject]@{
            schemaVersion = 1; enabled = $true; configDir = Join-Path $script:testRoot 'profile'; configIdentity = 'test-profile'
            runtimeChannel = 'development'; ownerSid = $ExpectedUserSid; ownerId = $owner; gatewayAddress = '192.0.2.2'
            runtime = $runtime
            task = [pscustomobject]@{ name = 'JamatLauncher'; path = '\Inventic\'; fingerprint = Hash-Text $release }
            firewall = [pscustomobject]@{ name = 'JamatLauncher-' + $owner; fingerprint = Hash-Text $runtime.nodePath
                localAddress = '192.0.2.1'; localPort = 3511; remoteAddress = '192.0.2.2'; program = $runtime.nodePath }
        }
    }
    function Read-Task { return $script:task }
    function Task-Fingerprint { return Hash-Text $script:task.Xml }
    function Get-NetFirewallRule { return $script:rule }
    function Rule-Fingerprint($Rule) { return Hash-Text $Rule.Program }
    function Export-ScheduledTask { return $script:task.Xml }
    function Owned-Processes($Metadata) {
        if ($script:fakeLive) { return [pscustomobject]@{ ProcessId = -991 } }
    }
    function Send-Maintenance($Metadata, [string]$Operation) {
        $script:events.Add($Operation)
        if ($script:busy -and $Operation -eq 'pause') { Fail-Setup 'Jamat is still starting; try again after it finishes.' }
        $script:pauseApplied = $Operation -eq 'pause'
        if ($script:losePauseResponse -and $Operation -eq 'pause') {
            $script:losePauseResponse = $false
            throw 'fixture lost pause response'
        }
    }
    function Disable-ScheduledTask {
        $script:events.Add('disable-task')
        $script:task.Xml = 'disabled:' + $script:task.Xml
        $script:task.State = 'Disabled'
    }
    function Unregister-ScheduledTask {
        $script:events.Add('remove-task')
        $script:task = $null
    }
    function Remove-NetFirewallRule {
        $script:events.Add('remove-rule')
        $script:rule = $null
    }
    function New-OwnedRule($Metadata) {
        Assert (-not $script:rule) 'Must not overwrite a firewall rule'
        $script:events.Add('create-rule')
        $script:rule = [pscustomobject]@{ Program = $Metadata.firewall.program }
        $Metadata.firewall.fingerprint = Rule-Fingerprint $script:rule
    }
    function Register-OwnedTask($Metadata) {
        if ($script:failRegistration) { throw 'fixture-sensitive-failure' }
        Assert (-not $script:task) 'Must not overwrite a scheduled task'
        $script:events.Add('create-task')
        $script:task = [pscustomobject]@{ Xml = $Metadata.runtime.directory; State = 'Ready' }
        $Metadata.task.fingerprint = Task-Fingerprint
    }
    function Register-ScheduledTask {
        param([string]$Xml, [string]$TaskName, [string]$TaskPath, [switch]$Force)
        $script:events.Add('restore-task')
        $script:task = [pscustomobject]@{ Xml = $Xml; State = 'Ready' }
    }
    function Start-ScheduledTask {
        $script:events.Add('start-task')
        $stored = Get-Content -LiteralPath (Join-Path $script:testRoot 'installation.json') -Raw | ConvertFrom-Json
        Assert ($stored.runtime.directory -ceq $script:task.Xml) 'Starting must follow metadata commit'
        Assert (Test-Path -LiteralPath (Join-Path $script:testRoot 'pairing.json')) 'Starting must follow pairing commit'
        if ($script:failStart) { throw 'fixture-sensitive-failure' }
        $script:task.State = 'Running'
    }
    function Wait-OwnedLauncher($Metadata) { Assert ($script:task.State -eq 'Running') 'Must prove task startup' }
    function Prepare-Release($Directory, $Previous) { return $script:next }
    function Write-Json([string]$Path, $Value) {
        if ($script:failMetadata -and $Path -eq (Join-Path $script:testRoot 'installation.json')) {
            $script:failMetadata = $false
            throw 'fixture-sensitive-failure'
        }
        & $writeJson $Path $Value
    }
    function Seed($Metadata) {
        $script:task = [pscustomobject]@{ Xml = $Metadata.runtime.directory; State = 'Ready' }
        $script:rule = [pscustomobject]@{ Program = $Metadata.firewall.program }
        & $writeJson (Join-Path $script:testRoot 'installation.json') $Metadata
        $script:events.Clear()
        $script:problem = 'Windows could not configure the launcher.'
    }

    $script:next = Fixture
    Invoke-SetupTransaction $root
    $installed = Read-Installation $root
    Assert ($installed.runtime.directory -ceq $script:next.runtime.directory) 'Install selects immutable release'
    Assert ($script:task.State -eq 'Running') 'Install starts task'
    $pairing = [IO.File]::ReadAllText((Join-Path $root 'pairing.json'))
    Write-Output 'PASS install commits metadata and pairing before task startup'

    $Action = 'Disable'
    $script:task.State = 'Ready'
    Invoke-SetupTransaction $root
    Invoke-SetupTransaction $root
    Assert (-not $script:task -and -not $script:rule) 'Disable removes owned task and rule'
    Assert (-not (Read-Installation $root).enabled) 'Disable records disabled state'
    Assert ([IO.File]::ReadAllText((Join-Path $root 'pairing.json')) -ceq $pairing) 'Disable preserves pairing'
    Write-Output 'PASS repeated disable preserves pairing'

    $Action = 'Install'
    $previous = Fixture
    Seed $previous
    $script:next = Fixture
    $script:failRegistration = $true
    Rejects { Invoke-SetupTransaction $root } '^Windows could not configure'
    $script:failRegistration = $false
    Assert ($script:task.Xml -ceq $previous.runtime.directory) 'Failed new task restores old task'
    Assert ($script:rule.Program -ceq $previous.runtime.nodePath) 'Failed new task restores old firewall'
    Assert ((Read-Installation $root).runtime.directory -ceq $previous.runtime.directory) 'Failed new task preserves metadata'
    Write-Output 'PASS task registration failure rolls back rule and task'

    Seed $previous
    $script:next = Fixture
    $script:failMetadata = $true
    Rejects { Invoke-SetupTransaction $root } '^Windows could not configure'
    Assert ($script:task.Xml -ceq $previous.runtime.directory) 'Metadata failure restores old task'
    Assert ($script:rule.Program -ceq $previous.runtime.nodePath) 'Metadata failure restores old firewall'
    Assert (-not $script:events.Contains('start-task')) 'Metadata failure must never start new runtime'
    Write-Output 'PASS metadata failure rolls back without starting new runtime'

    Seed $previous
    $script:task.Xml = 'foreign-task'
    Rejects { Invoke-SetupTransaction $root } 'scheduled task was created or changed elsewhere'
    Assert ($script:events.Count -eq 0) 'Foreign task must prevent all writes'
    Assert ($script:task.Xml -eq 'foreign-task') 'Foreign task must remain unchanged'
    Seed $previous
    $script:rule.Program = 'foreign-program'
    Rejects { Invoke-SetupTransaction $root } 'firewall rule was changed elsewhere'
    Assert ($script:events.Count -eq 0) 'Foreign rule must prevent all writes'
    Write-Output 'PASS foreign task and firewall are preserved'

    Seed $previous
    $script:fakeLive = $true
    $script:busy = $true
    Rejects { Invoke-SetupTransaction $root } 'Jamat is still starting'
    Assert (($script:events -join ',') -eq 'pause,resume') 'Busy startup must not disable or replace anything'
    $script:busy = $false
    $script:losePauseResponse = $true
    $script:events.Clear()
    $script:problem = 'Windows could not configure the launcher.'
    Rejects { Invoke-SetupTransaction $root } '^Windows could not configure'
    Assert (($script:events -join ',') -eq 'pause,resume') 'Lost pause response must still resume the launcher'
    Assert (-not $script:pauseApplied) 'A lost response must not leave the launcher paused'
    Assert ($script:task.Xml -ceq $previous.runtime.directory) 'Lost pause response preserves the original task'
    Write-Output 'PASS lost pause response still resumes unchanged launcher'
    $script:events.Clear()
    $script:problem = 'Windows could not configure the launcher.'
    Rejects { Invoke-SetupTransaction $root } '^Windows could not configure'
    Assert ($script:events.Contains('resume')) 'Failed stop resumes paused old launcher'
    Assert ($script:task.Xml -ceq $previous.runtime.directory) 'Failed stop restores old task settings'
    $script:fakeLive = $false
    Write-Output 'PASS busy startup refuses changes and failed stop resumes old launcher'

    Seed $previous
    $script:next = Fixture
    $script:failStart = $true
    Rejects { Invoke-SetupTransaction $root } '^Windows installed the launcher'
    Assert ((Read-Installation $root).runtime.directory -ceq $script:next.runtime.directory) 'Failed start retains committed installation'
    Assert ($script:task.Xml -ceq $script:next.runtime.directory) 'Failed start must not roll back task'
    Assert ($script:rule.Program -ceq $script:next.runtime.nodePath) 'Failed start must not roll back firewall'
    Assert (-not $script:events.Contains('restore-task')) 'Post-commit failure must not roll back'
    Write-Output 'PASS post-commit start failure keeps consistent installed state'
} catch {
    $Error | Select-Object -First 5 | ForEach-Object { Write-Output $_.Exception.Message }
    throw
} finally {
    if ([IO.Path]::GetDirectoryName($root).TrimEnd('\') -ine [IO.Path]::GetTempPath().TrimEnd('\')) { throw 'Unsafe test cleanup path' }
    Remove-Item -LiteralPath $root -Recurse -Force
}
