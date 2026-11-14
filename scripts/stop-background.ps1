# Зупиняє лише фоновий сервер, який було запущено для початкової демонстрації.
# Час запуску захищає від зупинки іншого процесу з повторно використаним PID.
$ErrorActionPreference = 'Stop'
$recordPath = Join-Path $PSScriptRoot '..\data\server-process.json'
if (-not (Test-Path -LiteralPath $recordPath)) {
    Write-Host 'No background server record. For start.cmd use Ctrl+C.'
    exit 0
}
$record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
$hotelProcess = Get-Process -Id $record.id -ErrorAction SilentlyContinue
if (-not $hotelProcess) {
    Write-Host 'Background server is already stopped.'
    exit 0
}
if ($hotelProcess.ProcessName -ne 'node' -or $hotelProcess.StartTime.ToUniversalTime().Ticks.ToString() -ne $record.startedTicks) {
    Write-Host 'Process identity changed. No process was stopped.'
    exit 1
}
Stop-Process -Id $hotelProcess.Id
Write-Host 'Background hotel server stopped. Use start.cmd to start it again.'
