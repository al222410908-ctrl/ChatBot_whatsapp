const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// 1. Matar procesos para evitar archivos bloqueados
console.log('Matando procesos activos...');
try {
  const killScript = path.join(__dirname, 'kill-orphans.js');
  if (fs.existsSync(killScript)) {
    execSync(`node "${killScript}"`, { stdio: 'inherit' });
  }
} catch (e) {
  console.log('Advertencia al matar procesos:', e.message);
}

// 2. Eliminar la carpeta de la sesión
const sessionPath = path.join(__dirname, 'data', 'sessions', 'session-sesion-doctor');
console.log(`Intentando eliminar carpeta de sesión: ${sessionPath}`);

if (fs.existsSync(sessionPath)) {
  try {
    fs.rmSync(sessionPath, { recursive: true, force: true });
    console.log('✅ Carpeta de sesión eliminada correctamente.');
  } catch (err) {
    console.error('❌ Error al eliminar la carpeta:', err.message);
  }
} else {
  console.log('La carpeta de sesión no existe o ya fue eliminada.');
}
