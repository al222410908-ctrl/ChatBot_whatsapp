#!/usr/bin/env node
// ============================================================
// build-exe.js — Compilar el lanzador a un .exe real
// Usa 'pkg' de Vercel para generar un ejecutable Windows
// ============================================================
'use strict';

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  red:    '\x1b[31m',
  white:  '\x1b[37m',
};

function log(icon, msg, color = C.white) {
  console.log(`  ${color}${icon}${C.reset} ${msg}`);
}

async function build() {
  console.log('');
  console.log(`  ${C.cyan}${C.bold}╔══════════════════════════════════════════════════╗${C.reset}`);
  console.log(`  ${C.cyan}${C.bold}║   🔨 Compilador — Citas Médicas .exe             ║${C.reset}`);
  console.log(`  ${C.cyan}${C.bold}╚══════════════════════════════════════════════════╝${C.reset}`);
  console.log('');

  const projectDir = __dirname;
  const outputName = 'Citas Medicas.exe';
  const outputPath = path.join(projectDir, outputName);
  const desktopPath = path.join(os.homedir(), 'OneDrive', 'Escritorio');
  const desktopAlt = path.join(os.homedir(), 'Desktop');

  // Paso 1: Verificar que pkg está instalado globalmente
  log('[→]', 'Verificando pkg...', C.cyan);
  try {
    execSync('npx --yes pkg --version', { stdio: 'pipe', timeout: 30000 });
    log('[✓]', 'pkg disponible', C.green);
  } catch (e) {
    log('[→]', 'Instalando pkg (primera vez)...', C.yellow);
    try {
      execSync('npm install -g pkg', { stdio: 'inherit', timeout: 120000 });
      log('[✓]', 'pkg instalado', C.green);
    } catch (e2) {
      log('[✗]', 'No se pudo instalar pkg. Intenta: npm install -g pkg', C.red);
      process.exit(1);
    }
  }

  // Paso 2: Compilar
  log('[→]', 'Compilando launcher.js → .exe (esto puede tardar 1-2 minutos)...', C.cyan);
  console.log('');

  try {
    const cmd = `npx --yes pkg launcher.js --target node18-win-x64 --output "${outputPath}" --compress GZip`;
    execSync(cmd, {
      cwd: projectDir,
      stdio: 'inherit',
      timeout: 300000, // 5 min max
    });
  } catch (e) {
    console.log('');
    log('[✗]', 'Error al compilar. Detalles arriba.', C.red);
    process.exit(1);
  }

  console.log('');

  // Verificar que se creó
  if (!fs.existsSync(outputPath)) {
    log('[✗]', 'El archivo .exe no se generó correctamente.', C.red);
    process.exit(1);
  }

  const sizeMB = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(1);
  log('[✓]', `Compilación exitosa: ${outputName} (${sizeMB} MB)`, C.green);

  // Paso 3: Crear acceso directo en el Escritorio
  let desktopTarget = null;
  if (fs.existsSync(desktopPath)) {
    desktopTarget = desktopPath;
  } else if (fs.existsSync(desktopAlt)) {
    desktopTarget = desktopAlt;
  }

  if (desktopTarget) {
    const oldDesktopExe = path.join(desktopTarget, outputName);
    const desktopLnk = path.join(desktopTarget, 'Citas Medicas.lnk');
    
    // Limpiar el ejecutable copiado por error previamente para no confundir al usuario
    if (fs.existsSync(oldDesktopExe)) {
      try {
        fs.unlinkSync(oldDesktopExe);
        log('[✓]', 'Se eliminó el ejecutable pesado del Escritorio', C.green);
      } catch (e) {
        log('[!]', `No se pudo eliminar el viejo .exe del Escritorio: ${e.message}`, C.yellow);
      }
    }

    try {
      // Crear el acceso directo usando PowerShell
      const psCommand = `powershell -NoProfile -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('${desktopLnk}'); $s.TargetPath = '${outputPath}'; $s.WorkingDirectory = '${projectDir}'; $s.Description = 'Lanzador de Citas Médicas'; $s.Save()"`;
      execSync(psCommand, { stdio: 'ignore' });
      log('[✓]', `Acceso directo creado en el Escritorio: ${desktopLnk}`, C.green);
    } catch (e) {
      log('[!]', `No se pudo crear el acceso directo: ${e.message}`, C.yellow);
      log('[→]', 'Intentando copiar el archivo físico como alternativa...', C.yellow);
      try {
        fs.copyFileSync(outputPath, oldDesktopExe);
        log('[✓]', `Copiado al Escritorio (físico): ${oldDesktopExe}`, C.green);
      } catch (e2) {
        log('[✗]', `No se pudo copiar el archivo físico: ${e2.message}`, C.red);
      }
    }
  }

  // Resumen final
  console.log('');
  console.log(`  ${C.green}${C.bold}╔══════════════════════════════════════════════════╗${C.reset}`);
  console.log(`  ${C.green}${C.bold}║   ✅ .EXE GENERADO EXITOSAMENTE                 ║${C.reset}`);
  console.log(`  ${C.green}${C.bold}╚══════════════════════════════════════════════════╝${C.reset}`);
  console.log('');
  console.log(`  ${C.white}Ubicación: ${C.cyan}${outputPath}${C.reset}`);
  console.log(`  ${C.white}Tamaño:    ${C.cyan}${sizeMB} MB${C.reset}`);
  console.log('');
  console.log(`  ${C.dim}IMPORTANTE: El .exe debe estar en la misma carpeta${C.reset}`);
  console.log(`  ${C.dim}que dashboard.js, views/, public/, node_modules/, etc.${C.reset}`);
  console.log(`  ${C.dim}Es un LANZADOR, no un empaquetado completo.${C.reset}`);
  console.log('');
  console.log(`  ${C.yellow}Para usarlo: Haz doble clic en "${outputName}"${C.reset}`);
  console.log('');
}

build().catch(err => {
  log('[✗]', `Error fatal: ${err.message}`, C.red);
  process.exit(1);
});
