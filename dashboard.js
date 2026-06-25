// ============================================================
// dashboard.js — Sistema Unificado de Citas Medicas
// whatsapp-web.js integrado directamente (sin Docker)
// ============================================================
'use strict';

const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const { crearSistemaRecordatorios } = require('./recordatorios');

// ── Cargar variables de entorno desde .env y .env.local ──────
function loadEnv(filename) {
  const envPath = path.join(__dirname, filename);
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf-8');
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.substring(0, idx).trim();
    let value = trimmed.substring(idx + 1).trim();
    // Quitar comillas si existen
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.substring(1, value.length - 1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}
loadEnv('.env.local');
loadEnv('.env');

function getLocalDateString(d = new Date()) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

const PORT = parseInt(process.env.PORT || '3001');
const DASHBOARD_PIN = process.env.DASHBOARD_PIN || '1234';
const SESSION_SECRET = process.env.SESSION_SECRET || 'citas-medicas-secret-2026';

// ── Base de datos SQLite ──────────────────────────────────────
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./chatbot-citas.db');

// ── Estado de WhatsApp ────────────────────────────────────────
let waClient = null;
let waStatus = 'desconectado'; // desconectado | inicializando | qr_listo | conectado
let waQr = null;
let waPhone = null;
let reconectando = false;
let reintentoWA = null;          // timeout de reconexion activo
let contadorFallos = 0;          // reintentos consecutivos para backoff
const MAX_BACKOFF_MS = 120000;   // maximo 2 minutos entre reintentos

function getWaClient() {
  return waClient;
}

// ── Sistema de recordatorios (usa getWaClient) ────────────────
const recordatorios = crearSistemaRecordatorios(db, getWaClient);

// ── SSE: pool de clientes conectados ─────────────────────────
let sseClients = [];
function emitSSE(evento, datos) {
  sseClients.forEach(client => {
    try {
      client.write(`event: ${evento}\ndata: ${JSON.stringify(datos)}\n\n`);
    } catch (e) { /* cliente desconectado */ }
  });
}

// ── Deduplicacion de mensajes ─────────────────────────────────
const processedMessageIds = new Set();

// ── Wrapper de enviarMensaje para historial + SSE ─────────────
// Acepta (telefono, texto, remitente, omitirAntiSpam)
const originalEnviarMensaje = recordatorios.enviarMensaje;
recordatorios.enviarMensaje = async (telefono, texto, remitente = 'bot', omitirAntiSpam = false) => {
  const result = await originalEnviarMensaje(telefono, texto, remitente, omitirAntiSpam);
  if (result.success) {
    const telFormateado = recordatorios.normalizarTelefono(telefono);
    await new Promise((resolve) => {
      db.run(
        'INSERT INTO historial_mensajes (telefono, remitente, mensaje) VALUES (?, ?, ?)',
        [telFormateado, remitente, texto],
        () => resolve()
      );
    });
    emitSSE('mensaje', { tipo: 'enviado', remitente, telefono: telFormateado, texto, fecha: new Date() });
  }
  return result;
};

// ═══════════════════════════════════════════════════════════════
// INICIALIZACION DE WHATSAPP-WEB.JS
// ═══════════════════════════════════════════════════════════════
function programarReconexion(delaySugerido) {
  if (reintentoWA) return; // ya hay uno programado
  contadorFallos++;
  // Backoff exponencial: 15s, 30s, 60s, 120s, 120s...
  const delay = Math.min(15000 * Math.pow(2, contadorFallos - 1), MAX_BACKOFF_MS);
  const segs = Math.round((delaySugerido || delay) / 1000);
  console.log(`⚠️ Reconexion programada en ${segs}s (intento ${contadorFallos})...`);
  reintentoWA = setTimeout(() => {
    reintentoWA = null;
    inicializarWhatsApp();
  }, delaySugerido || delay);
}

async function inicializarWhatsApp() {
  // Evitar inicializaciones simultaneas
  if (reconectando) return;
  reconectando = true;
  if (reintentoWA) { clearTimeout(reintentoWA); reintentoWA = null; }

  try {
    const { Client, LocalAuth } = require('whatsapp-web.js');

    // Destruir cliente anterior limpiamente
    if (waClient) {
      try {
        waClient.removeAllListeners();
        await waClient.destroy();
      } catch (e) { /* ignorar errores al destruir */ }
      waClient = null;
    }

    waStatus = 'inicializando';
    waQr = null;
    emitSSE('wa_status', { status: waStatus, qr: null });
    console.log('🔌 Inicializando WhatsApp...');

    const sessionPath = path.join(__dirname, 'data', 'sessions');
    if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

    // Limpiar archivos de bloqueo residuales
    const currentSessionName = process.env.WA_SESSION_NAME || 'sesion-doctor';
    const specificSessionPath = path.join(sessionPath, `session-${currentSessionName}`);
    
    const eliminarCarpetaSesion = () => {
      try {
        if (fs.existsSync(specificSessionPath)) {
          fs.rmSync(specificSessionPath, { recursive: true, force: true });
          console.log(`🧹 [WA] Carpeta de sesión eliminada por logout/error: ${specificSessionPath}`);
        }
      } catch (err) {
        console.warn(`⚠️ [WA] No se pudo eliminar la carpeta de sesión: ${err.message}`);
      }
    };

    if (fs.existsSync(specificSessionPath)) {
      const lockFiles = ['SingletonLock', 'lockfile', 'DevToolsActivePort'];
      for (const file of lockFiles) {
        for (const subdir of ['', 'Default']) {
          const p = subdir ? path.join(specificSessionPath, subdir, file) : path.join(specificSessionPath, file);
          if (fs.existsSync(p)) {
            try { fs.unlinkSync(p); console.log(`🧹 Bloqueo eliminado: ${path.basename(p)}`); }
            catch (e) { /* ignorar */ }
          }
        }
      }
    }

    // Buscar un navegador en el sistema para evitar problemas de permisos de Puppeteer en entornos empaquetados
    const findSystemBrowser = () => {
      const paths = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
        path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe')
      ];
      for (const p of paths) {
        if (fs.existsSync(p)) return p;
      }
      return null;
    };

    const browserPath = findSystemBrowser();
    const puppeteerOptions = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
      ],
      timeout: 60000,
    };
    if (browserPath) {
      puppeteerOptions.executablePath = browserPath;
      console.log(`🌐 Puppeteer: Usando navegador del sistema en ${browserPath}`);
    }

    const webVersionOptions = {};
    const versionPin = process.env.WWEBJS_WEB_VERSION?.trim();
    if (versionPin && versionPin.toLowerCase() !== 'off' && versionPin.toLowerCase() !== 'latest') {
      const template = process.env.WWEBJS_WEB_VERSION_REMOTE_PATH?.trim() ||
        'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/{version}.html';
      webVersionOptions.webVersion = versionPin;
      webVersionOptions.webVersionCache = {
        type: 'remote',
        remotePath: template.replace('{version}', versionPin),
      };
      console.log(`📌 WhatsApp: Usando versión fijada ${versionPin}`);
    } else {
      webVersionOptions.webVersionCache = {
        type: 'local',
      };
    }

    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: currentSessionName,
        dataPath: sessionPath,
      }),
      puppeteer: puppeteerOptions,
      ...webVersionOptions,
    });

    // ── Evento: QR listo ─────────────────────────────────
    client.on('qr', (qr) => {
      const qrcode = require('qrcode');
      qrcode.toDataURL(qr, (err, url) => {
        waQr = err ? null : url;
        waStatus = 'qr_listo';
        console.log('📱 QR listo para escanear en el panel');
        emitSSE('wa_status', { status: waStatus, qr: waQr });
      });
    });

    // ── Evento: Conectado y listo ─────────────────────────
    client.on('ready', () => {
      waStatus = 'conectado';
      waPhone = client.info?.wid?.user || 'desconocido';
      waQr = null;
      contadorFallos = 0; // resetear backoff al conectar exitosamente
      console.log(`✅ WhatsApp conectado! Numero: ${waPhone}`);
      emitSSE('wa_status', { status: 'conectado', qr: null, phone: waPhone });
      reconectando = false;

      // Sincronizar mapeos de LID para todos los pacientes
      sincronizarMapeosLid(client).catch(err => {
        console.error('❌ Error en sincronización de mapeos LID:', err.message);
      });
    });

    // ── Evento: Autenticado ───────────────────────────────
    client.on('authenticated', () => {
      console.log('🔑 WhatsApp autenticado correctamente');
      waStatus = 'autenticado';
    });

    // ── Evento: Fallo de autenticacion ────────────────────
    client.on('auth_failure', (msg) => {
      console.error('❌ Fallo de autenticacion WhatsApp:', msg);
      waStatus = 'desconectado';
      emitSSE('wa_status', { status: 'desconectado', error: 'Fallo de autenticacion' });
      reconectando = false;
      eliminarCarpetaSesion();
    });

    // ── Evento: Desconectado ──────────────────────────────
    client.on('disconnected', (reason) => {
      console.log(`⚠️ WhatsApp desconectado: ${reason}`);
      waStatus = 'desconectado';
      waPhone = null;
      emitSSE('wa_status', { status: 'desconectado', reason });
      reconectando = false;

      if (reason === 'LOGOUT') {
        eliminarCarpetaSesion();
      }

      // Solo reconectar si no fue por cierre voluntario
      if (reason !== 'LOGOUT' && reason !== 'NAVIGATION') {
        programarReconexion(15000);
      }
    });

    // ── Evento: Mensaje recibido ──────────────────────────
    // Handler unificado que procesa mensajes de CUALQUIER formato
    const _procesarMensajeEntrante = async (message) => {
      try {
        if (message.fromMe) return;

        const from = message.from || '';
        const author = message.author || '';
        const body = message.body || '';
        const tipo = message.type || 'unknown';

        // Log CRUDO de todo mensaje entrante (para diagnóstico)
        const logLine = `[${new Date().toISOString()}] from=${from} author=${author} type=${tipo} body="${body.substring(0, 60)}"`;
        try {
          const logPath = require('path').join(__dirname, 'mensajes_crudos.log');
          require('fs').appendFileSync(logPath, logLine + '\n');
        } catch(e) { /* ignorar error de log */ }

        // Ignorar grupos, newsletters, broadcasts, canales, y status
        if (
          from.endsWith('@g.us') ||
          from.endsWith('@newsletter') ||
          from.endsWith('@broadcast') ||
          from === 'status@broadcast'
        ) return;

        // Solo procesar mensajes de chat (texto)
        if (tipo !== 'chat' && tipo !== 'unknown') {
          console.log(`⏭️ Mensaje tipo '${tipo}' ignorado de ${from}`);
          return;
        }

        // ── Estrategia múltiple para obtener el número de teléfono ──
        let rawNumber = '';

        // Estrategia 1: Extraer del campo 'from' quitando cualquier sufijo @xxx (siempre que no sea LID)
        if (!from.includes('lid')) {
          const fromClean = from.replace(/@.*$/, '');
          if (/^\d{8,15}$/.test(fromClean)) {
            rawNumber = fromClean;
          }
        } else {
          console.log(`🔍 [LID] Detectado mensaje de LID en from: ${from}`);
        }

        // Estrategia 2: Si no funcionó (o es LID), intentar con getContact()
        if (!rawNumber) {
          try {
            const contact = await message.getContact();
            if (contact) {
              // Prioridad 1: contact.number (el número de teléfono real del contacto)
              if (contact.number && /^\d{8,15}$/.test(contact.number.replace(/\D/g, ''))) {
                rawNumber = contact.number.replace(/\D/g, '');
                console.log(`🔄 [LID] Número obtenido via contact.number: ${from} -> ${rawNumber}`);
              }
              // Prioridad 2: contact.id.user (siempre que no sea LID)
              else if (contact.id && contact.id.user && /^\d{8,15}$/.test(contact.id.user) && !contact.id.user.includes('lid') && !(contact.id._serialized || '').includes('lid')) {
                rawNumber = contact.id.user;
                console.log(`🔄 Número obtenido via contact.id.user: ${from} -> ${rawNumber}`);
              }
              // Prioridad 3: contact.id._serialized (siempre que no sea LID)
              else if (contact.id && contact.id._serialized) {
                const serializedClean = contact.id._serialized.replace(/@.*$/, '');
                if (/^\d{8,15}$/.test(serializedClean) && !contact.id._serialized.includes('lid')) {
                  rawNumber = serializedClean;
                  console.log(`🔄 Número obtenido via _serialized: ${from} -> ${rawNumber}`);
                }
              }
            }
          } catch (contactErr) {
            console.log(`⚠️ Error obteniendo contacto para ${from}: ${contactErr.message}`);
          }
        }

        // Estrategia 3: Si aún no tenemos número, intentar con message._data (siempre que no sea LID)
        if (!rawNumber && message._data && !String(message._data.from).includes('lid')) {
          const notifyName = message._data.notifyName || '';
          const fromData = (message._data.from || '').replace(/@.*$/, '');
          if (/^\d{8,15}$/.test(fromData)) {
            rawNumber = fromData;
            console.log(`🔄 Número obtenido via _data.from: ${from} -> ${rawNumber}`);
          }
        }

        if (!rawNumber) {
          console.log(`⚠️ No se pudo extraer número de: from=${from} author=${author}`);
          return;
        }

        // Deduplicar
        const msgId = message.id?.id || message.id?._serialized || String(message.id);
        if (msgId) {
          if (processedMessageIds.has(msgId)) return;
          processedMessageIds.add(msgId);
          if (processedMessageIds.size > 1000) {
            const first = processedMessageIds.values().next().value;
            processedMessageIds.delete(first);
          }
        }

        let telefono = recordatorios.normalizarTelefono(rawNumber);
        const texto = body;

        if (!telefono || !texto) return;

        // Intentar resolver mapeo de LID a teléfono real
        const mapeoLid = await new Promise((resolve) => {
          db.get('SELECT telefono FROM lid_mappings WHERE lid = ?', [telefono], (err, row) => {
            resolve(row ? row.telefono : null);
          });
        });
        if (mapeoLid) {
          console.log(`🔄 [LID MAPPED] Remitente LID ${telefono} resuelto a teléfono real: ${mapeoLid}`);
          telefono = mapeoLid;
        }

        // Filtrar mensajes que parecen spam (muy largos sin ser de pacientes)
        const esNumeroPaciente = await new Promise(resolve => {
          db.get('SELECT id FROM pacientes WHERE telefono = ?', [telefono], (err, row) => resolve(!!row));
        });
        if (!esNumeroPaciente && texto.length > 500) {
          console.log(`🚫 Spam ignorado de ${telefono} (${texto.length} chars, no es paciente)`);
          return;
        }

        console.log(`📱 Mensaje de ${telefono}: "${texto.substring(0, 80)}${texto.length > 80 ? '...' : ''}"`);

        // Guardar en historial
        await new Promise((resolve) => {
          db.run(
            'INSERT INTO historial_mensajes (telefono, remitente, mensaje) VALUES (?, ?, ?)',
            [telefono, 'paciente', texto],
            () => resolve()
          );
        });

        emitSSE('mensaje', { tipo: 'recibido', remitente: 'paciente', telefono, texto, fecha: new Date() });

        procesarMensaje(telefono, texto).catch(err => {
          console.error('❌ Error procesando mensaje:', err.message);
        });

      } catch (err) {
        console.error('❌ Error en evento message:', err.message, err.stack);
      }
    };

    client.on('message', _procesarMensajeEntrante);

    // ── Fallback: message_create (algunas versiones de whatsapp-web.js
    //    solo emiten 'message_create' en vez de 'message') ──────────
    client.on('message_create', async (message) => {
      // Solo procesar mensajes que NO son del bot (los propios se ignoran)
      if (message.fromMe) return;
      // El deduplicador evitará procesamiento doble
      _procesarMensajeEntrante(message);
    });

    waClient = client;
    await client.initialize();

  } catch (error) {
    const esTargetClosed = error.message && (
      error.message.includes('Target closed') ||
      error.message.includes('detached') ||
      error.message.includes('Navigating frame')
    );

    if (esTargetClosed) {
      console.warn('⚠️ WhatsApp Web se cerro durante la inicializacion (reconectando...).');
    } else {
      console.error('❌ Error inicializando WhatsApp:', error.message);
    }

    waStatus = 'desconectado';
    reconectando = false;
    emitSSE('wa_status', { status: 'desconectado', error: esTargetClosed ? 'Reiniciando...' : error.message });
    programarReconexion();
  }
}

