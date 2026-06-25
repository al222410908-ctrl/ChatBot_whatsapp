@echo off
chcp 65001 >nul 2>&1
title 🏥 Sistema de Citas Médicas

:: ── Ir al directorio del script ──────────────────
cd /d "%~dp0"

:: ── Splash ───────────────────────────────────────
echo.
echo   ══════════════════════════════════════════════
echo     🏥  SISTEMA DE CITAS MÉDICAS
echo     Gestión y Recordatorios WhatsApp
echo   ══════════════════════════════════════════════
echo.

:: ── Verificar Node.js ────────────────────────────
echo   [·] Verificando Node.js...
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo   [✗] Node.js no está instalado.
    echo   [!] Descárgalo en: https://nodejs.org/es/
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do echo   [✓] Node.js %%v detectado

:: ── Instalar dependencias si no existen ──────────
if not exist "node_modules\" (
    echo.
    echo   [→] Instalando dependencias (primera vez)...
    call npm install
    if %errorlevel% neq 0 (
        echo.
        echo   [✗] Error al instalar dependencias.
        pause
        exit /b 1
    )
    echo   [✓] Dependencias instaladas
)

:: ── Leer PIN del .env.local ──────────────────────
set PIN=1234
if exist ".env.local" (
    for /f "tokens=1,2 delims==" %%a in (.env.local) do (
        if "%%a"=="DASHBOARD_PIN" set PIN=%%b
    )
)

:: ── Limpiar procesos previos ─────────────────────
echo   [→] Limpiando procesos previos...
for /f "tokens=2" %%p in ('tasklist /fi "imagename eq node.exe" /fo csv /nh 2^>nul ^| findstr /i "dashboard.js" 2^>nul') do (
    taskkill /f /pid %%~p >nul 2>&1
)
echo   [✓] Listo

:: ── Iniciar servidor ─────────────────────────────
echo.
echo   ──────────────────────────────────────────────
echo.
echo   [→] Iniciando servidor...

start "Servidor Citas Médicas" /min cmd /c "cd /d "%~dp0" && node dashboard.js"

:: ── Esperar a que el servidor arranque ───────────
timeout /t 5 /nobreak >nul

:: ── Abrir navegador ──────────────────────────────
echo   [→] Abriendo navegador...
start "" "http://localhost:3001/dashboard"
echo   [✓] Navegador abierto

:: ── Panel de estado ──────────────────────────────
echo.
echo   ══════════════════════════════════════════════
echo     ✅  SISTEMA INICIADO CORRECTAMENTE
echo   ══════════════════════════════════════════════
echo.
echo   ACCESO AL SISTEMA:
echo     Dashboard  → http://localhost:3001/dashboard
echo     Citas      → http://localhost:3001/citas
echo     Pacientes  → http://localhost:3001/pacientes
echo     Mensajes   → http://localhost:3001/mensajes
echo     Chat Vivo  → http://localhost:3001/chat
echo     Analytics  → http://localhost:3001/analytics
echo.
echo   🔑 PIN DE ACCESO: %PIN%
echo.
echo   ──────────────────────────────────────────────
echo   Anti-spam activo (mensajes entre 8AM y 9PM)
echo   Cierra esta ventana para apagar el sistema.
echo   ──────────────────────────────────────────────
echo.
pause
:: ── Al cerrar, matar el servidor ─────────────────
taskkill /fi "windowtitle eq Servidor Citas Médicas" /f >nul 2>&1
echo   [✓] Servidor detenido. ¡Hasta pronto!
timeout /t 2 /nobreak >nul
