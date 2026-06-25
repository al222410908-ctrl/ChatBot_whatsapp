$targetKeyword = "session-sesion-doctor"
$dashboardKeyword = "dashboard.js"
$currentPid = $PID

Write-Host "Buscando procesos huerfanos..."

$processes = Get-CimInstance Win32_Process | Where-Object { 
    $_.Name -eq "node.exe" -or $_.Name -like "*chrome*" -or $_.Name -like "*chromium*" 
}

$count = 0
foreach ($p in $processes) {
    if ($p.ProcessId -eq $currentPid) { continue }
    
    $cmd = $p.CommandLine
    if ([string]::IsNullOrEmpty($cmd)) { continue }

    $isDashboardNode = $cmd.Contains($dashboardKeyword) -and -not $cmd.Contains("kill-orphans") -and -not $cmd.Contains("node -e")
    $isSessionChrome = $cmd.Contains($targetKeyword) -and ($p.Name -like "*chrome*" -or $p.Name -like "*chromium*")

    if ($isDashboardNode -or $isSessionChrome) {
        $pName = $p.Name
        $procId = $p.ProcessId
        $truncateLen = 80
        if ($cmd.Length -lt 80) { $truncateLen = $cmd.Length }
        $cmdTrunc = $cmd.Substring(0, $truncateLen)

        Write-Host "Matando proceso PID $procId : $pName"
        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
        $count++
    }
}

Write-Host "Proceso de limpieza finalizado. Se eliminaron $count procesos."
