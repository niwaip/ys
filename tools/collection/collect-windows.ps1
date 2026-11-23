# Read-only inventory. Run on the selected Windows target, then upload the JSON.
$ErrorActionPreference = 'Stop'
$os = Get-CimInstance Win32_OperatingSystem
$bios = Get-CimInstance Win32_BIOS
$software = $null
$softwareComplete = $false
$kbs = $null
$kbComplete = $false
try {
  $software = @(Get-ItemProperty 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction Stop | Where-Object DisplayName | ForEach-Object { @{Name=$_.DisplayName;Version=$_.DisplayVersion;Publisher=$_.Publisher} })
  $softwareComplete = $true
} catch { $software = $null }
try { $kbs = @(Get-HotFix | ForEach-Object { $_.HotFixID }) } catch { $kbs = $null }
$result = @{
  Hostname=$env:COMPUTERNAME; SerialNumber=$bios.SerialNumber; CollectorVersion='1'
  CollectedAt=[DateTime]::UtcNow.ToString('o'); OS=$os.Caption; OSVersion=$os.Version
  OSBuild=$os.BuildNumber; Architecture=$os.OSArchitecture
  KBInventoryComplete=$kbComplete; SoftwareInventoryComplete=$softwareComplete
  CollectionStatus=@{KBInventory="QFE only; not a complete patch inventory"}
}
if ($null -ne $software) { $result.InstalledSoftware = $software }
if ($null -ne $kbs) { $result.InstalledKBs = $kbs }
try { $ubr = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').UBR; if ($null -ne $ubr) { $result.UBR=$ubr; $result.FullBuild="$($os.BuildNumber).$ubr" } } catch {}
$result | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 'windows-collection.json'
Write-Host 'Saved windows-collection.json. Review the target identity before upload.'
