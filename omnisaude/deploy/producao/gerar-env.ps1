# Gera o .env com senhas aleatórias a partir do .env.example (Windows PowerShell 5.1 ou PowerShell 7).
# Uso, nesta pasta:  powershell -ExecutionPolicy Bypass -File .\gerar-env.ps1
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (Test-Path .env) {
  throw 'O .env já existe. Não gere de novo depois que os bancos foram criados: as senhas deixariam de conferir.'
}
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
function Random-Bytes([int]$n) { $b = New-Object byte[] $n; $rng.GetBytes($b); return ,$b }
function Hex([int]$n) { -join ((Random-Bytes $n) | ForEach-Object { $_.ToString('x2') }) }

$senhas = 'MASTER_DB_PASSWORD', 'POSTGRES_SUPERUSER_PASSWORD', 'APP_DB_PASSWORD', 'ADMIN_DB_PASSWORD', 'BI_DB_PASSWORD', 'REPLICATION_PASSWORD', 'JWT_SECRET', 'PLATFORM_ADMIN_PASSWORD'
$linhas = foreach ($l in Get-Content -Encoding UTF8 .env.example) {
  $nome = ($l -split '=', 2)[0]
  if ($senhas -contains $nome -and $l -eq "$nome=") { "$nome=$(Hex 24)" }
  elseif ($l -eq 'DATA_KEY=') { 'DATA_KEY=' + [Convert]::ToBase64String((Random-Bytes 32)) }
  else { $l }
}
# UTF-8 sem BOM e quebras de linha LF, como o Docker Compose espera.
[IO.File]::WriteAllText((Join-Path $PSScriptRoot '.env'), (($linhas -join "`n") + "`n"), (New-Object Text.UTF8Encoding $false))
Write-Host '.env criado com senhas novas. Guarde uma cópia em local seguro (cofre de senhas).'
