$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$out = Join-Path $root "tunnel.out"
$err = Join-Path $root "tunnel.err"

Remove-Item -LiteralPath $out, $err -ErrorAction SilentlyContinue

Start-Process `
  -FilePath "npx.cmd" `
  -ArgumentList @("--yes", "localtunnel", "--port", "4173") `
  -WorkingDirectory $root `
  -RedirectStandardOutput $out `
  -RedirectStandardError $err