// ═══════════════════════════════════════════════════════════════
// INICIALIZAR BASE DE DATOS
// ═══════════════════════════════════════════════════════════════
async function inicializarBD() {
  const run = (sql) => new Promise((resolve, reject) => {
    db.run(sql, (err) => { if (err) reject(err); else resolve(); });
  });

  await run(`CREATE TABLE IF NOT EXISTS pacientes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telefono TEXT UNIQUE,
    nombre TEXT,
    creado_en DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await run(`CREATE TABLE IF NOT EXISTS citas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    paciente_id INTEGER,
    fecha TEXT,
    hora TEXT,
    motivo TEXT,
    estado TEXT DEFAULT 'pendiente',
    notas TEXT,
    creada_en DATETIME DEFAULT CURRENT_TIMESTAMP,
    confirmada_en DATETIME,
    recordatorio_enviado INTEGER DEFAULT 0,
    encuesta_enviada INTEGER DEFAULT 0,
    calificacion INTEGER,
    cita_original_id INTEGER,
    FOREIGN KEY (paciente_id) REFERENCES pacientes(id)
  )`);

  await run(`CREATE TABLE IF NOT EXISTS conversaciones (
    telefono TEXT PRIMARY KEY,
    estado TEXT,
    datos TEXT,
    actualizado_en DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await run(`CREATE TABLE IF NOT EXISTS mensajes_pendientes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telefono TEXT,
    mensaje TEXT,
    estado TEXT DEFAULT 'pendiente',
    tipo TEXT DEFAULT 'manual',
    cita_id INTEGER,
    intentos INTEGER DEFAULT 0,
    creado_en DATETIME DEFAULT CURRENT_TIMESTAMP,
    enviado_en DATETIME,
    ultimo_intento_en DATETIME
  )`);

  await run(`CREATE TABLE IF NOT EXISTS configuraciones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dias_laborales TEXT,
    hora_inicio TEXT,
    hora_fin TEXT,
    duracion_cita INTEGER,
    direccion TEXT,
    google_maps_url TEXT,
    indicaciones TEXT
  )`);

  await run(`CREATE TABLE IF NOT EXISTS historial_mensajes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telefono TEXT,
    remitente TEXT,
    mensaje TEXT,
    leido INTEGER DEFAULT 0,
    creado_en DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await run(`CREATE TABLE IF NOT EXISTS lid_mappings (
    lid TEXT PRIMARY KEY,
    telefono TEXT,
    creado_en DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Configuracion por defecto
  const count = await new Promise((resolve, reject) => {
    db.get('SELECT COUNT(*) as count FROM configuraciones', (err, row) => {
      if (err) reject(err); else resolve(row.count);
    });
  });

  if (count === 0) {
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO configuraciones (dias_laborales, hora_inicio, hora_fin, duracion_cita, direccion, google_maps_url, indicaciones)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ['[1,2,3,4,5]', '09:00', '18:00', 60,
         'Av. Benito Juarez 123, Toluca Centro',
         'https://maps.app.goo.gl/K8r5x',
         'Por favor llegar 10 minutos antes y traer su identificacion.'],
        (err) => { if (err) reject(err); else resolve(); }
      );
    });
  }

  // Migraciones seguras (agregar columnas nuevas si no existen)
  const addColumn = (table, colDef) => new Promise((resolve) => {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${colDef}`, () => resolve());
  });

  await addColumn('citas', 'notas TEXT');
  await addColumn('citas', 'confirmada_en DATETIME');
  await addColumn('citas', 'recordatorio_enviado INTEGER DEFAULT 0');
  await addColumn('citas', 'encuesta_enviada INTEGER DEFAULT 0');
  await addColumn('citas', 'calificacion INTEGER');
  await addColumn('citas', 'cita_original_id INTEGER');
  await addColumn('citas', 'aviso_10min_enviado INTEGER DEFAULT 0');
  await addColumn('mensajes_pendientes', "tipo TEXT DEFAULT 'manual'");
  await addColumn('mensajes_pendientes', 'cita_id INTEGER');
  await addColumn('mensajes_pendientes', 'intentos INTEGER DEFAULT 0');
  await addColumn('mensajes_pendientes', 'ultimo_intento_en DATETIME');
  await addColumn('historial_mensajes', 'leido INTEGER DEFAULT 0');

  console.log('💾 Base de datos inicializada');
}

// ═══════════════════════════════════════════════════════════════
// HELPERS DE BD
// ═══════════════════════════════════════════════════════════════
function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => { if (err) reject(err); else resolve(row); });
  });
}
function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) { if (err) reject(err); else resolve(this.lastID || this.changes); });
  });
}
function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => { if (err) reject(err); else resolve(rows); });
  });
}

async function sincronizarMapeosLid(client) {
  console.log('🔄 [LID] Sincronizando mapeos de LID para pacientes...');
  try {
    const rows = await dbAll('SELECT telefono FROM pacientes');
    let count = 0;
    for (const row of rows) {
      try {
        const tel = row.telefono;
        const numberId = await client.getNumberId(tel);
        if (numberId && numberId._serialized.includes('lid')) {
          const lid = numberId._serialized.replace(/@.*$/, '');
          await dbRun(
            'INSERT OR REPLACE INTO lid_mappings (lid, telefono) VALUES (?, ?)',
            [lid, tel]
          );
          count++;
        }
      } catch (e) {
        console.warn(`⚠️ [LID] Error resolviendo LID para ${row.telefono}:`, e.message);
      }
    }
    console.log(`✅ [LID] Sincronización finalizada. Se mapearon ${count} LIDs.`);
  } catch (err) {
    console.error('❌ [LID] Error en sincronización:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// CHATBOT: FLUJO DE CONVERSACION
// ═══════════════════════════════════════════════════════════════

async function obtenerEstadoConversacion(telefono) {
  return dbGet('SELECT * FROM conversaciones WHERE telefono = ?', [telefono]);
}
async function guardarEstadoConversacion(telefono, estado, datos = {}) {
  return dbRun(
    `INSERT OR REPLACE INTO conversaciones (telefono, estado, datos, actualizado_en)
     VALUES (?, ?, ?, datetime('now'))`,
    [telefono, estado, JSON.stringify(datos)]
  );
}
async function limpiarEstadoConversacion(telefono) {
  return dbRun('DELETE FROM conversaciones WHERE telefono = ?', [telefono]);
}

async function mostrarMenu(telefono) {
  const mensaje = `🏥 *Chatbot de Citas Medicas*\n\nHola, soy tu asistente virtual. ¿En que puedo ayudarte?\n\n📅 *Agendar cita* - Escribe "cita" o "agendar"\n📋 *Mis citas* - Escribe "mis citas" o "consultar"\n❌ *Cancelar cita* - Escribe "cancelar"\n❓ *Ayuda* - Escribe "ayuda"\n\nEscribe una opcion para comenzar.`;
  await recordatorios.enviarMensaje(telefono, mensaje);
  await limpiarEstadoConversacion(telefono);
}

async function mostrarAyuda(telefono) {
  const mensaje = `❓ *Ayuda - Chatbot de Citas*\n\n📅 *Agendar cita:*\n1. Escribe "cita" o "agendar"\n2. Sigue las instrucciones paso a paso\n3. Confirma tu cita\n\n📋 *Consultar citas:*\n- Escribe "mis citas" para ver tus proximas citas\n\n❌ *Cancelar cita:*\n- Escribe "cancelar" para cancelar una cita\n\n🔄 *Reagendar cita:*\n- Cuando recibas un recordatorio, responde "3" o "reagendar"\n\n💡 *Tips:*\n- Usa fechas en formato DD/MM/YYYY\n- Responde a recordatorios con: 1 (Confirmar), 2 (Cancelar), 3 (Reagendar)`;
  await recordatorios.enviarMensaje(telefono, mensaje);
}

async function iniciarAgendamiento(telefono) {
  // 1. Verificar si el paciente ya tiene una cita pendiente o confirmada futura
  const hoyStr = getLocalDateString();
  const citaExistente = await new Promise((resolve) => {
    db.get(
      `SELECT c.fecha, c.hora, c.estado FROM citas c
       JOIN pacientes p ON c.paciente_id = p.id
       WHERE p.telefono = ? AND c.fecha >= ? AND c.estado IN ('pendiente', 'confirmada')
       ORDER BY c.fecha ASC, c.hora ASC LIMIT 1`,
      [telefono, hoyStr],
      (err, row) => resolve(row)
    );
  });

  if (citaExistente) {
    const fechaFormateada = citaExistente.fecha.split('-').reverse().join('/');
    const estadoStr = citaExistente.estado === 'confirmada' ? 'confirmada' : 'pendiente de confirmación';
    await recordatorios.enviarMensaje(
      telefono,
      `⚠️ *Ya tienes una cita programada*\n\nVeo que tienes una cita *${estadoStr}* para el *${fechaFormateada}* a las *${citaExistente.hora.substring(0, 5)}*.\n\nSi deseas cambiarla o reagendarla, responde *"cancelar"* primero para cancelar tu cita actual y liberar tu horario, o escribe *"menu"* para volver al menú principal.`
    );
    return;
  }

  // 2. Verificar si el paciente ya está registrado en el sistema
  const paciente = await new Promise((resolve) => {
    db.get('SELECT nombre FROM pacientes WHERE telefono = ?', [telefono], (err, row) => resolve(row));
  });

  if (paciente && paciente.nombre) {
    const nombre = paciente.nombre.trim();
    const datos = { nombre };
    await guardarEstadoConversacion(telefono, 'esperando_fecha', datos);
    await recordatorios.enviarMensaje(
      telefono,
      `📅 *Agendar Nueva Cita*\n\nHola *${nombre}*, gusto en saludarte nuevamente. 😊\n\n📅 ¿Para qué fecha deseas tu cita?\nEscribe la fecha en formato DD/MM/YYYY (ej: 17/06/2026)`
    );
  } else {
    // Si no está registrado, pedir su nombre completo
    await guardarEstadoConversacion(telefono, 'esperando_nombre');
    await recordatorios.enviarMensaje(
      telefono,
      `📅 *Agendar Nueva Cita*\n\nVamos a agendar tu cita. Primero, ¿cual es tu nombre completo?\n\nEscribe tu nombre para continuar.`
    );
  }
}

async function procesarNombre(telefono, nombre, estado) {
  const datos = JSON.parse(estado.datos || '{}');
  datos.nombre = nombre;
  await guardarEstadoConversacion(telefono, 'esperando_fecha', datos);
  await recordatorios.enviarMensaje(telefono, `✅ Nombre: ${nombre}\n\n📅 ¿Para que fecha deseas tu cita?\nEscribe la fecha en formato DD/MM/YYYY (ej: 17/06/2026)`);
}

async function procesarFecha(telefono, fecha, estado) {
  const datos = JSON.parse(estado.datos || '{}');
  const regex = /^(\d{2})\/(\d{2})\/(\d{4})$/;
  if (!regex.test(fecha)) {
    await recordatorios.enviarMensaje(telefono, '❌ Formato de fecha invalido. Usa DD/MM/YYYY (ej: 17/06/2026)');
    return;
  }
  const [, dia, mes, anio] = fecha.match(regex);
  
  // Validar que la fecha no sea en el pasado
  const dateObj = new Date(anio, mes - 1, dia);
  const hoy = new Date();
  hoy.setHours(0,0,0,0);
  if (dateObj < hoy) {
    await recordatorios.enviarMensaje(telefono, '❌ La fecha no puede ser en el pasado. Escribe una fecha de hoy en adelante (ej: 17/06/2026).');
    return;
  }

  const fechaISO = `${anio}-${mes}-${dia}`;
  const slots = await recordatorios.obtenerHorariosDisponibles(fechaISO);
  if (slots.length === 0) {
    await recordatorios.enviarMensaje(telefono, `❌ No hay horarios disponibles para el ${fecha}. Por favor escribe otra fecha.`);
    return;
  }
  datos.fecha = fechaISO;
  datos.fechaDisplay = fecha;
  datos.slots = slots;
  await guardarEstadoConversacion(telefono, 'esperando_seleccion_hora', datos);
  let mensajeSlots = `📅 *Horarios disponibles para el ${fecha}*:\n\n`;
  slots.forEach((slot, i) => { mensajeSlots += `${i + 1}️⃣ ${slot}\n`; });
  mensajeSlots += `\nResponde con el *numero* del horario que prefieras.`;
  await recordatorios.enviarMensaje(telefono, mensajeSlots);
}

async function procesarSeleccionHora(telefono, respuesta, estado) {
  const datos = JSON.parse(estado.datos || '{}');
  const idx = parseInt(respuesta.trim()) - 1;
  const slots = datos.slots || [];
  if (isNaN(idx) || idx < 0 || idx >= slots.length) {
    let msg = `❌ Seleccion invalida. Responde con el numero del horario:\n\n`;
    slots.forEach((slot, i) => { msg += `${i + 1}️⃣ ${slot}\n`; });
    await recordatorios.enviarMensaje(telefono, msg);
    return;
  }
  datos.hora = slots[idx];
  await guardarEstadoConversacion(telefono, 'esperando_motivo', datos);
  await recordatorios.enviarMensaje(telefono, `✅ Hora seleccionada: ${datos.hora}\n\n📝 ¿Cual es el motivo de tu cita?\nEjemplos: "consulta general", "revision", "analisis"`);
}

async function procesarMotivo(telefono, motivo, estado) {
  const datos = JSON.parse(estado.datos || '{}');
  datos.motivo = motivo;
  await guardarEstadoConversacion(telefono, 'confirmar_cita', datos);
  const msg = `📋 *Resumen de tu Cita*\n\n👤 Nombre: ${datos.nombre}\n📅 Fecha: ${datos.fechaDisplay || datos.fecha}\n⏰ Hora: ${datos.hora}\n📝 Motivo: ${datos.motivo}\n\n¿Confirmas esta cita?\nResponde "si" para confirmar o "no" para cancelar.`;
  await recordatorios.enviarMensaje(telefono, msg);
}

async function procesarConfirmacion(telefono, respuesta, estado) {
  const datos = JSON.parse(estado.datos || '{}');
  const accion = recordatorios.interpretarRespuesta(respuesta);

  if (accion === 'confirmar') {
    await dbRun('INSERT OR REPLACE INTO pacientes (telefono, nombre) VALUES (?, ?)', [telefono, datos.nombre]);
    const paciente = await dbGet('SELECT id FROM pacientes WHERE telefono = ?', [telefono]);
    await dbRun(
      'INSERT INTO citas (paciente_id, fecha, hora, motivo, estado) VALUES (?, ?, ?, ?, ?)',
      [paciente.id, datos.fecha, datos.hora, datos.motivo, 'confirmada']
    );
    await limpiarEstadoConversacion(telefono);
    const config = await dbGet('SELECT * FROM configuraciones LIMIT 1');
    let ubicacion = '';
    if (config) {
      ubicacion = `\n\n📍 *Ubicacion del Consultorio:*\n${config.direccion}\n🗺️ *Mapa:* ${config.google_maps_url}\n⚠️ *Indicaciones:* ${config.indicaciones}`;
    }
    await recordatorios.enviarMensaje(telefono, `✅ *Cita Confirmada*\n\n👤 Paciente: ${datos.nombre}\n📅 Fecha: ${datos.fechaDisplay || datos.fecha}\n⏰ Hora: ${datos.hora}\n📝 Motivo: ${datos.motivo}${ubicacion}\n\nTe enviaremos un recordatorio 24 horas antes.\n¡Gracias por agendar!`);
  } else if (accion === 'cancelar') {
    await limpiarEstadoConversacion(telefono);
    await recordatorios.enviarMensaje(telefono, '❌ Cita cancelada. Escribe "cita" para agendar una nueva.');
  } else {
    await recordatorios.enviarMensaje(telefono, '❌ Respuesta no reconocida. Responde "si" para confirmar o "no" para cancelar.');
  }
}

async function consultarCitas(telefono) {
  const hoyStr = getLocalDateString();
  const citas = await dbAll(
    `SELECT c.* FROM citas c JOIN pacientes p ON c.paciente_id = p.id
     WHERE p.telefono = ? AND c.fecha >= ? AND c.estado NOT IN ('cancelada', 'reagendada')
     ORDER BY c.fecha, c.hora`, [telefono, hoyStr]
  );
  if (citas.length === 0) {
    await recordatorios.enviarMensaje(telefono, '📋 No tienes citas proximas. Escribe "cita" para agendar una.');
  } else {
    let msg = '📋 *Tus Proximas Citas*\n\n';
    citas.forEach((cita, i) => {
      const emoji = cita.estado === 'confirmada' ? '✅' : cita.estado === 'pendiente' ? '⏳' : '❌';
      msg += `${i + 1}. 📅 ${cita.fecha} - ⏰ ${cita.hora} ${emoji}\n   📝 ${cita.motivo}\n\n`;
    });
    msg += 'Escribe "cancelar" si deseas cancelar alguna cita.';
    await recordatorios.enviarMensaje(telefono, msg);
  }
  await limpiarEstadoConversacion(telefono);
}

async function iniciarCancelacion(telefono) {
  const hoyStr = getLocalDateString();
  const citas = await dbAll(
    `SELECT c.* FROM citas c JOIN pacientes p ON c.paciente_id = p.id
     WHERE p.telefono = ? AND c.fecha >= ? AND c.estado IN ('pendiente', 'confirmada')
     ORDER BY c.fecha, c.hora`, [telefono, hoyStr]
  );
  if (citas.length === 0) {
    await recordatorios.enviarMensaje(telefono, '📋 No tienes citas programadas para cancelar.');
    return;
  }
  await guardarEstadoConversacion(telefono, 'cancelando_cita', { citas: citas.map(c => c.id) });
  let msg = '❌ *Cancelar Cita*\n\nTus citas programadas:\n\n';
  citas.forEach((cita, i) => {
    const estadoStr = cita.estado === 'confirmada' ? ' (Confirmada)' : ' (Pendiente de confirmación)';
    msg += `${i + 1}. 📅 ${cita.fecha} - ⏰ ${cita.hora.substring(0, 5)}${estadoStr}\n   📝 ${cita.motivo || 'Consulta general'}\n\n`;
  });
  msg += 'Responde el *numero* de la cita que deseas cancelar.';
  await recordatorios.enviarMensaje(telefono, msg);
}

async function procesarCancelacion(telefono, respuesta, estado) {
  const datos = JSON.parse(estado.datos || '{}');
  const idx = parseInt(respuesta) - 1;
  const citaIds = datos.citas || [];
  if (isNaN(idx) || idx < 0 || idx >= citaIds.length) {
    await recordatorios.enviarMensaje(telefono, '❌ Numero invalido. Responde con el numero de la cita a cancelar.');
    return;
  }
  await dbRun('UPDATE citas SET estado = ? WHERE id = ?', ['cancelada', citaIds[idx]]);
  await limpiarEstadoConversacion(telefono);
  await recordatorios.enviarMensaje(telefono, '✅ Cita cancelada exitosamente. Escribe "cita" si deseas agendar una nueva.');
}

async function procesarReagendandoFecha(telefono, fecha, estado) {
  const datos = JSON.parse(estado.datos || '{}');
  const regex = /^(\d{2})\/(\d{2})\/(\d{4})$/;
  if (!regex.test(fecha)) {
    await recordatorios.enviarMensaje(telefono, '❌ Formato invalido. Usa DD/MM/YYYY (ej: 20/06/2026)');
    return;
  }
  const [, dia, mes, anio] = fecha.match(regex);
  const fechaISO = `${anio}-${mes}-${dia}`;
  const slots = await recordatorios.obtenerHorariosDisponibles(fechaISO);
  if (slots.length === 0) {
    await recordatorios.enviarMensaje(telefono, `❌ No hay horarios disponibles para el ${fecha}. Escribe otra fecha.`);
    return;
  }
  datos.nuevaFecha = fechaISO;
  datos.nuevaFechaDisplay = fecha;
  datos.slots = slots;
  await guardarEstadoConversacion(telefono, 'reagendando_seleccion_hora', datos);
  let msg = `📅 *Horarios disponibles para el ${fecha}*:\n\n`;
  slots.forEach((slot, i) => { msg += `${i + 1}️⃣ ${slot}\n`; });
  msg += `\nResponde con el *numero* del horario que prefieras.`;
  await recordatorios.enviarMensaje(telefono, msg);
}

async function procesarReagendandoSeleccionHora(telefono, respuesta, estado) {
  const datos = JSON.parse(estado.datos || '{}');
  const idx = parseInt(respuesta.trim()) - 1;
  const slots = datos.slots || [];
  if (isNaN(idx) || idx < 0 || idx >= slots.length) {
    let msg = `❌ Seleccion invalida:\n\n`;
    slots.forEach((slot, i) => { msg += `${i + 1}️⃣ ${slot}\n`; });
    await recordatorios.enviarMensaje(telefono, msg);
    return;
  }
  datos.nuevaHora = slots[idx];
  await guardarEstadoConversacion(telefono, 'reagendando_confirmar', datos);
  const msg = `📋 *Confirmar Reagendamiento*\n\n📅 Nueva fecha: ${datos.nuevaFechaDisplay || datos.nuevaFecha}\n⏰ Nueva hora: ${datos.nuevaHora}\n📝 Motivo: ${datos.motivo || 'Consulta general'}\n\n¿Confirmas el reagendamiento?\nResponde "si" o "no".`;
  await recordatorios.enviarMensaje(telefono, msg);
}

async function procesarReagendandoConfirmar(telefono, respuesta, estado) {
  const datos = JSON.parse(estado.datos || '{}');
  const accion = recordatorios.interpretarRespuesta(respuesta);
  if (accion === 'confirmar') {
    if (datos.citaOriginalId) {
      await dbRun('UPDATE citas SET estado = ? WHERE id = ?', ['reagendada', datos.citaOriginalId]);
    }
    await dbRun('INSERT OR REPLACE INTO pacientes (telefono, nombre) VALUES (?, ?)', [telefono, datos.nombre]);
    const paciente = await dbGet('SELECT id FROM pacientes WHERE telefono = ?', [telefono]);
    await dbRun(
      'INSERT INTO citas (paciente_id, fecha, hora, motivo, estado, cita_original_id) VALUES (?, ?, ?, ?, ?, ?)',
      [paciente.id, datos.nuevaFecha, datos.nuevaHora, datos.motivo || 'Consulta general', 'confirmada', datos.citaOriginalId || null]
    );
    await limpiarEstadoConversacion(telefono);
    const config = await dbGet('SELECT * FROM configuraciones LIMIT 1');
    let ubicacion = '';
    if (config) {
      ubicacion = `\n\n📍 *Ubicacion:*\n${config.direccion}\n🗺️ *Mapa:* ${config.google_maps_url}\n⚠️ *Indicaciones:* ${config.indicaciones}`;
    }
    await recordatorios.enviarMensaje(telefono, `✅ *Cita Reagendada*\n\n📅 Nueva fecha: ${datos.nuevaFechaDisplay || datos.nuevaFecha}\n⏰ Nueva hora: ${datos.nuevaHora}\n📝 Motivo: ${datos.motivo || 'Consulta general'}${ubicacion}\n\nTe enviaremos un recordatorio 24 horas antes. ¡Gracias!`);
  } else if (accion === 'cancelar') {
    await limpiarEstadoConversacion(telefono);
    await recordatorios.enviarMensaje(telefono, '❌ Reagendamiento cancelado. Tu cita original se mantiene. Escribe "mis citas" para consultar.');
  } else {
    await recordatorios.enviarMensaje(telefono, '❌ Respuesta no reconocida. Responde "si" o "no".');
  }
}

async function procesarEncuesta(telefono, respuesta, estado) {
  const datos = JSON.parse(estado.datos || '{}');
  const calificacion = parseInt(respuesta.trim());
  if (isNaN(calificacion) || calificacion < 1 || calificacion > 5) {
    await recordatorios.enviarMensaje(telefono, '❌ Por favor, califica del 1 al 5.');
    return;
  }
  await dbRun('UPDATE citas SET calificacion = ? WHERE id = ?', [calificacion, datos.citaId]);
  await limpiarEstadoConversacion(telefono);
  await recordatorios.enviarMensaje(telefono, `🙏 ¡Muchas gracias por calificar con un *${calificacion}*! Tu opinion nos ayuda a mejorar. 🩺`);
}

async function procesarMensaje(telefono, mensaje) {
  const mensajeLower = mensaje.toLowerCase().trim();
  const estado = await obtenerEstadoConversacion(telefono);
  console.log(`📩 Mensaje de ${telefono}: "${mensaje}" | Estado: ${estado?.estado || 'nuevo'}`);

  if (estado?.estado) {
    const esComando = mensajeLower.includes('cita') || 
                      mensajeLower.includes('agendar') || 
                      mensajeLower === 'menu' || 
                      mensajeLower === 'menú' || 
                      mensajeLower.includes('mis citas') || 
                      mensajeLower.includes('consultar') || 
                      mensajeLower.includes('ayuda') || 
                      mensajeLower.includes('help');

    if (esComando) {
      console.log(`🔄 Comando recibido de ${telefono}. Limpiando estado anterior: ${estado.estado}`);
      await limpiarEstadoConversacion(telefono);
    } else {
      switch (estado.estado) {
        case 'esperando_nombre': return procesarNombre(telefono, mensaje, estado);
        case 'esperando_fecha': return procesarFecha(telefono, mensaje, estado);
        case 'esperando_seleccion_hora': return procesarSeleccionHora(telefono, mensaje, estado);
        case 'esperando_motivo': return procesarMotivo(telefono, mensaje, estado);
        case 'confirmar_cita': return procesarConfirmacion(telefono, mensaje, estado);
        case 'cancelando_cita': return procesarCancelacion(telefono, mensaje, estado);
        case 'reagendando_fecha': return procesarReagendandoFecha(telefono, mensaje, estado);
        case 'reagendando_seleccion_hora': return procesarReagendandoSeleccionHora(telefono, mensaje, estado);
        case 'reagendando_confirmar': return procesarReagendandoConfirmar(telefono, mensaje, estado);
        case 'esperando_encuesta': return procesarEncuesta(telefono, mensaje, estado);
      }
    }
  }

  const accion = recordatorios.interpretarRespuesta(mensaje);
  if (accion === 'confirmar' || accion === 'cancelar' || accion === 'reagendar') {
    const resultado = await recordatorios.procesarRespuestaRecordatorio(telefono, mensaje);
    if (resultado.processed) return;
  }

  if (mensajeLower.includes('mis citas') || mensajeLower.includes('consultar')) {
    return consultarCitas(telefono);
  } else if (mensajeLower.includes('cancelar')) {
    return iniciarCancelacion(telefono);
  } else if (mensajeLower.includes('cita') || mensajeLower.includes('agendar')) {
    return iniciarAgendamiento(telefono);
  } else if (mensajeLower.includes('ayuda') || mensajeLower.includes('help')) {
    return mostrarAyuda(telefono);
  } else {
    return mostrarMenu(telefono);
  }
}

// ═══════════════════════════════════════════════════════════════
// EXPRESS APP
// ═══════════════════════════════════════════════════════════════
const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ── Sesion del doctor ─────────────────────────────────────────
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, // true solo con HTTPS
    maxAge: 8 * 60 * 60 * 1000, // 8 horas
    httpOnly: true,
  },
}));

// ── Middleware de autenticacion ───────────────────────────────
function requireAuth(req, res, next) {
  if (req.session && req.session.autenticado) return next();
  return res.redirect('/login');
}

// Rutas publicas (sin auth)
app.get('/login', (req, res) => {
  if (req.session && req.session.autenticado) return res.redirect('/dashboard');
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  const { pin } = req.body;
  if (pin === DASHBOARD_PIN) {
    req.session.autenticado = true;
    return res.redirect('/dashboard');
  }
  res.render('login', { error: 'PIN incorrecto. Intenta de nuevo.' });
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ─── Aplicar auth a todas las rutas protegidas ───────────────
app.use(['/dashboard', '/citas', '/pacientes', '/mensajes', '/chat', '/configuracion', '/analytics'], requireAuth);
app.use('/api', (req, res, next) => {
  // Permitir verificar el estado del sistema públicamente para diagnósticos
  if (req.path === '/sistema/estado') return next();
  return requireAuth(req, res, next);
});

// ═══════════════════════════════════════════════════════════════
// RUTAS PRINCIPALES
// ═══════════════════════════════════════════════════════════════

app.get('/', (req, res) => res.redirect('/dashboard'));

// ─── Dashboard ───────────────────────────────────────────────
app.get('/dashboard', async (req, res) => {
  try {
    const hoyStr = getLocalDateString();
    const manana = new Date();
    manana.setDate(manana.getDate() + 1);
    const mananaStr = getLocalDateString(manana);

    const stats = await dbGet(`
      SELECT
        (SELECT COUNT(*) FROM pacientes) as total_pacientes,
        (SELECT COUNT(*) FROM citas WHERE fecha >= ? AND estado != 'cancelada') as citas_pendientes,
        (SELECT COUNT(*) FROM citas WHERE estado = 'confirmada') as citas_confirmadas,
        (SELECT COUNT(*) FROM citas WHERE estado = 'cancelada') as citas_canceladas,
        (SELECT COUNT(*) FROM citas WHERE estado = 'reagendada') as citas_reagendadas,
        (SELECT COUNT(*) FROM mensajes_pendientes WHERE estado = 'pendiente') as mensajes_pendientes,
        (SELECT ROUND(AVG(calificacion), 1) FROM citas WHERE calificacion IS NOT NULL) as rating_promedio,
        (SELECT COUNT(*) FROM historial_mensajes WHERE leido = 0 AND remitente = 'paciente') as mensajes_no_leidos
    `, [hoyStr]);

    const citas = await dbAll(`
      SELECT c.*, p.nombre as paciente_nombre, p.telefono as paciente_telefono
      FROM citas c JOIN pacientes p ON c.paciente_id = p.id
      WHERE c.fecha >= ? AND c.estado != 'cancelada'
      ORDER BY c.fecha, c.hora LIMIT 10
    `, [hoyStr]);

    const pacientes = await dbAll(`SELECT * FROM pacientes ORDER BY creado_en DESC LIMIT 10`);

    const recordatoriosStats = await dbGet(`
      SELECT
        (SELECT COUNT(*) FROM mensajes_pendientes WHERE estado = 'pendiente') as pendientes,
        (SELECT COUNT(*) FROM mensajes_pendientes WHERE estado = 'enviado') as enviados,
        (SELECT COUNT(*) FROM mensajes_pendientes WHERE estado = 'fallido') as fallidos,
        (SELECT COUNT(*) FROM mensajes_pendientes WHERE tipo = 'recordatorio' AND estado = 'enviado') as recordatorios_enviados,
        (SELECT COUNT(*) FROM citas WHERE fecha = ? AND estado = 'confirmada') as citas_manana
    `, [mananaStr]);

    const waState = { status: waStatus, phone: waPhone, qr: waQr };
    res.render('dashboard', { stats, citas, pacientes, recordatoriosStats, waState });
  } catch (error) {
    console.error('Error dashboard:', error);
    res.status(500).send('Error cargando dashboard');
  }
});

// ─── Citas ────────────────────────────────────────────────────
app.get('/citas', async (req, res) => {
  try {
    const { estado, fecha_desde, fecha_hasta, buscar } = req.query;
    let sql = `SELECT c.*, p.nombre as paciente_nombre, p.telefono as paciente_telefono
               FROM citas c JOIN pacientes p ON c.paciente_id = p.id WHERE 1=1`;
    const params = [];
    if (estado) { sql += ` AND c.estado = ?`; params.push(estado); }
    if (fecha_desde) { sql += ` AND c.fecha >= ?`; params.push(fecha_desde); }
    if (fecha_hasta) { sql += ` AND c.fecha <= ?`; params.push(fecha_hasta); }
    if (buscar) { sql += ` AND (p.nombre LIKE ? OR p.telefono LIKE ? OR c.motivo LIKE ?)`; params.push(`%${buscar}%`, `%${buscar}%`, `%${buscar}%`); }
    sql += ` ORDER BY c.fecha DESC, c.hora DESC`;
    const citas = await dbAll(sql, params);
    res.render('citas', { citas, filtros: req.query });
  } catch (error) {
    console.error('Error citas:', error);
    res.status(500).send('Error cargando citas');
  }
});

app.get('/citas/nueva', async (req, res) => {
  try {
    const pacientes = await dbAll('SELECT * FROM pacientes ORDER BY nombre');
    res.render('cita-form', { pacientes, cita: null });
  } catch (error) { res.status(500).send('Error'); }
});

app.post('/citas/nueva', async (req, res) => {
  try {
    const { paciente_id, fecha, hora, motivo, estado, notas } = req.body;
    await dbRun(
      'INSERT INTO citas (paciente_id, fecha, hora, motivo, estado, notas) VALUES (?, ?, ?, ?, ?, ?)',
      [paciente_id, fecha, hora, motivo, estado || 'pendiente', notas || null]
    );
    res.redirect('/citas');
  } catch (error) { res.status(500).send('Error creando cita'); }
});

app.get('/citas/:id/editar', async (req, res) => {
  try {
    const cita = await dbGet('SELECT * FROM citas WHERE id = ?', [req.params.id]);
    const pacientes = await dbAll('SELECT * FROM pacientes ORDER BY nombre');
    res.render('cita-form', { pacientes, cita });
  } catch (error) { res.status(500).send('Error'); }
});

app.post('/citas/:id/editar', async (req, res) => {
  try {
    const { paciente_id, fecha, hora, motivo, estado, notas } = req.body;
    await dbRun(
      'UPDATE citas SET paciente_id = ?, fecha = ?, hora = ?, motivo = ?, estado = ?, notas = ? WHERE id = ?',
      [paciente_id, fecha, hora, motivo, estado, notas || null, req.params.id]
    );
    res.redirect('/citas');
  } catch (error) { res.status(500).send('Error actualizando cita'); }
});

app.post('/citas/:id/eliminar', async (req, res) => {
  try {
    await dbRun('DELETE FROM citas WHERE id = ?', [req.params.id]);
    res.redirect('/citas');
  } catch (error) { res.status(500).send('Error eliminando cita'); }
});

// ─── Exportar CSV ─────────────────────────────────────────────
app.get('/api/citas/exportar-csv', async (req, res) => {
  try {
    const citas = await dbAll(`
      SELECT c.id, p.nombre as paciente, p.telefono, c.fecha, c.hora, c.motivo, c.estado, c.calificacion, c.notas, c.creada_en
      FROM citas c JOIN pacientes p ON c.paciente_id = p.id
      ORDER BY c.fecha DESC, c.hora DESC
    `);

    let csv = 'ID,Paciente,Telefono,Fecha,Hora,Motivo,Estado,Calificacion,Notas,Creada En\n';
    citas.forEach(c => {
      const escapar = (v) => `"${String(v || '').replace(/"/g, '""')}"`;
      csv += `${c.id},${escapar(c.paciente)},${escapar(c.telefono)},${c.fecha},${c.hora},${escapar(c.motivo)},${c.estado},${c.calificacion || ''},${escapar(c.notas)},${c.creada_en}\n`;
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="citas-${new Date().toISOString().split('T')[0]}.csv"`);
    res.send('\uFEFF' + csv); // BOM para que Excel lo abra correctamente
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Pacientes ────────────────────────────────────────────────
app.get('/pacientes', async (req, res) => {
  try {
    const pacientes = await dbAll('SELECT * FROM pacientes ORDER BY nombre');
    res.render('pacientes', { pacientes });
  } catch (error) { res.status(500).send('Error'); }
});

app.get('/pacientes/nuevo', (req, res) => res.render('paciente-form', { paciente: null }));

app.post('/pacientes/nuevo', async (req, res) => {
  try {
    const { nombre, telefono } = req.body;
    const telFormateado = recordatorios.normalizarTelefono(telefono);
    await dbRun('INSERT INTO pacientes (nombre, telefono) VALUES (?, ?)', [nombre, telFormateado]);
    res.redirect('/pacientes');
  } catch (error) { res.status(500).send('Error creando paciente'); }
});

app.get('/pacientes/:id/editar', async (req, res) => {
  try {
    const paciente = await dbGet('SELECT * FROM pacientes WHERE id = ?', [req.params.id]);
    res.render('paciente-form', { paciente });
  } catch (error) { res.status(500).send('Error'); }
});

app.post('/pacientes/:id/editar', async (req, res) => {
  try {
    const { nombre, telefono } = req.body;
    const telFormateado = recordatorios.normalizarTelefono(telefono);
    await dbRun('UPDATE pacientes SET nombre = ?, telefono = ? WHERE id = ?', [nombre, telFormateado, req.params.id]);
    res.redirect('/pacientes');
  } catch (error) { res.status(500).send('Error actualizando paciente'); }
});

// ─── Mensajes ─────────────────────────────────────────────────
app.get('/mensajes', async (req, res) => {
  try {
    const mensajesPendientes = await dbAll(
      `SELECT mp.*, c.fecha as cita_fecha, c.hora as cita_hora, p.nombre as paciente_nombre
       FROM mensajes_pendientes mp
       LEFT JOIN citas c ON mp.cita_id = c.id
       LEFT JOIN pacientes p ON c.paciente_id = p.id
       ORDER BY mp.creado_en DESC LIMIT 50`
    );
    res.render('mensajes', { mensajesPendientes, success: false, message: '', error: '' });
  } catch (error) {
    res.render('mensajes', { mensajesPendientes: [], success: false, message: '', error: '' });
  }
});

app.post('/mensajes/enviar', async (req, res) => {
  try {
    const { telefono, mensaje } = req.body;
    const telFormateado = recordatorios.normalizarTelefono(telefono);
    const msgId = await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO mensajes_pendientes (telefono, mensaje, estado, tipo, intentos, creado_en)
         VALUES (?, ?, 'pendiente', 'manual', 0, datetime('now'))`,
        [telFormateado, mensaje],
        function (err) { if (err) reject(err); else resolve(this.lastID); }
      );
    });
    const resultado = await recordatorios.enviarMensaje(telFormateado, mensaje);
    await recordatorios.actualizarEstadoMensaje(msgId, resultado.success ? 'enviado' : 'fallido');
    const mensajesPendientes = await dbAll(
      `SELECT mp.*, c.fecha as cita_fecha, c.hora as cita_hora, p.nombre as paciente_nombre
       FROM mensajes_pendientes mp
       LEFT JOIN citas c ON mp.cita_id = c.id
       LEFT JOIN pacientes p ON c.paciente_id = p.id
       ORDER BY mp.creado_en DESC LIMIT 50`
    );
    res.render('mensajes', {
      success: resultado.success,
      message: resultado.success ? 'Mensaje enviado correctamente' : '',
      error: resultado.success ? '' : `Error: ${resultado.error}`,
      mensajesPendientes,
    });
  } catch (error) {
    res.render('mensajes', { success: false, message: '', error: error.message, mensajesPendientes: [] });
  }
});

