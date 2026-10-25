param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-p]{32}$')]
    [string]$ExtensionId
)

$ErrorActionPreference = 'Stop'
$HostName = 'com.ahmadoteng.discord_direct'
$RegistryKeyPath = "Software\Google\Chrome\NativeMessagingHosts\$HostName"
$Registry = [Microsoft.Win32.Registry]::CurrentUser
$Key = $Registry.OpenSubKey($RegistryKeyPath)
if ($Key) {
    try {
        $ManifestPath = [string]$Key.GetValue('')
    } finally {
        $Key.Dispose()
    }
    if ($ManifestPath -and (Test-Path -LiteralPath $ManifestPath)) {
        $Manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
        if ($Manifest.allowed_origins -contains "chrome-extension://$ExtensionId/") {
            $Registry.DeleteSubKeyTree($RegistryKeyPath, $false)
            Write-Host "Unregistered $HostName for extension $ExtensionId."
        } else {
            throw 'The registered host is assigned to a different extension ID; no registry entry was removed.'
        }
    } else {
        throw 'The registered host manifest is missing; no registry entry was removed.'
    }
} else {
    Write-Host "$HostName is not registered for this Windows user."
}

Write-Host 'The installer does not register a Windows service, Run key, scheduled task, or startup entry.'
