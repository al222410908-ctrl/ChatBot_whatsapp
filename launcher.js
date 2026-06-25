#!/usr/bin/env node
// ============================================================
// launcher.js — Lanzador del Sistema de Citas Médicas
// Ejecuta todo el sistema con un solo doble clic
// ============================================================
'use strict';

const { spawn, execSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Helper para encontrar el ejecutable de Node.js del sistema (evitando secuestros de pkg)
function findNodePath() {
  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of pathDirs) {
    if (!dir) continue;
    const cleanDir = dir.replace(/"/g, '').trim();
    const fullPath = path.join(cleanDir, 'node.exe');
    if (fs.existsSync(fullPath)) {
      return fullPath;
    }
  }
  const commonPaths = [
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Program Files (x86)\\nodejs\\node.exe',
    path.join(os.homedir(), 'AppData\\Roaming\\npm\\node.exe'),
    path.join(os.homedir(), 'AppData\\Local\\Microsoft\\WindowsApps\\node.exe')
  ];
  for (const cp of commonPaths) {
    if (fs.existsSync(cp)) {
      return cp;
    }
  }
  return null;
}

// ── Colores ANSI para la consola ─────────────────────────────
const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  magenta: '\x1b[35m',
  cyan:    '\x1b[36m',
  red:     '\x1b[31m',
  white:   '\x1b[37m',
  bgBlue:  '\x1b[44m',
  bgGreen: '\x1b[42m',
};

// ── Directorio del proyecto ──────────────────────────────────
// Si se ejecuta como .exe compilado con pkg, __dirname apunta al snapshot.
// Usamos el directorio donde se encuentra el .exe real.
const PROJECT_DIR = process.pkg
  ? path.dirname(process.execPath)
  : __dirname;

const DASHBOARD_SCRIPT = path.join(PROJECT_DIR, 'dashboard.js');
const NODE_MODULES     = path.join(PROJECT_DIR, 'node_modules');
const PACKAGE_JSON     = path.join(PROJECT_DIR, 'package.json');

let serverProcess = null;
let isShuttingDown = false;

// ── Utilidades de consola ────────────────────────────────────
function log(icon, msg, color = C.white) {
  console.log(`  ${color}${icon}${C.reset} ${msg}`);
}

function logOK(msg)   { log('[✓]', msg, C.green); }
function logWarn(msg)  { log('[!]', msg, C.yellow); }
function logErr(msg)   { log('[✗]', msg, C.red); }
function logInfo(msg)  { log('[·]', msg, C.cyan); }
function logStep(msg)  { log('[→]', msg, C.blue); }

function separator() {
  console.log(`  ${C.dim}${'─'.repeat(50)}${C.reset}`);
}

// ── Splash Screen ────────────────────────────────────────────
function showSplash() {
  console.clear();
  console.log('');
  console.log(`  ${C.cyan}${C.bold}╔══════════════════════════════════════════════════╗${C.reset}`);
  console.log(`  ${C.cyan}${C.bold}║                                                  ║${C.reset}`);
  console.log(`  ${C.cyan}${C.bold}║${C.reset}   ${C.white}${C.bold}🏥  SISTEMA DE CITAS MÉDICAS${C.reset}                  ${C.cyan}${C.bold}║${C.reset}`);
  console.log(`  ${C.cyan}${C.bold}║${C.reset}   ${C.dim}Gestión y Recordatorios WhatsApp${C.reset}              ${C.cyan}${C.bold}║${C.reset}`);
  console.log(`  ${C.cyan}${C.bold}║                                                  ║${C.reset}`);
  console.log(`  ${C.cyan}${C.bold}╚══════════════════════════════════════════════════╝${C.reset}`);
  console.log('');
}

// ── Cambiar título de la ventana de consola ──────────────────
function setWindowTitle(title) {
  if (process.platform === 'win32') {
    process.stdout.write(`\x1b]0;${title}\x07`);
  }
}