app.post('/mensajes/:id/reintentar', async (req, res) => {
  try {
    const msg = await dbGet('SELECT * FROM mensajes_pendientes WHERE id = ?', [req.params.id]);
    if (!msg) return res.status(404).json({ error: 'Mensaje no encontrado' });
    const result = await recordatorios.enviarMensaje(msg.telefono, msg.mensaje);
    await recordatorios.actualizarEstadoMensaje(msg.id, result.success ? 'enviado' : 'fallido');
    res.json({ success: result.success, error: result.error || '' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Chat en Vivo ─────────────────────────────────────────────
app.get('/chat', async (req, res) => {
  try {
    const pacientes = await dbAll(`
      SELECT p.*,
        (SELECT mensaje FROM historial_mensajes WHERE telefono = p.telefono ORDER BY creado_en DESC LIMIT 1) as ultimo_mensaje,
        (SELECT creado_en FROM historial_mensajes WHERE telefono = p.telefono ORDER BY creado_en DESC LIMIT 1) as ultimo_mensaje_en,
        (SELECT COUNT(*) FROM historial_mensajes WHERE telefono = p.telefono AND leido = 0 AND remitente = 'paciente') as no_leidos
      FROM pacientes p ORDER BY ultimo_mensaje_en DESC
    `);
    res.render('chat', { pacientes });
  } catch (error) { res.status(500).send('Error'); }
});

app.get('/chat/historial/:telefono', async (req, res) => {
  try {
    const telFormateado = recordatorios.normalizarTelefono(req.params.telefono);
    const mensajes = await dbAll(
      'SELECT * FROM historial_mensajes WHERE telefono = ? ORDER BY creado_en ASC',
      [telFormateado]
    );
    // Marcar como leidos
    await dbRun(
      "UPDATE historial_mensajes SET leido = 1 WHERE telefono = ? AND remitente = 'paciente'",
      [telFormateado]
    );
    res.json(mensajes);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/chat/enviar', async (req, res) => {
  try {
    const { telefono, mensaje } = req.body;
    const telFormateado = recordatorios.normalizarTelefono(telefono);
    const msgId = await recordatorios.guardarMensajePendiente(telFormateado, mensaje, 'manual', null);
    const result = await recordatorios.enviarMensaje(telFormateado, mensaje, 'doctor');
    if (result.success) {
      await recordatorios.actualizarEstadoMensaje(msgId, 'enviado');
      res.json({ success: true });
    } else {
      await recordatorios.actualizarEstadoMensaje(msgId, 'fallido');
      res.json({ success: false, error: result.error });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Configuracion ────────────────────────────────────────────
app.get('/configuracion', async (req, res) => {
  try {
    const config = await dbGet('SELECT * FROM configuraciones LIMIT 1');
    res.render('configuracion', { config, success: false, message: '' });
  } catch (error) { res.status(500).send('Error'); }
});

app.post('/configuracion', async (req, res) => {
  try {
    const { dias_laborales, hora_inicio, hora_fin, duracion_cita, direccion, google_maps_url, indicaciones } = req.body;
    let diasStr = '[]';
    if (dias_laborales) {
      const arr = Array.isArray(dias_laborales) ? dias_laborales.map(Number) : [Number(dias_laborales)];
      diasStr = JSON.stringify(arr);
    }
    await dbRun(
      `UPDATE configuraciones SET dias_laborales=?, hora_inicio=?, hora_fin=?, duracion_cita=?, direccion=?, google_maps_url=?, indicaciones=?
       WHERE id = (SELECT id FROM configuraciones LIMIT 1)`,
      [diasStr, hora_inicio, hora_fin, parseInt(duracion_cita) || 60, direccion, google_maps_url, indicaciones]
    );
    const config = await dbGet('SELECT * FROM configuraciones LIMIT 1');
    res.render('configuracion', { config, success: true, message: 'Configuracion guardada correctamente.' });
  } catch (error) { res.status(500).send('Error guardando configuracion'); }
});

// ─── Analytics ────────────────────────────────────────────────
app.get('/analytics', async (req, res) => {
  try {
    res.render('analytics');
  } catch (error) { res.status(500).send('Error'); }
});

app.get('/api/analytics', async (req, res) => {
  try {
    // Citas por mes (ultimos 12 meses)
    const citasPorMes = await dbAll(`
      SELECT strftime('%Y-%m', fecha) as mes,
             COUNT(*) as total,
             SUM(CASE WHEN estado = 'confirmada' THEN 1 ELSE 0 END) as confirmadas,
             SUM(CASE WHEN estado = 'cancelada' THEN 1 ELSE 0 END) as canceladas
      FROM citas
      WHERE fecha >= date('now', '-12 months')
      GROUP BY mes ORDER BY mes ASC
    `);

    // Resumen general
    const resumen = await dbGet(`
      SELECT
        COUNT(*) as total_citas,
        SUM(CASE WHEN estado = 'confirmada' THEN 1 ELSE 0 END) as confirmadas,
        SUM(CASE WHEN estado = 'cancelada' THEN 1 ELSE 0 END) as canceladas,
        SUM(CASE WHEN estado = 'reagendada' THEN 1 ELSE 0 END) as reagendadas,
        ROUND(AVG(calificacion), 2) as rating_promedio,
        COUNT(DISTINCT paciente_id) as pacientes_atendidos
      FROM citas
    `);

    // Rating por mes
    const ratingPorMes = await dbAll(`
      SELECT strftime('%Y-%m', fecha) as mes, ROUND(AVG(calificacion), 2) as promedio, COUNT(calificacion) as cantidad
      FROM citas WHERE calificacion IS NOT NULL AND fecha >= date('now', '-12 months')
      GROUP BY mes ORDER BY mes ASC
    `);

    // Distribucion de calificaciones
    const distribCalificaciones = await dbAll(`
      SELECT calificacion, COUNT(*) as cantidad
      FROM citas WHERE calificacion IS NOT NULL
      GROUP BY calificacion ORDER BY calificacion
    `);

    // Top pacientes frecuentes
    const topPacientes = await dbAll(`
      SELECT p.nombre, p.telefono, COUNT(c.id) as total_citas,
             ROUND(AVG(c.calificacion), 1) as rating
      FROM pacientes p LEFT JOIN citas c ON p.id = c.paciente_id
      GROUP BY p.id ORDER BY total_citas DESC LIMIT 10
    `);

    // Citas por dia de semana
    const citasPorDia = await dbAll(`
      SELECT CASE strftime('%w', fecha)
        WHEN '0' THEN 'Dom' WHEN '1' THEN 'Lun' WHEN '2' THEN 'Mar'
        WHEN '3' THEN 'Mie' WHEN '4' THEN 'Jue' WHEN '5' THEN 'Vie' WHEN '6' THEN 'Sab'
      END as dia, COUNT(*) as total
      FROM citas GROUP BY strftime('%w', fecha) ORDER BY strftime('%w', fecha)
    `);

    res.json({ citasPorMes, resumen, ratingPorMes, distribCalificaciones, topPacientes, citasPorDia });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── API endpoints de estado y control ───────────────────────

app.get('/api/whatsapp/status', (req, res) => {
  res.json({
    connected: waStatus === 'conectado',
    status: waStatus,
    phone: waPhone,
    qr: waStatus === 'qr_listo' ? waQr : null,
    qrCode: waStatus === 'qr_listo' ? waQr : null,
  });
});

app.get('/api/chat/no-leidos', async (req, res) => {
  try {
    const row = await dbGet("SELECT COUNT(*) as count FROM historial_mensajes WHERE leido = 0 AND remitente = 'paciente'");
    res.json({ count: row ? row.count : 0 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/whatsapp/reconectar', async (req, res) => {
  try {
    reconectando = false;
    await inicializarWhatsApp();
    res.json({ success: true, message: 'Reiniciando conexion...' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/updates/live', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.push(res);
  // Enviar estado actual inmediatamente
  res.write(`event: wa_status\ndata: ${JSON.stringify({ status: waStatus, qr: waStatus === 'qr_listo' ? waQr : null, phone: waPhone })}\n\n`);
  console.log(`📡 SSE conectado. Total: ${sseClients.length}`);
  req.on('close', () => {
    sseClients = sseClients.filter(c => c !== res);
  });
});

app.get('/api/citas', async (req, res) => {
  try {
    const citas = await dbAll(`
      SELECT c.*, p.nombre as paciente_nombre, p.telefono as paciente_telefono
      FROM citas c JOIN pacientes p ON c.paciente_id = p.id
      ORDER BY c.fecha DESC, c.hora DESC
    `);
    res.json(citas);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/pacientes', async (req, res) => {
  try {
    const pacientes = await dbAll('SELECT * FROM pacientes ORDER BY nombre');
    res.json(pacientes);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/recordatorios/forzar', async (req, res) => {
  try {
    console.log('[Dashboard] Forzando envio de recordatorios...');

    // PASO 1: Enviar recordatorios de confirmacion 24h (para citas de manana a +7 dias)
    // Usa fechas locales para evitar desfase UTC/local
    console.log('[Dashboard] PASO 1: Enviando recordatorios de confirmacion 24h...');
    const recordatorios24h = await recordatorios.verificarYEnviarRecordatorios(true);
    console.log(`[Dashboard] PASO 1 completado: ${recordatorios24h} recordatorio(s) enviados.`);

    // PASO 2: Enviar avisos de 10min (SOLO para citas de HOY dentro de los proximos 20 min)
    // Si no hay citas en esa ventana, el resultado sera 0 (es correcto)
    console.log('[Dashboard] PASO 2: Revisando avisos urgentes de 10min para citas de hoy...');
    await new Promise(resolve => setTimeout(resolve, 1000)); // delay de 1s entre pasos
    const avisos10min = await recordatorios.verificarYEnviarAvisos10min(true);
    console.log(`[Dashboard] PASO 2 completado: ${avisos10min} aviso(s) de 10min enviados.`);

    res.json({
      success: true,
      recordatorios_24h_enviados: recordatorios24h,
      avisos_10min_enviados: avisos10min,
      total: recordatorios24h + avisos10min,
      mensaje: `${recordatorios24h} recordatorio(s) de confirmacion (24h) y ${avisos10min} aviso(s) urgentes (10min) enviados`
    });
  } catch (error) {
    console.error('[Dashboard] Error forzando recordatorios:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/recordatorios/reintentar', async (req, res) => {
  try {
    const resultado = await recordatorios.reintentarMensajesFallidos();
    res.json({ success: true, resultado });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/recordatorios/estado', async (req, res) => {
  try {
    const stats = await dbGet(`
      SELECT
        (SELECT COUNT(*) FROM mensajes_pendientes WHERE estado = 'pendiente') as pendientes,
        (SELECT COUNT(*) FROM mensajes_pendientes WHERE estado = 'enviado') as enviados,
        (SELECT COUNT(*) FROM mensajes_pendientes WHERE estado = 'fallido') as fallidos,
        (SELECT COUNT(*) FROM mensajes_pendientes WHERE tipo = 'recordatorio' AND estado = 'enviado') as recordatorios_enviados,
        (SELECT COUNT(*) FROM citas WHERE fecha = date('now', '+1 day') AND estado = 'confirmada') as citas_manana
    `);
    res.json(stats);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ─── Verificar si un número tiene WhatsApp ──────────────────
app.get('/api/whatsapp/check-number/:telefono', async (req, res) => {
  try {
    const client = getWaClient();
    if (!client || !client.info) {
      return res.json({ hasWhatsApp: null, error: 'WhatsApp no conectado' });
    }
    const telFormateado = recordatorios.normalizarTelefono(req.params.telefono);
    const numberId = await client.getNumberId(telFormateado);
    if (numberId) {
      return res.json({ hasWhatsApp: true, chatId: numberId._serialized });
    }
    // Intentar con prefijo alternativo para México
    if (telFormateado.startsWith('521')) {
      const telSin1 = '52' + telFormateado.substring(3);
      const numberId2 = await client.getNumberId(telSin1);
      if (numberId2) return res.json({ hasWhatsApp: true, chatId: numberId2._serialized });
    }
    return res.json({ hasWhatsApp: false });
  } catch (error) {
    res.json({ hasWhatsApp: null, error: error.message });
  }
});

// ─── Enviar mensaje de prueba al propio número ───────────────
app.post('/api/mensajes/test', async (req, res) => {
  try {
    const { telefono } = req.body;
    if (!telefono) return res.status(400).json({ error: 'Se requiere teléfono' });
    const telFormateado = recordatorios.normalizarTelefono(telefono);
    const mensaje = `🔔 *Mensaje de Prueba*\n\nEste es un mensaje de prueba del sistema de citas médicas.\n\n✅ Si recibes este mensaje, la conexión con WhatsApp está funcionando correctamente.\n\n🕐 Enviado: ${new Date().toLocaleString('es-MX')}`;
    const result = await recordatorios.enviarMensaje(telFormateado, mensaje, 'bot', true);
    res.json({ success: result.success, error: result.error || null, telefono: telFormateado });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Estado anti-spam del sistema ───────────────────────────
app.get('/api/sistema/estado', (req, res) => {
  const estaEnVentana = recordatorios.estaEnVentanaSegura ? recordatorios.estaEnVentanaSegura() : true;
  res.json({
    whatsapp: { connected: waStatus === 'conectado', status: waStatus, phone: waPhone },
    antispam: {
      ventanaSegura: estaEnVentana,
      horarioPermitido: '08:00 - 21:00',
      limiteDiario: 5,
    },
  });
});

// Webhook legacy (compatibilidad si algo lo usa)
app.post('/webhook/whatsapp', (req, res) => {
  res.status(200).json({ status: 'ok', note: 'Usando whatsapp-web.js directo, webhook no necesario' });
});

// ═══════════════════════════════════════════════════════════════
// MANEJO DE ERRORES Y APAGADO LIMPIO
// ═══════════════════════════════════════════════════════════════
process.on('uncaughtException', (error) => {
  console.error('❌ Error no capturado:', error);
});
process.on('unhandledRejection', (error) => {
  console.error('❌ Promesa rechazada:', error);
});

const apagarLimpio = async (signal) => {
  console.log(`\n⚠️ Recibido ${signal}. Cerrando el sistema ordenadamente...`);
  if (waClient) {
    try {
      console.log('🔌 Destruyendo cliente de WhatsApp...');
      await waClient.destroy();
      console.log('✅ Cliente de WhatsApp destruido.');
    } catch (e) {
      console.error('❌ Error destruyendo cliente de WhatsApp:', e.message);
    }
  }
  db.close((err) => {
    if (err) console.error('❌ Error cerrando la base de datos:', err.message);
    else console.log('💾 Base de datos SQLite cerrada.');
    process.exit(0);
  });
};

process.on('SIGINT', () => apagarLimpio('SIGINT'));
process.on('SIGTERM', () => apagarLimpio('SIGTERM'));

// ═══════════════════════════════════════════════════════════════
// ARRANQUE
// ═══════════════════════════════════════════════════════════════
app.listen(PORT, async () => {
  await inicializarBD();
  console.log('');
  console.log('╔═══════════════════════════════════════════╗');
  console.log('║   🏥 Sistema de Citas Medicas             ║');
  console.log(`║   🚀 http://localhost:${PORT}                ║`);
  console.log('╚═══════════════════════════════════════════╝');
  console.log(`📊 Dashboard:  http://localhost:${PORT}/dashboard`);
  console.log(`📅 Citas:      http://localhost:${PORT}/citas`);
  console.log(`👥 Pacientes:  http://localhost:${PORT}/pacientes`);
  console.log(`📈 Analytics:  http://localhost:${PORT}/analytics`);
  console.log(`💬 Chat:       http://localhost:${PORT}/chat`);
  console.log(`🔑 Login PIN:  ${DASHBOARD_PIN}`);
  console.log('');

  // Iniciar scheduler de recordatorios
  recordatorios.iniciarScheduler(1);

  // Inicializar WhatsApp (esperar 2s para que la BD este lista)
  setTimeout(() => inicializarWhatsApp(), 2000);
});
