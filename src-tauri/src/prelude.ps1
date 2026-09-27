# Helpers shared by every generated script. Runs in Windows PowerShell 5.1 as admin.
# Output protocol (one line each): run:<id>, done:<id>, fail:<id>:<message>,
# state:<id>:<0|1>, info:<text>, warn:<text>, log:<text>.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

function Set-Reg([string]$Path, [string]$Name, [string]$Type, $Value) {
    if (-not (Test-Path -LiteralPath $Path)) { New-Item -Path $Path -Force | Out-Null }
    New-ItemProperty -LiteralPath $Path -Name $Name -PropertyType $Type -Value $Value -Force | Out-Null
}

function Remove-Reg([string]$Path, [string]$Name) {
    Remove-ItemProperty -LiteralPath $Path -Name $Name -ErrorAction SilentlyContinue
}

# Original values are saved before a tweak first changes them, so Revert can restore
# exactly what was there. The Windows default from the tweak file is only a fallback.
$BackupRoot = 'HKLM:\SOFTWARE\WinOptimizer\Backup'

function Save-Original([string]$Slot, [string]$Value) {
    $key = "$BackupRoot\$script:TweakId"
    if (-not (Test-Path -LiteralPath $key)) { New-Item -Path $key -Force | Out-Null }
    if ($null -eq (Get-ItemProperty -LiteralPath $key -Name $Slot -ErrorAction SilentlyContinue)) {
        New-ItemProperty -LiteralPath $key -Name $Slot -PropertyType String -Value $Value -Force | Out-Null
    }
}

function Get-Original([string]$Slot) {
    $item = Get-ItemProperty -LiteralPath "$BackupRoot\$script:TweakId" -Name $Slot -ErrorAction SilentlyContinue
    if ($item) { return $item.$Slot }
}

function Set-TweakReg([string]$Path, [string]$Name, [string]$Type, $Value) {
    $key = Get-Item -LiteralPath $Path -ErrorAction SilentlyContinue
    $original = if ($key -and $null -ne $key.GetValue($Name)) {
        "$($key.GetValueKind($Name))|$($key.GetValue($Name, $null, 'DoNotExpandEnvironmentNames'))"
    } else { '-' }
    Save-Original "reg:$Path|$Name" $original
    Set-Reg $Path $Name $Type $Value
}

function Undo-TweakReg([string]$Path, [string]$Name, [string]$Type, $Default) {
    $original = Get-Original "reg:$Path|$Name"
    if ($original -eq '-') { Remove-Reg $Path $Name }
    elseif ($original) { $kind, $value = $original -split '\|', 2; Set-Reg $Path $Name $kind $value }
    elseif ($null -ne $Default) { Set-Reg $Path $Name $Type $Default }
    else { Remove-Reg $Path $Name }
}

function Test-Reg([string]$Path, [string]$Name, $Value) {
    $item = Get-ItemProperty -LiteralPath $Path -Name $Name -ErrorAction SilentlyContinue
    return ($null -ne $item) -and ("$($item.$Name)" -eq "$Value")
}

$StartModes = @{ Disabled = 'disabled'; Manual = 'demand'; Automatic = 'auto'; AutomaticDelayed = 'delayed-auto' }
$StartValues = @{ Disabled = 4; Manual = 3; Automatic = 2; AutomaticDelayed = 2 }

function Set-Svc([string]$Name, [string]$Startup) {
    if (-not (Get-Service -Name $Name -ErrorAction SilentlyContinue)) { return }
    $out = sc.exe config $Name start= $StartModes[$Startup]
    if ($LASTEXITCODE -ne 0) { throw "${Name}: $out" }
    if ($Startup -eq 'Disabled') { Stop-Service -Name $Name -Force -ErrorAction SilentlyContinue }
}

function Get-SvcStartup([string]$Name) {
    $key = Get-ItemProperty -LiteralPath "HKLM:\SYSTEM\CurrentControlSet\Services\$Name" -ErrorAction SilentlyContinue
    switch ($key.Start) {
        2 { if ($key.DelayedAutostart -eq 1) { 'AutomaticDelayed' } else { 'Automatic' } }
        3 { 'Manual' }
        4 { 'Disabled' }
    }
}

function Set-TweakSvc([string]$Name, [string]$Startup) {
    $original = Get-SvcStartup $Name
    if ($original) { Save-Original "svc:$Name" $original }
    Set-Svc $Name $Startup
}