// ── 1. Limpieza de procesos huérfanos ────────────────────────
function killOrphans() {
  logStep('Limpiando procesos anteriores...');
  const sessionName = 'sesion-doctor';
  const targetKeyword = `session-${sessionName}`;
  const dashboardKeyword = 'dashboard.js';
  const currentPid = process.pid;

  try {
    const cmdList = 'wmic process where "name=\'node.exe\' or name=\'chrome.exe\' or name=\'msedge.exe\'" get commandline,processid';
    const output = execSync(cmdList, { timeout: 15000 }).toString();
    const lines = output.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    
    if (lines.length <= 1) {
      logOK('No hay procesos previos');
      return;
    }

    let killedNode = 0;
    let killedChrome = 0;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const match = line.match(/(\d+)$/);
      if (!match) continue;
      const pid = parseInt(match[1]);
      const cmd = line.substring(0, line.length - match[1].length).trim();

      if (pid === currentPid) continue;

      const isDashboardNode = cmd.includes(dashboardKeyword) && !cmd.includes('launcher') && !cmd.includes('build-exe');
      const isSessionChrome = cmd.includes(targetKeyword) && (cmd.includes('chrome') || cmd.includes('msedge') || cmd.includes('puppeteer'));

      if (isDashboardNode) {
        try {
          execSync(`taskkill /f /pid ${pid}`, { stdio: 'ignore' });
          killedNode++;
        } catch (e) { /* ignorar */ }
      } else if (isSessionChrome) {
        try {
          execSync(`taskkill /f /pid ${pid}`, { stdio: 'ignore' });
          killedChrome++;
        } catch (e) { /* ignorar */ }
      }
    }

    if (killedNode > 0 || killedChrome > 0) {
      logOK(`Cerrado(s) ${killedNode} servidor(es) y ${killedChrome} navegador(es) huérfano(s)`);
    } else {
      logOK('No hay procesos previos activos');
    }
  } catch (err) {
    logWarn('No se pudieron verificar procesos previos (no crítico)');
  }
}

// ── 2. Verificar Node.js ─────────────────────────────────────
function checkNode() {
  logStep('Verificando Node.js...');
  const nodePath = findNodePath();
  
  if (nodePath) {
    try {
      const result = spawnSync(nodePath, ['--version'], { timeout: 5000 });
      if (result.status === 0) {
        const version = result.stdout.toString().trim();
        logOK(`Node.js ${version} detectado (${nodePath})`);
        return version;
      }
    } catch (e) { /* fall through */ }
  }

  // Fallback a llamar 'node' directamente usando spawnSync sin shell
  try {
    const result = spawnSync('node', ['--version'], { timeout: 5000 });
    if (result.status === 0) {
      const version = result.stdout.toString().trim();
      logOK(`Node.js ${version} detectado`);
      return version;
    }
  } catch (e) { /* fall through */ }

  logErr('Node.js no está instalado.');
  console.log('');
  logWarn('Instala Node.js desde: https://nodejs.org/es/');
  logWarn('Descarga la versión LTS recomendada.');
  console.log('');
  waitForEnter('Presiona Enter para salir...');
  process.exit(1);
}

// ── 3. Instalar dependencias ─────────────────────────────────
function installDependencies() {
  if (fs.existsSync(NODE_MODULES) && fs.existsSync(PACKAGE_JSON)) {
    logOK('Dependencias OK');
    return;
  }

  logStep('Instalando dependencias (primera vez, puede tardar)...');
  console.log('');

  try {
    const result = execSync('npm install', {
      cwd: PROJECT_DIR,
      stdio: 'inherit',
      timeout: 300000, // 5 min máximo
    });
    console.log('');
    logOK('Dependencias instaladas correctamente');
  } catch (e) {
    console.log('');
    logErr('Error al instalar dependencias.');
    logWarn('Verifica tu conexión a internet e intenta de nuevo.');
    waitForEnter('Presiona Enter para salir...');
    process.exit(1);
  }
}

