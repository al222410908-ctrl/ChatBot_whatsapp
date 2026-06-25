const { execSync } = require('child_process');

function killSystemProcess() {
  const sessionName = process.env.WA_SESSION_NAME || 'sesion-doctor';
  const targetKeyword = `session-${sessionName}`;
  const dashboardKeyword = 'dashboard.js';
  const currentPid = process.pid;

  console.log(`🔍 Buscando procesos activos...`);

  try {
    // Usar wmic que es instantáneo y estable en Windows
    const cmdList = 'wmic process where "name=\'node.exe\' or name=\'chrome.exe\' or name=\'msedge.exe\'" get commandline,processid';
    const output = execSync(cmdList, { timeout: 15000 }).toString();
    
    const lines = output.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    // La primera línea contiene los encabezados
    if (lines.length <= 1) {
      console.log('✅ No hay procesos de Node o Chrome activos.');
      return;
    }

    let count = 0;
    // Buscamos de atrás hacia adelante para extraer el PID que está al final de cada línea
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      // Encontrar el PID (último número en la línea)
      const match = line.match(/(\d+)$/);
      if (!match) continue;
      const pid = parseInt(match[1]);
      const cmd = line.substring(0, line.length - match[1].length).trim();

      if (pid === currentPid) continue;

      const isDashboardNode = cmd.includes(dashboardKeyword) && !cmd.includes('kill-orphans') && !cmd.includes('node -e');
      const isSessionChrome = cmd.includes(targetKeyword) && (cmd.includes('chrome') || cmd.includes('msedge') || cmd.includes('puppeteer'));

      if (isDashboardNode || isSessionChrome) {
        console.log(`Matando proceso PID ${pid}: ${cmd.substring(0, 80)}...`);
        try {
          execSync(`taskkill /f /pid ${pid}`, { stdio: 'ignore' });
          count++;
        } catch (e) { /* ignore */ }
      }
    }
    console.log(`✨ Limpieza finalizada. Se eliminaron ${count} procesos.`);
  } catch (err) {
    console.error('⚠️ Error al limpiar procesos:', err.message);
  }
}

killSystemProcess();