function Undo-TweakSvc([string]$Name, [string]$Default) {
    $original = Get-Original "svc:$Name"
    Set-Svc $Name $(if ($original) { $original } else { $Default })
}

function Test-Svc([string]$Name, [string]$Startup) {
    $key = Get-ItemProperty -LiteralPath "HKLM:\SYSTEM\CurrentControlSet\Services\$Name" -ErrorAction SilentlyContinue
    if (-not $key) { return $true }
    return $key.Start -eq $StartValues[$Startup]
}

function Get-Task([string]$Path) {
    $folder = (Split-Path $Path -Parent).TrimEnd('\') + '\'
    Get-ScheduledTask -TaskPath $folder -TaskName (Split-Path $Path -Leaf) -ErrorAction SilentlyContinue
}

function Set-Task([string]$Path, [bool]$Enabled) {
    $task = Get-Task $Path
    if (-not $task) { return }
    if ($Enabled) { $task | Enable-ScheduledTask | Out-Null } else { $task | Disable-ScheduledTask | Out-Null }
}

function Set-TweakTask([string]$Path) {
    $task = Get-Task $Path
    if (-not $task) { return }
    Save-Original "task:$Path" ([string]$task.State)
    $task | Disable-ScheduledTask | Out-Null
}

function Undo-TweakTask([string]$Path) {
    if ((Get-Original "task:$Path") -ne 'Disabled') { Set-Task $Path $true }
}

function Test-Task([string]$Path) {
    $task = Get-Task $Path
    return (-not $task) -or ($task.State -eq 'Disabled')
}

function Remove-App([string]$Name) {
    $problems = @()
    Get-AppxPackage -AllUsers -Name $Name | Remove-AppxPackage -AllUsers -ErrorAction Continue -ErrorVariable +problems
    if ($null -eq $script:Provisioned) { $script:Provisioned = @(Get-AppxProvisionedPackage -Online) }
    $script:Provisioned | Where-Object DisplayName -like $Name |
        Remove-AppxProvisionedPackage -Online -AllUsers -ErrorAction Continue -ErrorVariable +problems | Out-Null
    if ($problems) { throw "${Name}: $($problems[0].Exception.Message)" }
}

function Test-App([string]$Name) {
    if ($null -eq $script:Installed) { $script:Installed = @(Get-AppxPackage -AllUsers | ForEach-Object Name) }
    return -not ($script:Installed -like $Name)
}

# DirectXUserGlobalSettings holds several "Name=Value;" pairs. Change one, keep the rest.
function Set-DirectXSetting([string]$Name, $Value) {
    $path = 'HKCU:\Software\Microsoft\DirectX\UserGpuPreferences'
    $current = (Get-ItemProperty -LiteralPath $path -ErrorAction SilentlyContinue).DirectXUserGlobalSettings
    $parts = @("$current" -split ';' | Where-Object { $_ -and $_ -notlike "$Name=*" })
    if ($null -ne $Value) { $parts += "$Name=$Value" }
    if ($parts.Count -eq 0) { Remove-Reg $path 'DirectXUserGlobalSettings'; return }
    Set-Reg $path 'DirectXUserGlobalSettings' String (($parts -join ';') + ';')
}

function Get-PowerScheme {
    return [regex]::Match((powercfg /getactivescheme), '[0-9a-fA-F-]{36}').Value
}

# Sets a power plan setting for both plugged in (AC) and battery (DC) on the active plan.
function Set-PowerSetting([string]$Group, [string]$Setting, [int]$Value) {
    powercfg /setacvalueindex scheme_current $Group $Setting $Value
    powercfg /setdcvalueindex scheme_current $Group $Setting $Value
    powercfg /setactive scheme_current
    if ($LASTEXITCODE) { throw "powercfg failed with exit code $LASTEXITCODE" }
}

function Test-PowerSetting([string]$Group, [string]$Setting, [int]$Value) {
    $path = "HKLM:\SYSTEM\CurrentControlSet\Control\Power\User\PowerSchemes\$(Get-PowerScheme)\$Group\$Setting"
    return (Test-Reg $path 'ACSettingIndex' $Value) -and (Test-Reg $path 'DCSettingIndex' $Value)
}

# Lists everything below a folder, children before parents. Never enters junctions or
# symlinks: a user could point one at a system folder and have us delete it as admin.
function Get-Tree([string]$Path) {
    foreach ($item in Get-ChildItem -LiteralPath $Path -Force -ErrorAction SilentlyContinue) {
        $isLink = [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
        if ($item.PSIsContainer -and -not $isLink) { Get-Tree $item.FullName }
        $item
    }
}

# Empties folders (keeps the folders themselves) and reports the space freed.
function Clear-Folder([string[]]$Path) {
    $freed = 0
    foreach ($folder in $Path | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Container) }) {
        foreach ($item in Get-Tree $folder) {
            try {
                # Directory.Delete is not recursive: it removes empty folders and links, never link targets.
                if ($item.PSIsContainer) { [IO.Directory]::Delete($item.FullName) }
                else {
                    $size = $item.Length
                    if (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { $item.Attributes = 'Normal' }
                    [IO.File]::Delete($item.FullName)
                    $freed += $size
                }
            } catch {}
        }
    }
    'Freed {0:N0} MB' -f ($freed / 1MB)
}

# Runs Disk Cleanup silently with the given handlers selected.
function Invoke-DiskCleanup([int]$Slot, [string[]]$Handlers) {
    $root = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\VolumeCaches'
    $flag = 'StateFlags{0:D4}' -f $Slot
    foreach ($h in $Handlers) {
        if (Test-Path -LiteralPath "$root\$h") { Set-Reg "$root\$h" $flag DWord 2 }
    }
    $free = (Get-PSDrive C).Free
    $process = Start-Process cleanmgr.exe "/sagerun:$Slot" -PassThru
    if (-not $process.WaitForExit(30 * 60 * 1000)) { $process.Kill(); throw 'Disk Cleanup did not finish within 30 minutes' }
    'Freed {0:N0} MB' -f (((Get-PSDrive C).Free - $free) / 1MB)
}

function Invoke-Tweak([string]$Id, [scriptblock]$Body, [switch]$Revert) {
    $script:TweakId = $Id
    Write-Output "run:$Id"
    try {
        & $Body | Out-String -Stream | Where-Object { $_.Trim() } | ForEach-Object { "log:$_" }
        if ($Revert) { Remove-Item -LiteralPath "$BackupRoot\$Id" -Recurse -Force -ErrorAction SilentlyContinue }
        Write-Output "done:$Id"
    } catch {
        $script:Failed = $true
        Write-Output "fail:${Id}:$($_.Exception.Message -replace '\s*\r?\n\s*', ' ')"
    }
}

function Test-Tweak([string]$Id, [scriptblock]$Test) {
    $ok = $false
    try { $ok = [bool](& $Test) } catch {}
    Write-Output ("state:{0}:{1}" -f $Id, [int]$ok)
}

function New-RestorePoint {
    Enable-ComputerRestore -Drive "$env:SystemDrive\"
    # Windows allows one restore point per 24 hours unless this is 0. Put it back afterwards.
    $path = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\SystemRestore'
    $name = 'SystemRestorePointCreationFrequency'
    $old = (Get-ItemProperty -LiteralPath $path -Name $name -ErrorAction SilentlyContinue).$name
    Set-Reg $path $name DWord 0
    try { Checkpoint-Computer -Description 'Win Optimizer' -RestorePointType MODIFY_SETTINGS }
    finally { if ($null -eq $old) { Remove-Reg $path $name } else { Set-Reg $path $name DWord $old } }
}

# Explorer reads most taskbar and folder settings only at start. Windows restarts it on its own.
function Restart-Explorer {
    $session = (Get-Process -Id $PID).SessionId
    $shell = { Get-Process explorer -ErrorAction SilentlyContinue | Where-Object SessionId -eq $session }
    if (-not (& $shell)) { return }
    & $shell | Stop-Process -Force -ErrorAction SilentlyContinue
    foreach ($i in 1..10) {
        Start-Sleep -Seconds 1
        if (& $shell) { return }
    }
    Start-Process explorer
}

function Write-SystemInfo {
    $os = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
    # ProductName still says "Windows 10" on Windows 11.
    $name = $os.ProductName
    if ([int]$os.CurrentBuild -ge 22000) { $name = $name -replace 'Windows 10', 'Windows 11' }
    $computer = Get-CimInstance Win32_ComputerSystem
    $ram = [math]::Round($computer.TotalPhysicalMemory / 1GB)
    Write-Output "info:$name $($os.DisplayVersion) · build $($os.CurrentBuild) · $ram GB RAM"

    # Elevating with a different admin account means per-user tweaks land in that account.
    $console = $computer.UserName
    $me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    if ($console -and $console -ne $me) {
        Write-Output "warn:Running as $me while $console is signed in. Personal settings (HKCU) change for $me only."
    }
}