// ── 4. Leer PIN de acceso ────────────────────────────────────
function readPin() {
  const envFiles = ['.env.local', '.env'];
  for (const file of envFiles) {
    const filePath = path.join(PROJECT_DIR, file);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const match = content.match(/DASHBOARD_PIN=(\S+)/);
      if (match) return match[1];
    }
  }
  return '1234';
}

// ── 5. Leer Puerto ───────────────────────────────────────────
function readPort() {
  const envFiles = ['.env.local', '.env'];
  for (const file of envFiles) {
    const filePath = path.join(PROJECT_DIR, file);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const match = content.match(/PORT=(\d+)/);
      if (match) return parseInt(match[1]);
    }
  }
  return 3001;
}

// ── 6. Arrancar el servidor ──────────────────────────────────
function startServer(port) {
  return new Promise((resolve, reject) => {
    logStep('Iniciando servidor...');

    const nodeExe = findNodePath() || 'node';
    serverProcess = spawn(nodeExe, ['dashboard.js'], {
      cwd: PROJECT_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '1' },
      windowsHide: false,
    });

    let resolved = false;

    // Timeout de 30 segundos para arranque
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        logWarn('El servidor tardó más de lo esperado, pero puede seguir cargando...');
        resolve();
      }
    }, 30000);

    serverProcess.stdout.on('data', (data) => {
      const text = data.toString();
      
      // Detectar que el servidor arrancó
      if (!resolved && (
        text.includes('Servidor iniciado') ||
        text.includes('listening') ||
        text.includes(':' + port) ||
        text.includes('localhost')
      )) {
        resolved = true;
        clearTimeout(timeout);
        logOK(`Servidor iniciado en puerto ${port}`);
        resolve();
      }

      // Mostrar logs del servidor en la consola (con prefijo)
      const lines = text.split('\n').filter(l => l.trim());
      for (const line of lines) {
        console.log(`  ${C.dim}│ ${line.trim()}${C.reset}`);
      }
    });

    serverProcess.stderr.on('data', (data) => {
      const text = data.toString().trim();
      if (text) {
        // Filtrar warnings no críticos de Node.js
        if (text.includes('ExperimentalWarning') || text.includes('DEP0')) return;
        console.log(`  ${C.dim}│ ${C.yellow}${text}${C.reset}`);
      }
    });

    serverProcess.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(err);
      }
    });

    serverProcess.on('exit', (code) => {
      if (!isShuttingDown) {
        console.log('');
        logErr(`El servidor se detuvo inesperadamente (código: ${code})`);
        waitForEnter('Presiona Enter para salir...');
        process.exit(1);
      }
    });
  });
}

// ── 7. Abrir navegador ───────────────────────────────────────
function openBrowser(url) {
  logStep('Abriendo navegador...');
  try {
    if (process.platform === 'win32') {
      execSync(`start "" "${url}"`, { stdio: 'ignore', shell: true });
    } else if (process.platform === 'darwin') {
      execSync(`open "${url}"`, { stdio: 'ignore' });
    } else {
      execSync(`xdg-open "${url}"`, { stdio: 'ignore' });
    }
    logOK('Navegador abierto');
  } catch (e) {
    logWarn(`No se pudo abrir el navegador. Abre manualmente: ${url}`);
  }
}

