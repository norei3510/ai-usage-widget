# Creates one dedicated Codex login for AI Usage. Never prints the token.
# Run by the user only; -CheckOnly validates preparation without login or writes.
[CmdletBinding()]
param([switch]$CheckOnly)

$ErrorActionPreference = 'Stop'
$widgetCli = Get-Command codex.exe, codex.cmd -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
if (-not $widgetCli) {
    throw 'Codex CLIが見つかりません。SETUP.mdのWindows手順1で導入し、PowerShellを開き直してください。'
}

$widgetAuthDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ('ai-usage-widget-auth-' + [Guid]::NewGuid().ToString('N'))
$widgetLoginInfo = [System.Diagnostics.ProcessStartInfo]::new()
$widgetLoginInfo.UseShellExecute = $false
$widgetLoginInfo.WorkingDirectory = $widgetAuthDirectory
# Only the child receives CODEX_HOME. Do not change the caller's normal login.
$widgetLoginInfo.EnvironmentVariables['CODEX_HOME'] = $widgetAuthDirectory
if ($widgetCli.Source.EndsWith('.cmd', [StringComparison]::OrdinalIgnoreCase)) {
    $widgetLoginInfo.FileName = $env:ComSpec
    $widgetLoginInfo.Arguments = '/d /s /c ""' + $widgetCli.Source + '" -c "cli_auth_credentials_store=''file''" login"'
} else {
    $widgetLoginInfo.FileName = $widgetCli.Source
    $widgetLoginInfo.Arguments = '-c "cli_auth_credentials_store=''file''" login'
}

if ($CheckOnly) {
    Write-Output 'Preparation OK: dedicated child environment and file-backed credentials. No login, file creation, or clipboard change.'
    return
}

New-Item -ItemType Directory -Path $widgetAuthDirectory | Out-Null
Write-Host 'ブラウザーで、残量を見たいChatGPTアカウントにログインしてください。'
$widgetLoginProcess = [System.Diagnostics.Process]::Start($widgetLoginInfo)
$widgetLoginProcess.WaitForExit()
if ($widgetLoginProcess.ExitCode -ne 0) {
    throw '専用ログインに失敗しました。上のCLI表示を確認してください。通常のCodex認証は変更していません。'
}

$widgetCredentialFile = Join-Path $widgetAuthDirectory 'auth.json'
if (-not (Test-Path -LiteralPath $widgetCredentialFile)) {
    throw '専用auth.jsonが作成されませんでした。組織の認証ポリシーとCLIのログイン結果を確認してください。'
}
try {
    $widgetCredentials = Get-Content -LiteralPath $widgetCredentialFile -Raw | ConvertFrom-Json
} catch {
    # A JSON parser's native message can include input text. Never forward it.
    throw '専用auth.jsonを読み取れません。新しくログインし直してください。ファイル内容は共有しません。'
}
if ($widgetCredentials.tokens.refresh_token -isnot [string] -or
    [string]::IsNullOrWhiteSpace($widgetCredentials.tokens.refresh_token)) {
    throw 'refresh tokenがありません。APIキーではなく、ChatGPTアカウントでログインしてください。'
}
Set-Clipboard -Value $widgetCredentials.tokens.refresh_token
$widgetCredentials = $null
Write-Host 'refresh tokenをPCのクリップボードにコピーしました。画面には表示していません。'
Write-Host '自分のiPhoneへ安全に移し、AI Usageの「Codexを設定」から専用入力欄へ貼り付けてください。'
Write-Host 'この専用ログインをPCのCodexで通常使用しないでください。'
Read-Host 'iPhoneへの入力が終わったらEnter（PCのクリップボードを空にします）' | Out-Null
Set-Clipboard -Value ''
Write-Host 'PCのクリップボードを空にしました。iPhone側のクリップボードも消してください。'
Write-Host '専用認証ファイルはPCの一時フォルダーに残ります。auth.jsonはチャットやGitHubへ共有しません。'
