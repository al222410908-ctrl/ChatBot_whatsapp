# Sistema de Citas Medicas - Script de inicio
# Ejecutar con: .\iniciar.ps1

$Host.UI.RawUI.WindowTitle = "Sistema Citas Medicas"

Clear-Host
Write-Host ""
Write-Host "  ================================================" -ForegroundColor Cyan
Write-Host "    SISTEMA DE CITAS MEDICAS                     " -ForegroundColor Cyan
Write-Host "    Gestion y Recordatorios WhatsApp             " -ForegroundColor Cyan
Write-Host "  ================================================" -ForegroundColor Cyan
Write-Host ""

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

# -- 1. Verificar Node.js --
Write-Host "  Verificando Node.js..." -ForegroundColor Gray
try {
    $nodeVersion = node --version 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Node no encontrado" }
    Write-Host "  [OK] Node.js $nodeVersion encontrado" -ForegroundColor Green
} catch {
    Write-Host ""
    Write-Host "  [ERROR] Node.js no esta instalado." -ForegroundColor Red
    Write-Host ""
    Write-Host "  Por favor instala Node.js desde:" -ForegroundColor Yellow
    Write-Host "  https://nodejs.org/es/ (version LTS recomendada)" -ForegroundColor White
    Write-Host ""
    Read-Host "  Presiona Enter para salir"
    exit 1
}

# -- 2. Instalar dependencias si es necesario --
if (-not (Test-Path "node_modules")) {
    Write-Host ""
    Write-Host "  Instalando dependencias (primera vez, puede tardar unos minutos)..." -ForegroundColor Yellow
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "  [ERROR] Error al instalar dependencias." -ForegroundColor Red
        Write-Host "  Asegurate de tener conexion a internet e intenta de nuevo." -ForegroundColor Yellow
        Read-Host "  Presiona Enter para salir"
        exit 1
    }
    Write-Host "  [OK] Dependencias instaladas correctamente" -ForegroundColor Green
}

# -- 3. Leer PIN del archivo .env.local --
$pinInfo = "1234 (por defecto)"
$envPath = Join-Path $scriptDir ".env.local"
if (Test-Path $envPath) {
    $envContent = Get-Content $envPath -Raw
    if ($envContent -match "DASHBOARD_PIN=(\S+)") {
        $pinInfo = $Matches[1]
    }
} else {
    $envPath2 = Join-Path $scriptDir ".env"
    if (Test-Path $envPath2) {
        $envContent2 = Get-Content $envPath2 -Raw
        if ($envContent2 -match "DASHBOARD_PIN=(\S+)") {
            $pinInfo = $Matches[1]
        }
    }
}

# -- 4. Iniciar servidor en ventana separada --
Write-Host ""
Write-Host "  Iniciando servidor..." -ForegroundColor Yellow

$serverCmd = "Set-Location '$scriptDir'; `$Host.UI.RawUI.WindowTitle = 'Servidor - Citas Medicas'; Write-Host 'Servidor iniciado en http://localhost:3001' -ForegroundColor Green; Write-Host 'Presiona Ctrl+C para detener.' -ForegroundColor Yellow; node dashboard.js"
Start-Process powershell -ArgumentList "-NoExit", "-Command", $serverCmd

Start-Sleep -Seconds 4

# -- 5. Abrir navegador --
Write-Host "  Abriendo el panel en el navegador..." -ForegroundColor Yellow
Start-Process "http://localhost:3001/dashboard"

# -- 6. Mostrar informacion de acceso --
Write-Host ""
Write-Host "  ================================================" -ForegroundColor Green
Write-Host "    SISTEMA INICIADO CORRECTAMENTE               " -ForegroundColor Green
Write-Host "  ================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  ACCESO AL SISTEMA:" -ForegroundColor White
Write-Host "    Dashboard : http://localhost:3001/dashboard" -ForegroundColor Cyan
Write-Host "    Citas     : http://localhost:3001/citas" -ForegroundColor Cyan
Write-Host "    Pacientes : http://localhost:3001/pacientes" -ForegroundColor Cyan
Write-Host "    Mensajes  : http://localhost:3001/mensajes" -ForegroundColor Cyan
Write-Host "    Analytics : http://localhost:3001/analytics" -ForegroundColor Cyan
Write-Host ""
Write-Host ("  PIN DE ACCESO : " + $pinInfo) -ForegroundColor Yellow
Write-Host ""
Write-Host "  PROXIMOS PASOS:" -ForegroundColor White
Write-Host "    1. Ingresa el PIN en el navegador" -ForegroundColor Gray
Write-Host "    2. Escanea el codigo QR de WhatsApp en el panel lateral" -ForegroundColor Gray
Write-Host "    3. Registra tus pacientes y citas" -ForegroundColor Gray
Write-Host "    4. El sistema enviara recordatorios automaticamente!" -ForegroundColor Gray
Write-Host ""
Write-Host "  NOTA: Anti-spam activo - mensajes se envian entre 8AM y 9PM" -ForegroundColor DarkYellow
Write-Host ""
Write-Host "  ================================================" -ForegroundColor DarkGray
Read-Host "  Presiona Enter para cerrar esta ventana"
