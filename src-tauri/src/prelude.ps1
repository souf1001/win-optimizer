# Helpers shared by every generated script. Runs in Windows PowerShell 5.1 as admin.
# Output protocol (one line each): run:<id>, done:<id>, fail:<id>:<message>,
# state:<id>:<0|1>, info:<text>, log:<text>.

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

function Test-Task([string]$Path) {
    $task = Get-Task $Path
    return (-not $task) -or ($task.State -eq 'Disabled')
}

function Remove-App([string]$Name) {
    Get-AppxPackage -AllUsers -Name $Name | Remove-AppxPackage -AllUsers -ErrorAction SilentlyContinue
    if ($null -eq $script:Provisioned) { $script:Provisioned = @(Get-AppxProvisionedPackage -Online) }
    $script:Provisioned | Where-Object DisplayName -like $Name |
        Remove-AppxProvisionedPackage -Online -AllUsers -ErrorAction SilentlyContinue | Out-Null
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
}

function Test-PowerSetting([string]$Group, [string]$Setting, [int]$Value) {
    $path = "HKLM:\SYSTEM\CurrentControlSet\Control\Power\User\PowerSchemes\$(Get-PowerScheme)\$Group\$Setting"
    return (Test-Reg $path 'ACSettingIndex' $Value) -and (Test-Reg $path 'DCSettingIndex' $Value)
}

function Get-FolderSize([string[]]$Path) {
    return [long](Get-ChildItem -Path $Path -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
}

# Empties folders (keeps the folders themselves) and reports the space freed.
function Clear-Folder([string[]]$Path) {
    $before = Get-FolderSize $Path
    Get-ChildItem -Path $Path -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    'Freed {0:N0} MB' -f (($before - (Get-FolderSize $Path)) / 1MB)
}

# Runs Disk Cleanup silently with the given handlers selected.
function Invoke-DiskCleanup([int]$Slot, [string[]]$Handlers) {
    $root = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\VolumeCaches'
    $flag = 'StateFlags{0:D4}' -f $Slot
    foreach ($h in $Handlers) {
        if (Test-Path -LiteralPath "$root\$h") { Set-Reg "$root\$h" $flag DWord 2 }
    }
    $free = (Get-PSDrive C).Free
    Start-Process cleanmgr.exe "/sagerun:$Slot" -Wait
    'Freed {0:N0} MB' -f (((Get-PSDrive C).Free - $free) / 1MB)
}

function Invoke-Tweak([string]$Id, [scriptblock]$Body) {
    Write-Output "run:$Id"
    try {
        & $Body | Out-String -Stream | Where-Object { $_.Trim() } | ForEach-Object { "log:$_" }
        Write-Output "done:$Id"
    } catch {
        Write-Output "fail:${Id}:$($_.Exception.Message)"
    }
}

function Test-Tweak([string]$Id, [scriptblock]$Test) {
    $ok = $false
    try { $ok = [bool](& $Test) } catch {}
    Write-Output ("state:{0}:{1}" -f $Id, [int]$ok)
}

function New-RestorePoint {
    Enable-ComputerRestore -Drive "$env:SystemDrive\"
    # Windows allows one restore point per 24 hours unless this is 0.
    Set-Reg 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\SystemRestore' 'SystemRestorePointCreationFrequency' DWord 0
    Checkpoint-Computer -Description 'Win Optimizer' -RestorePointType MODIFY_SETTINGS
}

function Restart-Explorer {
    Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    if (-not (Get-Process explorer -ErrorAction SilentlyContinue)) { Start-Process explorer }
}

function Write-SystemInfo {
    $os = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
    # ProductName still says "Windows 10" on Windows 11.
    $name = $os.ProductName
    if ([int]$os.CurrentBuild -ge 22000) { $name = $name -replace 'Windows 10', 'Windows 11' }
    $ram = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)
    Write-Output "info:$name $($os.DisplayVersion) · build $($os.CurrentBuild) · $ram GB RAM"
}
