param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-p]{32}$')]
    [string]$ExtensionId,

    [string]$InstallRoot
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = Join-Path $env:LOCALAPPDATA "DiscordDirect\NativeHost\$ExtensionId"
}
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
$HostDirectory = Join-Path $InstallRoot 'host'
$HostName = 'com.ahmadoteng.discord_direct'
$AllowedOrigin = "chrome-extension://$ExtensionId/"
$RegistryKeyPath = "Software\Google\Chrome\NativeMessagingHosts\$HostName"

# Do not silently replace another extension's registration for this host name.
$ExistingKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($RegistryKeyPath)
if ($ExistingKey) {
    try {
        $ExistingManifestPath = [string]$ExistingKey.GetValue('')
    } finally {
        $ExistingKey.Dispose()
    }
    if (-not $ExistingManifestPath -or -not (Test-Path -LiteralPath $ExistingManifestPath)) {
        throw 'An existing Native Messaging registration has a missing manifest; no files or registry values were changed.'
    }
    try {
        $ExistingManifest = Get-Content -LiteralPath $ExistingManifestPath -Raw | ConvertFrom-Json
    } catch {
        throw 'An existing Native Messaging manifest is invalid; no files or registry values were changed.'
    }
    if ($ExistingManifest.name -ne $HostName -or
        $ExistingManifest.allowed_origins -notcontains $AllowedOrigin) {
        throw 'This Native Messaging host name is already assigned to a different extension ID; no files or registry values were changed.'
    }
}

$NodeCommand = Get-Command node.exe -ErrorAction Stop
$NodePath = [System.IO.Path]::GetFullPath($NodeCommand.Source)
$NodeVersionText = (& $NodePath --version | Out-String).Trim()
$NodeVersionMatch = [regex]::Match($NodeVersionText, '^v(?<major>\d+)\.')
if ($LASTEXITCODE -ne 0 -or -not $NodeVersionMatch.Success) {
    throw 'Node.js could not be started. Install Node.js 20 or newer and retry.'
}
$NodeMajor = [int]$NodeVersionMatch.Groups['major'].Value
if ($NodeMajor -lt 20) {
    throw "Node.js 20 or newer is required; found $NodeVersionText."
}

if (-not (Get-Command dotnet.exe -ErrorAction SilentlyContinue)) {
    throw 'The installer needs the .NET 8 SDK to build the small Windows Native Messaging launcher.'
}
$SdkVersions = (& dotnet.exe --list-sdks | Out-String)
$HasSupportedSdk = $false
foreach ($SdkLine in ($SdkVersions -split '\r?\n')) {
    $SdkMatch = [regex]::Match($SdkLine, '^(?<major>\d+)\.')
    if ($SdkMatch.Success -and [int]$SdkMatch.Groups['major'].Value -ge 8) {
        $HasSupportedSdk = $true
        break
    }
}
if ($LASTEXITCODE -ne 0 -or -not $HasSupportedSdk) {
    throw 'The .NET 8 SDK or newer is required to build the Native Messaging launcher.'
}

$ExtensionRoot = Split-Path -Parent $PSScriptRoot
$ProjectFile = Join-Path $PSScriptRoot 'launcher\DiscordDirectNativeHost.csproj'
New-Item -ItemType Directory -Path $HostDirectory -Force | Out-Null

& dotnet.exe publish $ProjectFile --configuration Release --runtime win-x64 --self-contained true `
    -p:PublishSingleFile=true -p:EnableCompressionInSingleFile=true --output $HostDirectory
if ($LASTEXITCODE -ne 0) {
    throw 'Building the Windows Native Messaging launcher failed.'
}

Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'host.cjs') -Destination $HostDirectory -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'node-sockets.cjs') -Destination $HostDirectory -Force
New-Item -ItemType Directory -Path (Join-Path $HostDirectory 'src') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $HostDirectory 'lib') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $ExtensionRoot 'src\turn-server.js') `
    -Destination (Join-Path $HostDirectory 'src\turn-server.js') -Force
Copy-Item -LiteralPath (Join-Path $ExtensionRoot 'lib\turn-codec.js') `
    -Destination (Join-Path $HostDirectory 'lib\turn-codec.js') -Force
Copy-Item -LiteralPath (Join-Path $ExtensionRoot 'lib\mapping-policy.js') `
    -Destination (Join-Path $HostDirectory 'lib\mapping-policy.js') -Force

$Settings = [ordered]@{
    allowedOrigin = $AllowedOrigin
    nodeExecutable = $NodePath
}
$SettingsJson = ConvertTo-Json -InputObject $Settings -Depth 4
[System.IO.File]::WriteAllText(
    (Join-Path $HostDirectory 'host-settings.json'),
    $SettingsJson,
    [System.Text.UTF8Encoding]::new($false)
)

$NativeManifestPath = Join-Path $InstallRoot "$HostName.json"
$NativeManifest = [ordered]@{
    name = $HostName
    description = 'On-demand local UDP TURN helper for Discord Direct'
    path = (Join-Path $HostDirectory 'DiscordDirectNativeHost.exe')
    type = 'stdio'
    allowed_origins = @($AllowedOrigin)
}
$NativeManifestJson = ConvertTo-Json -InputObject $NativeManifest -Depth 5
[System.IO.File]::WriteAllText(
    $NativeManifestPath,
    $NativeManifestJson,
    [System.Text.UTF8Encoding]::new($false)
)

$RegistryKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($RegistryKeyPath)
try {
    $RegistryKey.SetValue('', $NativeManifestPath, [Microsoft.Win32.RegistryValueKind]::String)
} finally {
    $RegistryKey.Dispose()
}

Write-Host "Registered $HostName for extension $ExtensionId."
Write-Host "Native helper files: $HostDirectory"
Write-Host 'The helper is not installed as a service or startup task. Chrome launches it only while the extension has an active Native Messaging connection.'