// ── 8. Panel de estado final ─────────────────────────────────
function showStatus(port, pin) {
  console.log('');
  console.log(`  ${C.green}${C.bold}╔══════════════════════════════════════════════════╗${C.reset}`);
  console.log(`  ${C.green}${C.bold}║    ✅  SISTEMA INICIADO CORRECTAMENTE            ║${C.reset}`);
  console.log(`  ${C.green}${C.bold}╚══════════════════════════════════════════════════╝${C.reset}`);
  console.log('');
  console.log(`  ${C.white}${C.bold}ACCESO AL SISTEMA:${C.reset}`);
  console.log(`    ${C.cyan}Dashboard  ${C.reset}→  ${C.white}http://localhost:${port}/dashboard${C.reset}`);
  console.log(`    ${C.cyan}Citas      ${C.reset}→  ${C.white}http://localhost:${port}/citas${C.reset}`);
  console.log(`    ${C.cyan}Pacientes  ${C.reset}→  ${C.white}http://localhost:${port}/pacientes${C.reset}`);
  console.log(`    ${C.cyan}Mensajes   ${C.reset}→  ${C.white}http://localhost:${port}/mensajes${C.reset}`);
  console.log(`    ${C.cyan}Chat Vivo  ${C.reset}→  ${C.white}http://localhost:${port}/chat${C.reset}`);
  console.log(`    ${C.cyan}Analytics  ${C.reset}→  ${C.white}http://localhost:${port}/analytics${C.reset}`);
  console.log('');
  console.log(`  ${C.yellow}${C.bold}🔑 PIN DE ACCESO: ${pin}${C.reset}`);
  console.log('');
  separator();
  console.log(`  ${C.dim}Anti-spam activo — mensajes entre 8:00 AM y 9:00 PM${C.reset}`);
  console.log(`  ${C.dim}Presiona ${C.white}Ctrl+C${C.dim} para apagar el sistema${C.reset}`);
  separator();
  console.log('');
}

// ── 9. Shutdown graceful ─────────────────────────────────────
function shutdown(exitCode = 0) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log('');
  separator();
  logStep('Apagando el sistema...');

  if (serverProcess && !serverProcess.killed) {
    // En Windows, necesitamos taskkill para matar el árbol de procesos
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /pid ${serverProcess.pid} /T /F`, { stdio: 'ignore' });
      } else {
        serverProcess.kill('SIGTERM');
      }
    } catch (e) { /* ignorar */ }
  }

  logOK('Servidor detenido');
  logOK('¡Hasta pronto! 👋');
  console.log('');
  
  // Dar tiempo para que se muestren los mensajes
  setTimeout(() => process.exit(exitCode), 500);
}

// ── Esperar Enter ────────────────────────────────────────────
function waitForEnter(msg) {
  console.log(`  ${C.dim}${msg}${C.reset}`);
  try {
    // En Windows, usar una pausa síncrona
    if (process.platform === 'win32') {
      execSync('pause', { stdio: 'inherit', shell: true });
    }
  } catch (e) { /* ignorar */ }
}

// ── Capturar señales de cierre ───────────────────────────────
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('SIGHUP', () => shutdown(0));

// En Windows, capturar el cierre de la ventana de consola
if (process.platform === 'win32') {
  process.on('SIGBREAK', () => shutdown(0));
}

// ── MAIN ─────────────────────────────────────────────────────
async function main() {
  setWindowTitle('🏥 Citas Médicas — Iniciando...');
  showSplash();
  separator();
  console.log('');

  // Paso 1: Limpiar procesos previos
  killOrphans();

  // Paso 2: Verificar Node.js
  checkNode();

  // Paso 3: Instalar dependencias si falta
  installDependencies();

  // Paso 4: Leer configuración
  const port = readPort();
  const pin = readPin();

  // Paso 5: Verificar que dashboard.js existe
  if (!fs.existsSync(DASHBOARD_SCRIPT)) {
    logErr(`No se encontró dashboard.js en: ${PROJECT_DIR}`);
    logWarn('Asegúrate de que el .exe esté en la carpeta del proyecto.');
    waitForEnter('Presiona Enter para salir...');
    process.exit(1);
  }

  // Paso 6: Arrancar servidor
  console.log('');
  separator();
  console.log('');
  
  try {
    await startServer(port);
  } catch (err) {
    logErr(`Error al iniciar el servidor: ${err.message}`);
    waitForEnter('Presiona Enter para salir...');
    process.exit(1);
  }

  // Paso 7: Esperar un momento y abrir navegador
  await new Promise(r => setTimeout(r, 1500));
  openBrowser(`http://localhost:${port}/dashboard`);

  // Paso 8: Mostrar estado
  setWindowTitle('🏥 Citas Médicas — En ejecución');
  showStatus(port, pin);
}

main().catch(err => {
  logErr(`Error fatal: ${err.message}`);
  waitForEnter('Presiona Enter para salir...');
  process.exit(1);
});
