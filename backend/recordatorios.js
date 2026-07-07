// recordatorios.js — Sistema de recordatorios automaticos
// Ahora usa whatsapp-web.js directamente (sin Docker, sin HTTP)
// ANTI-SPAM: delays, ventana horaria, variacion de plantillas, limite diario

// ─── Constantes Anti-Spam ────────────────────────────────────────
const HORA_INICIO_ENVIO = 8;   // No enviar antes de las 8:00 AM
const HORA_FIN_ENVIO    = 21;  // No enviar después de las 9:00 PM
const MAX_MENSAJES_POR_NUMERO_DIA = 5; // Límite diario por número
const DELAY_MIN_MS = 2000;     // Espera mínima entre mensajes: 2s
const DELAY_MAX_MS = 5000;     // Espera máxima entre mensajes: 5s

// Registro en memoria del conteo de mensajes enviados hoy por número
// Se reinicia al reiniciar el proceso (suficiente para uso diario en laptop)
const contadorMensajesDia = new Map();

let moduleDb = null;
let cachedConfig = null;

async function actualizarCacheConfig() {
  if (!moduleDb) return;
  return new Promise((resolve) => {
    moduleDb.get('SELECT * FROM configuraciones LIMIT 1', (err, row) => {
      if (!err && row) {
        cachedConfig = row;
      }
      resolve();
    });
  });
}

// ─── Delay aleatorio anti-spam ───────────────────────────────────
function delayAleatorio(minMs = DELAY_MIN_MS, maxMs = DELAY_MAX_MS) {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Verificar ventana horaria segura ───────────────────────────
function estaEnVentanaSegura() {
  const timeZone = process.env.TZ || 'America/Mexico_City';
  let ahoraLocal;
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    });
    const parts = formatter.formatToParts(new Date());
    const partsMap = {};
    for (const part of parts) {
      partsMap[part.type] = part.value;
    }
    const year = parseInt(partsMap.year);
    const month = parseInt(partsMap.month) - 1;
    const day = parseInt(partsMap.day);
    const hour = parseInt(partsMap.hour);
    const min = parseInt(partsMap.minute);

    const localDate = new Date(year, month, day, hour, min);
    ahoraLocal = {
      diaSemana: localDate.getDay(),
      hora,
      min
    };
  } catch (err) {
    const ahora = new Date();
    ahoraLocal = {
      diaSemana: ahora.getDay(),
      hora: ahora.getHours(),
      min: ahora.getMinutes()
    };
  }

  const { diaSemana, hora, min } = ahoraLocal;

  const config = cachedConfig;
  if (!config) {
    return hora >= HORA_INICIO_ENVIO && hora < HORA_FIN_ENVIO;
  }

  // 1. Verificar si hoy es un día laboral
  let diasLaborales = [];
  try {
    diasLaborales = JSON.parse(config.dias_laborales || '[]');
    if (Array.isArray(diasLaborales)) {
      diasLaborales = diasLaborales.map(Number);
    }
  } catch (e) {
    diasLaborales = [1, 2, 3, 4, 5];
  }
  if (!diasLaborales.includes(diaSemana)) {
    return false; // Hoy no se trabaja, envíos pausados
  }

  // 2. Verificar si estamos dentro del horario de atención
  const horaInicio = config.hora_inicio || '08:00';
  const horaFin = config.hora_fin || '21:00';

  const [hIni, mIni] = horaInicio.split(':').map(Number);
  const [hFin, mFin] = horaFin.split(':').map(Number);

  const minutosAhora = hora * 60 + min;
  const minutosInicio = hIni * 60 + mIni;
  const minutosFin = hFin * 60 + mFin;

  return minutosAhora >= minutosInicio && minutosAhora < minutosFin;
}

// ─── Verificar y registrar límite diario por número ─────────────
function verificarLimiteDiario(telefono, maxLimit = MAX_MENSAJES_POR_NUMERO_DIA) {
  // Resetear contadores a medianoche
  const hoyKey = new Date().toISOString().split('T')[0];
  const key = `${hoyKey}:${telefono}`;
  const conteo = contadorMensajesDia.get(key) || 0;
  if (conteo >= maxLimit) {
    console.warn(`⚠️ [ANTI-SPAM] Límite diario alcanzado para ${telefono} (${conteo} mensajes hoy, límite: ${maxLimit})`);
    return false;
  }
  contadorMensajesDia.set(key, conteo + 1);
  // Limpiar entradas de días anteriores periódicamente
  if (contadorMensajesDia.size > 10000) {
    for (const [k] of contadorMensajesDia) {
      if (!k.startsWith(hoyKey)) contadorMensajesDia.delete(k);
    }
  }
  return true;
}

// ─── Plantillas de recordatorio 24h (pide confirmación) ───────────────
// Nota: el mensaje de ubicación se envía SOLO cuando el paciente confirma.
// El aviso de 10min se envía automáticamente minutos antes de la cita.
const PLANTILLAS_RECORDATORIO = [
  (nombre, fecha, hora, lugar, motivo) => `🩺 *Recordatorio de Cita Médica*

Hola ${nombre}, te recordamos tu cita:

📅 *Fecha:* ${fecha}
⏰ *Hora:* ${hora}
📍 *Lugar:* ${lugar}
📝 *Motivo:* ${motivo || 'Consulta general'}

Por favor responde para confirmar tu asistencia:
1️⃣ *Confirmo mi asistencia*
2️⃣ *No podré asistir*
3️⃣ *Quiero otra fecha*

Puedes responder con el número o con tus propias palabras.`,

  (nombre, fecha, hora, lugar, motivo) => `🩺 *Recordatorio de Cita Médica*

Estimado/a ${nombre}, le recordamos su cita médica programada:

📅 *Fecha:* ${fecha}
⏰ *Hora:* ${hora}
📍 *Lugar:* ${lugar}
📝 *Motivo:* ${motivo || 'Consulta general'}

Por favor confirme su asistencia respondiendo:
1️⃣ *Confirmo mi asistencia*
2️⃣ *No podré asistir*
3️⃣ *Quiero otra fecha*

Puede responder con el número o con sus propias palabras.`,

  (nombre, fecha, hora, lugar, motivo) => `🩺 *Aviso de Cita Médica*

Hola ${nombre}, le informamos sobre su próxima consulta:

📅 *Fecha:* ${fecha}
⏰ *Hora:* ${hora}
📍 *Lugar:* ${lugar}
📝 *Motivo:* ${motivo || 'Consulta general'}

Por favor confirme su asistencia:
1️⃣ *Confirmo mi asistencia*
2️⃣ *No podré asistir*
3️⃣ *Quiero otra fecha*

Puede responder con el número o con sus propias palabras.`,
];

function elegirPlantillaAleatoria() {
  return PLANTILLAS_RECORDATORIO[Math.floor(Math.random() * PLANTILLAS_RECORDATORIO.length)];
}

function normalizarTelefono(telefono) {
  if (!telefono) return '';
  let limpio = telefono.replace(/\D/g, '');

  // Si empieza con 52 y tiene 12 dígitos: móvil México (52 + 10 dígitos) -> 521 + 10 dígitos
  if (limpio.startsWith('52') && limpio.length === 12) {
    limpio = '521' + limpio.substring(2);
  }
  // Si tiene 10 dígitos: agrega prefijo México 521
  else if (limpio.length === 10) {
    limpio = '521' + limpio;
  }

  return limpio;
}

function obtenerFechaLocal(d = new Date()) {
  const timeZone = process.env.TZ || 'America/Mexico_City';
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
    });
    const parts = formatter.formatToParts(d);
    const partsMap = {};
    for (const part of parts) {
      partsMap[part.type] = part.value;
    }
    const yyyy = partsMap.year;
    const mm = String(partsMap.month).padStart(2, '0');
    const dd = String(partsMap.day).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  } catch (err) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
}

/**
 * @param {object} db - Instancia de sqlite3.Database
 * @param {Function} getWaClient - Función que retorna el Client de whatsapp-web.js (puede ser null si no conectado)
 */
function crearSistemaRecordatorios(db, getWaClient) {
  const self = {};
  moduleDb = db;
  actualizarCacheConfig();

  const EventEmitter = require('events');
  self.emitter = new EventEmitter();

  // ─── Envío de mensaje WhatsApp via cliente local ──────────────
  self.enviarMensaje = async (telefono, texto, remitente = 'bot', omitirAntiSpam = false) => {
    try {
      const client = getWaClient();
      if (!client || !client.info) {
        return { success: false, error: 'WhatsApp no conectado' };
      }

      const telFormateado = normalizarTelefono(telefono);

      // ── Protecciones Anti-Spam (omitir solo en mensajes de respuesta inmediata) ──
      if (!omitirAntiSpam) {
        // 1. Ventana horaria segura
        if (!estaEnVentanaSegura()) {
          const hora = new Date().getHours();
          console.warn(`⚠️ [ANTI-SPAM] Fuera de horario (${hora}h). Mensaje a ${telFormateado} postergado.`);
          return { success: false, error: `Fuera de horario de envío (${HORA_INICIO_ENVIO}:00 - ${HORA_FIN_ENVIO}:00)` };
        }

        // 2. Límite diario por número
        const config = await new Promise((resolve) => {
          db.get('SELECT max_mensajes_dia FROM configuraciones LIMIT 1', (err, row) => {
            resolve(row);
          });
        });
        const maxLimit = config && config.max_mensajes_dia !== undefined && config.max_mensajes_dia !== null ? config.max_mensajes_dia : 15;

        if (!verificarLimiteDiario(telFormateado, maxLimit)) {
          return { success: false, error: `Límite diario de ${maxLimit} mensajes alcanzado para este número` };
        }

        // 3. Delay aleatorio anti-spam
        await delayAleatorio();
      }

      // Intentar resolver el ID correcto registrado en WhatsApp
      let chatId = null;

      // 1. Intentar resolver mapeo LID local
      const mapeoLid = await new Promise((resolve) => {
        db.get('SELECT lid FROM lid_mappings WHERE telefono = ?', [telFormateado], (err, row) => {
          resolve(row ? row.lid : null);
        });
      });

      if (mapeoLid) {
        chatId = `${mapeoLid}@lid`;
      } else if (telFormateado.length >= 14) {
        // Fallback para IDs crudos de tipo LID
        chatId = `${telFormateado}@lid`;
      }

      // 2. Si no es LID, resolver a c.us o intentar getNumberId
      if (!chatId) {
        chatId = `${telFormateado}@c.us`;
        try {
          const numberId = await client.getNumberId(telFormateado);
          if (numberId) {
            chatId = numberId._serialized;
            // Si el JID contiene 'lid', guardar el mapeo!
            if (chatId.includes('lid')) {
              const resolvedLid = chatId.replace(/@.*$/, '');
              db.run(
                'INSERT OR REPLACE INTO lid_mappings (lid, telefono) VALUES (?, ?)',
                [resolvedLid, telFormateado],
                (err) => {
                  if (err) console.error('❌ Error guardando mapeo LID:', err.message);
                  else console.log(`💾 Mapeo guardado en enviarMensaje: ${resolvedLid} -> ${telFormateado}`);
                }
              );
            }
          } else {
            // Si es un número de México y no se encontró con 521, intentar con 52
            if (telFormateado.startsWith('521') && telFormateado.length === 13) {
              const telSinUno = '52' + telFormateado.substring(3);
              const numberIdSinUno = await client.getNumberId(telSinUno);
              if (numberIdSinUno) {
                chatId = numberIdSinUno._serialized;
                // Si el JID contiene 'lid', guardar el mapeo!
                if (chatId.includes('lid')) {
                  const resolvedLid = chatId.replace(/@.*$/, '');
                  db.run(
                    'INSERT OR REPLACE INTO lid_mappings (lid, telefono) VALUES (?, ?)',
                    [resolvedLid, telFormateado],
                    (err) => {
                      if (err) console.error('❌ Error guardando mapeo LID:', err.message);
                      else console.log(`💾 Mapeo guardado en enviarMensaje (sin 1): ${resolvedLid} -> ${telFormateado}`);
                    }
                  );
                }
              }
            }
          }
        } catch (err) {
          console.error('Error resolviendo WhatsApp ID:', err.message);
        }
      }


      await client.sendMessage(chatId, texto);
      console.log(`✅ [WA] Mensaje enviado a ${telFormateado}`);
      return { success: true };
    } catch (error) {
      console.error(`❌ [WA] Error enviando a ${telefono}:`, error.message);
      return { success: false, error: error.message };
    }
  };

  // ─── Guardar mensaje pendiente en BD ─────────────────────────
  const guardarMensajePendiente = (telefono, mensaje, tipo, citaId) => {
    const telFormateado = normalizarTelefono(telefono);
    return new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO mensajes_pendientes (telefono, mensaje, estado, tipo, cita_id, intentos, creado_en)
         VALUES (?, ?, 'pendiente', ?, ?, 0, datetime('now'))`,
        [telFormateado, mensaje, tipo, citaId],
        function (err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });
  };

  // ─── Actualizar estado de mensaje por ID ─────────────────────
  const actualizarEstadoMensaje = (id, estado) => {
    return new Promise((resolve, reject) => {
      db.run(
        `UPDATE mensajes_pendientes
         SET estado = ?, enviado_en = datetime('now'), intentos = intentos + 1, ultimo_intento_en = datetime('now')
         WHERE id = ?`,
        [estado, id],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  };

  // ─── Enviar recordatorio para una cita ────────────────────
  // forzarEnvio: ignora anti-spam (para el boton 'Forzar' del dashboard)
  const enviarRecordatorio = async (cita, forzarEnvio = false) => {
    const config = await new Promise((resolve) => {
      db.get('SELECT * FROM configuraciones LIMIT 1', (err, row) => {
        resolve(row);
      });
    });
    const lugar = config ? config.direccion : 'Consultorio / Centro Medico';

    const plantilla = elegirPlantillaAleatoria();
    const mensaje = plantilla(
      cita.paciente_nombre,
      cita.fecha,
      cita.hora,
      lugar,
      cita.motivo
    );

    const msgId = await guardarMensajePendiente(
      cita.paciente_telefono,
      mensaje,
      'recordatorio',
      cita.id
    );

    // Si es forzado, omitir las protecciones anti-spam
    const result = await self.enviarMensaje(cita.paciente_telefono, mensaje, 'bot', forzarEnvio);

    if (result.success) {
      await actualizarEstadoMensaje(msgId, 'enviado');
      await new Promise((resolve, reject) => {
        db.run(
          `UPDATE citas SET recordatorio_enviado = 1 WHERE id = ?`,
          [cita.id],
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });
    } else {
      await actualizarEstadoMensaje(msgId, 'fallido');
      console.warn(`Recordatorio NO enviado para cita ${cita.id}: ${result.error}`);
    }

    return result.success;
  };

  // ─── Enviar recordatorio del mismo día ────────────────────────────
  const enviarRecordatorioHoy = async (cita, forzarEnvio = false) => {
    const config = await new Promise((resolve) => {
      db.get('SELECT * FROM configuraciones LIMIT 1', (err, row) => {
        resolve(row);
      });
    });
    const lugar = config ? config.direccion : 'Consultorio / Centro Medico';

    const mensaje = `🩺 *Recordatorio de tu Cita para Hoy*

Hola ${cita.paciente_nombre}, te recordamos tu cita programada para el día de hoy:

📅 *Fecha:* Hoy
⏰ *Hora:* ${cita.hora.substring(0, 5)}
📍 *Lugar:* ${lugar}
📝 *Motivo:* ${cita.motivo || 'Consulta general'}

${cita.estado === 'pendiente' ? 'Por favor confirma respondiendo:\n1️⃣ *Confirmar asistencia*\n2️⃣ *Cancelar*' : '¡Te esperamos puntualmente! 🩺'}`;

    const msgId = await guardarMensajePendiente(
      cita.paciente_telefono,
      mensaje,
      'recordatorio_hoy',
      cita.id
    );

    const result = await self.enviarMensaje(cita.paciente_telefono, mensaje, 'bot', forzarEnvio);

    if (result.success) {
      await actualizarEstadoMensaje(msgId, 'enviado');
      await new Promise((resolve, reject) => {
        db.run(
          `UPDATE citas SET recordatorio_hoy_enviado = 1 WHERE id = ?`,
          [cita.id],
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });
    } else {
      await actualizarEstadoMensaje(msgId, 'fallido');
      console.warn(`Recordatorio de hoy NO enviado para cita ${cita.id}: ${result.error}`);
    }

    return result.success;
  };


  // ─── Verificar y enviar recordatorios (24h antes) ──────────
  // forzar=true: ignora ventana horaria y marca recordatorio_enviado aunque ya este
  const verificarYEnviarRecordatorios = async (forzar = false) => {
    try {
      // Si no es forzado, respetar ventana horaria
      if (!forzar && !estaEnVentanaSegura()) {
        const hora = new Date().getHours();
        console.log(`[Recordatorios 24h] Fuera de ventana (${hora}h). Esperando ${HORA_INICIO_ENVIO}:00.`);
        return 0;
      }

      // Calcular la fecha de mañana en hora LOCAL (no UTC de SQLite)
      const manana = new Date();
      manana.setDate(manana.getDate() + 1);
      const fechaStr = obtenerFechaLocal(manana);

      // Si es forzado, buscar citas desde MAÑANA hasta +2 días usando fechas LOCALES
      // IMPORTANTE: Usar parámetros JS (no date('now') de SQLite) para evitar desfase UTC/local
      // Nunca incluir HOY para no solapar con el aviso de 10min
      let queryFecha;
      let queryParams;
      if (forzar) {
        // Calcular rango usando hora local de JavaScript (no SQLite UTC)
        // Buscamos citas de mañana (d+1) y del día siguiente (d+2), máximo 48 horas
        const d1 = new Date(); d1.setDate(d1.getDate() + 1);
        const d2 = new Date(); d2.setDate(d2.getDate() + 2);
        const fechaDesde = obtenerFechaLocal(d1);
        const fechaHasta = obtenerFechaLocal(d2);
        queryFecha = `c.fecha BETWEEN ? AND ?`;
        queryParams = [fechaDesde, fechaHasta];
        console.log(`[Recordatorios] MODO FORZADO: buscando citas desde ${fechaDesde} hasta ${fechaHasta}...`);
      } else {
        queryFecha = `c.fecha = ?`;
        queryParams = [fechaStr];
      }

      const citas = await new Promise((resolve, reject) => {
        // En modo forzado, ignorar el flag recordatorio_enviado para permitir reenvío
        const condicionEnviado = forzar
          ? '' // sin filtro: permitir reenviar aunque ya se haya enviado
          : 'AND (c.recordatorio_enviado IS NULL OR c.recordatorio_enviado = 0)';
        const sql = `SELECT c.*, p.nombre as paciente_nombre, p.telefono as paciente_telefono
           FROM citas c
           JOIN pacientes p ON c.paciente_id = p.id
           WHERE ${queryFecha}
           AND c.estado IN ('pendiente', 'reagendada')
           ${condicionEnviado}`;
        db.all(sql, queryParams, (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        });
      });

      if (citas.length === 0) {
        console.log(`[Recordatorios 24h] Sin citas para procesar. (Fecha referencia: ${fechaStr})`);
        return 0;
      }

      console.log(`[Recordatorios 24h] ${forzar ? 'FORZANDO' : 'Procesando'} ${citas.length} recordatorio(s)...`);

      let enviados = 0;
      for (const cita of citas) {
        console.log(`  -> Enviando recordatorio 24h a ${cita.paciente_nombre} (${cita.paciente_telefono}) - Cita: ${cita.fecha} ${cita.hora}`);
        // En modo forzado, omitir anti-spam para que siempre funcione
        const exito = await enviarRecordatorio(cita, forzar);
        if (exito) enviados++;
        // Delay entre recordatorios masivos
        if (citas.length > 1) {
          await delayAleatorio(forzar ? 1500 : 3000, forzar ? 3000 : 8000);
        }
      }

      console.log(`[Recordatorios 24h] ${enviados}/${citas.length} enviados exitosamente`);
      return enviados;
    } catch (error) {
      console.error('Error en recordatorios 24h:', error.message);
      return 0;
    }
  };

  // ─── Verificar y enviar recordatorios de hoy (mismo día) ─────
  const verificarYEnviarRecordatoriosHoy = async (forzar = false) => {
    try {
      if (!forzar && !estaEnVentanaSegura()) {
        const hora = new Date().getHours();
        console.log(`[Recordatorios Hoy] Fuera de ventana (${hora}h).`);
        return 0;
      }

      const hoyStr = obtenerFechaLocal(new Date());

      const citas = await new Promise((resolve, reject) => {
        const filtroEnviado = forzar ? '' : 'AND (c.recordatorio_hoy_enviado IS NULL OR c.recordatorio_hoy_enviado = 0)';
        const sql = `SELECT c.*, p.nombre as paciente_nombre, p.telefono as paciente_telefono
           FROM citas c
           JOIN pacientes p ON c.paciente_id = p.id
           WHERE c.fecha = ?
           AND c.estado IN ('pendiente', 'confirmada', 'reagendada')
           ${filtroEnviado}`;
        db.all(sql, [hoyStr], (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        });
      });

      if (citas.length === 0) {
        console.log(`[Recordatorios Hoy] Sin citas para procesar hoy. (Fecha: ${hoyStr})`);
        return 0;
      }

      console.log(`[Recordatorios Hoy] Procesando ${citas.length} recordatorio(s) para hoy...`);

      let enviados = 0;
      for (const cita of citas) {
        console.log(`  -> Enviando recordatorio de hoy a ${cita.paciente_nombre} (${cita.paciente_telefono}) - Cita: ${cita.hora}`);
        const exito = await enviarRecordatorioHoy(cita, forzar);
        if (exito) enviados++;
        if (citas.length > 1) {
          await delayAleatorio(1500, 3000);
        }
      }

      return enviados;
    } catch (error) {
      console.error('Error en recordatorios de hoy:', error.message);
      return 0;
    }
  };


  // ─── Verificar y enviar avisos de 10 minutos antes ──────────
  const verificarYEnviarAvisos10min = async (forzar = false) => {
    try {
      if (!forzar && !estaEnVentanaSegura()) return 0;

      const ahora = new Date();
      const hoyStr = obtenerFechaLocal(ahora);

      // Buscar citas de HOY que sean en los proximos 5 a 20 minutos
      // El scheduler corre cada 5 min, la ventana de 15 min cubre cualquier desfase
      const citasHoy = await new Promise((resolve, reject) => {
        db.all(
          `SELECT c.*, p.nombre as paciente_nombre, p.telefono as paciente_telefono
           FROM citas c
           JOIN pacientes p ON c.paciente_id = p.id
           WHERE c.fecha = ?
           AND c.estado IN ('pendiente', 'confirmada')
           AND (c.aviso_10min_enviado IS NULL OR c.aviso_10min_enviado = 0)`,
          [hoyStr],
          (err, rows) => { if (err) reject(err); else resolve(rows); }
        );
      });

      if (citasHoy.length === 0) return 0;

      let enviados = 0;
      for (const cita of citasHoy) {
        // Calcular cuántos minutos faltan para la cita (hora local)
        const citaDateTime = new Date(`${cita.fecha}T${cita.hora.substring(0, 5)}:00`);
        const minutosRestantes = (citaDateTime - ahora) / (1000 * 60);

        // ── Ventana automática: entre -2 y 15 minutos antes ──────────────────
        const enVentana = minutosRestantes >= -2 && minutosRestantes <= 15;

        // ── Ventana forzada: SOLO si la cita es en los próximos 20 minutos ──
        // IMPORTANTE: No enviar el aviso de 10min para citas que aún están lejos;
        // eso causaría que llegue ANTES que el recordatorio de confirmación 24h.
        const forzarEsta = forzar && minutosRestantes >= -30 && minutosRestantes <= 20;

        if (!enVentana && !forzarEsta) continue;

        console.log(`  -> Aviso 10min a ${cita.paciente_nombre} (${minutosRestantes.toFixed(0)} min para la cita de ${cita.hora})`);

        const config = await new Promise(resolve => {
          db.get('SELECT * FROM configuraciones LIMIT 1', (err, row) => resolve(row));
        });
        const lugar = config ? config.direccion : 'Consultorio';

        // Mensaje de aviso final — ya saben la ubicación, este es el recordatorio urgente
        const mensaje = `⏰ *Recordatorio — Tu cita es muy pronto*

Hola ${cita.paciente_nombre}, te recordamos que tu cita de hoy a las *${cita.hora.substring(0, 5)}* es en unos minutos.

📍 *Lugar:* ${lugar}
📝 *Motivo:* ${cita.motivo || 'Consulta general'}

¡Te esperamos puntualmente! 🩺`;

        const msgId = await guardarMensajePendiente(cita.paciente_telefono, mensaje, 'aviso_10min', cita.id);
        const result = await self.enviarMensaje(cita.paciente_telefono, mensaje, 'bot', true);

        if (result.success) {
          await actualizarEstadoMensaje(msgId, 'enviado');
          await new Promise((resolve, reject) => {
            db.run(`UPDATE citas SET aviso_10min_enviado = 1 WHERE id = ?`, [cita.id],
              err => { if (err) reject(err); else resolve(); });
          });
          enviados++;
          console.log(`✅ Aviso 10min enviado para cita ${cita.id}`);
        } else {
          await actualizarEstadoMensaje(msgId, 'fallido');
          console.warn(`⚠️ Aviso 10min FALLIDO para cita ${cita.id}: ${result.error}`);
        }
      }

      return enviados;
    } catch (error) {
      console.error('Error en avisos 10min:', error.message);
      return 0;
    }
  };

  // ─── Interpretar respuesta del paciente ──────────────────────
  const interpretarRespuesta = (texto) => {
    // Normalizar: minusculas, sin acentos, sin signos de puntuacion
    const r = texto.toLowerCase().trim();
    const sinAcentos = r
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // quitar acentos
      .replace(/[.,!?¿¡;:()]/g, '')  // quitar puntuación
      .trim();

    // 1. Detección directa por número (opciones del menú)
    if (r === '1' || sinAcentos === '1') return 'confirmar';
    if (r === '2' || sinAcentos === '2') return 'cancelar';
    if (r === '3' || sinAcentos === '3') return 'reagendar';

    // 2. Cancelar (hacer esta primero para atrapar frases negativas antes que un "si" parcial)
    const palabrasCancelar = [
      'no podre', 'no podré', 'no asistire', 'no asistiré',
      'no puedo', 'no ire', 'no iré', 'no voy',
      'cancela', 'cancelo', 'cancelar',
      'no asisto', 'no confirmo', 'no llego',
      'me es imposible', 'no me es posible',
      'no cuenten conmigo', 'no cuenten con migo'
    ];
    if (r === 'no' || sinAcentos === 'no' || /^no[\s,!.]/i.test(r)) {
      return 'cancelar';
    }
    for (const palabra of palabrasCancelar) {
      if (r.includes(palabra) || sinAcentos.includes(palabra.normalize('NFD').replace(/[\u0300-\u036f]/g, ''))) {
        return 'cancelar';
      }
    }

    // 3. Confirmar (amplio: detectar muchas formas naturales de confirmar)
    const palabrasConfirmar = [
      'confirmo', 'confirmar', 'confirmado', 'confirmada',
      'confirmo mi asistencia', 'confirmo asistencia',
      'asistire', 'asistiré', 'asisto', 'ahi estare', 'ahí estaré',
      'ahi voy', 'ahí voy', 'alla voy', 'allá voy',
      'claro que si', 'claro que sí', 'claro',
      'por supuesto', 'presente', 'listo', 'lista',
      'de acuerdo', 'perfecto', 'va', 'sale',
      'si voy', 'sí voy', 'si asisto', 'sí asisto',
      'si confirmo', 'si llego', 'cuenten conmigo',
      'ya mero llego', 'voy para alla', 'ahi nos vemos'
    ];
    // Detección directa: "si", "sí", "ok", "okay", "vale", "va", "sep", "simon", "simón", "nel" -> cancelar
    if (
      r === 'si' || r === 'sí' || r === 'ok' || r === 'okay' ||
      r === 'vale' || r === 'va' || r === 'sep' || r === 'sip' ||
      r === 'simon' || r === 'simón' || r === 'simon' ||
      r === 'dale' || r === 'bueno' || r === 'orale' || r === 'órale' ||
      /^s[ií][\s,!.]/i.test(r) || /^ok[ay]*[\s,!.]*$/i.test(r)
    ) {
      return 'confirmar';
    }
    for (const palabra of palabrasConfirmar) {
      if (r.includes(palabra) || sinAcentos.includes(palabra.normalize('NFD').replace(/[\u0300-\u036f]/g, ''))) {
        return 'confirmar';
      }
    }

    // 4. Reagendar
    const palabrasReagendar = [
      'reagendar', 'otra fecha', 'cambiar fecha', 'nueva fecha',
      'nueva cita', 'cambiar cita', 'otro dia', 'otro día',
      'otro horario', 'cambiar horario', 'mover cita',
      'podria ser otro dia', 'podría ser otro día'
    ];
    for (const palabra of palabrasReagendar) {
      if (r.includes(palabra) || sinAcentos.includes(palabra.normalize('NFD').replace(/[\u0300-\u036f]/g, ''))) {
        return 'reagendar';
      }
    }

    return 'desconocido';
  };

  // ─── Procesar respuesta a recordatorio ───────────────────────
  const procesarRespuestaRecordatorio = async (telefono, texto) => {
    const telFormateado = normalizarTelefono(telefono);
    const accion = interpretarRespuesta(texto);

    try {
      const mensajePendiente = await new Promise((resolve, reject) => {
        db.get(
          `SELECT mp.*, c.id as cita_id, c.fecha, c.hora, c.motivo, p.nombre as paciente_nombre, c.servicio_id, COALESCE(s.duracion, 60) as duracion, s.nombre as servicio_nombre
           FROM mensajes_pendientes mp
           JOIN citas c ON mp.cita_id = c.id
           JOIN pacientes p ON c.paciente_id = p.id
           LEFT JOIN servicios s ON c.servicio_id = s.id
           WHERE mp.tipo IN ('recordatorio', 'recordatorio_hoy')
           AND mp.estado IN ('enviado', 'pendiente')
           AND p.telefono = ?
           AND c.estado IN ('pendiente', 'confirmada')
           ORDER BY mp.creado_en DESC
           LIMIT 1`,
          [telFormateado],
          (err, row) => {
            if (err) reject(err);
            else resolve(row);
          }
        );
      });

      if (!mensajePendiente) {
        return { processed: false, reason: 'no_pending_reminder' };
      }

      const citaId = mensajePendiente.cita_id;

      if (accion === 'confirmar') {
        await new Promise((resolve, reject) => {
          db.run(
            `UPDATE citas SET estado = 'confirmada', confirmada_en = datetime('now') WHERE id = ?`,
            [citaId],
            (err) => { if (err) reject(err); else resolve(); }
          );
        });

        const config = await new Promise((resolve) => {
          db.get('SELECT * FROM configuraciones LIMIT 1', (err, row) => resolve(row));
        });

        // ── Mensaje 1: Confirmación de asistencia ───────────────────────────
        // Se envía PRIMERO: confirmación rápida sin abrumar con detalles
        await self.enviarMensaje(
          telefono,
          `✅ *Cita Confirmada*

Hola ${mensajePendiente.paciente_nombre.trim()}, tu cita del ${mensajePendiente.fecha} a las ${mensajePendiente.hora} ha sido *confirmada exitosamente*.

📝 Motivo: ${mensajePendiente.motivo || 'Consulta general'}

¡Perfecto! Te esperamos puntualmente. 🩺`,
          'bot',
          true
        );

        // ── Mensaje 2: Detalles de ubicación (2 segundos después) ───────────
        // Se envía SEPARADO para que el paciente lo reciba como un mensaje aparte
        await new Promise(resolve => setTimeout(resolve, 2000));
        if (config && (config.direccion || config.google_maps_url)) {
          const indicaciones = config.indicaciones ? `\n⚠️ *Indicaciones:* ${config.indicaciones}` : '';
          const mapa = config.google_maps_url ? `\n🗺️ *Mapa:* ${config.google_maps_url}` : '';
          await self.enviarMensaje(
            telefono,
            `📍 *Ubicación del Consultorio:*
${config.direccion}${mapa}${indicaciones}`,
            'bot',
            true
          );
        }

        console.log(`✅ Cita ${citaId} CONFIRMADA por ${telefono}`);
        
        self.notificarAlDoctor('confirmacion', {
          nombre: mensajePendiente.paciente_nombre,
          telefono: telefono,
          fecha: mensajePendiente.fecha,
          hora: mensajePendiente.hora,
          motivo: mensajePendiente.motivo
        }).catch(err => console.error('Error enviando notificación al doctor:', err));

        self.emitter.emit('cita_actualizada', { action: 'confirmed', citaId });
        return { processed: true, action: 'confirmed', citaId };

      } else if (accion === 'cancelar') {
        await new Promise((resolve, reject) => {
          db.run(
            `UPDATE citas SET estado = 'cancelada' WHERE id = ?`,
            [citaId],
            (err) => { if (err) reject(err); else resolve(); }
          );
        });

        await self.enviarMensaje(
          telefono,
          `❌ *Cita Cancelada*

Hola ${mensajePendiente.paciente_nombre.trim()}, hemos cancelado tu cita del ${mensajePendiente.fecha} a las ${mensajePendiente.hora}.

Si deseas agendar una nueva cita, responde *"cita"* o *"agendar"* y te ayudaremos.`,
          'bot',
          true
        );

        console.log(`❌ Cita ${citaId} CANCELADA por ${telefono}`);
        
        self.notificarAlDoctor('cancelacion', {
          nombre: mensajePendiente.paciente_nombre,
          telefono: telefono,
          fecha: mensajePendiente.fecha,
          hora: mensajePendiente.hora,
          motivo: mensajePendiente.motivo
        }).catch(err => console.error('Error enviando notificación al doctor:', err));

        self.emitter.emit('cita_actualizada', { action: 'cancelled', citaId });
        return { processed: true, action: 'cancelled', citaId };

      } else if (accion === 'reagendar') {
        const duracionOriginal = mensajePendiente.duracion || 60;
        const diasDisponibles = await obtenerProximosDiasDisponibles(7, duracionOriginal);
        await new Promise((resolve, reject) => {
          db.run(
            `INSERT OR REPLACE INTO conversaciones (telefono, estado, datos, actualizado_en)
             VALUES (?, 'reagendando_fecha', ?, datetime('now'))`,
            [telefono, JSON.stringify({
              citaOriginalId: citaId,
              nombre: mensajePendiente.paciente_nombre,
              motivo: mensajePendiente.motivo,
              servicioId: mensajePendiente.servicio_id,
              duracion: duracionOriginal,
              fechasSugeridas: diasDisponibles.map(d => d.fechaISO)
            })],
            (err) => { if (err) reject(err); else resolve(); }
          );
        });

        let msg = `🔄 *Reagendar Cita*\n\nHola ${mensajePendiente.paciente_nombre.trim()}, vamos a agendar una nueva cita para reemplazar la del ${mensajePendiente.fecha} a las ${mensajePendiente.hora.substring(0, 5)}.\n\n📅 ¿Para qué fecha deseas tu nueva cita?\nEscribe la fecha en formato *DD/MM/YYYY* (ej: 20/06/2026), di algo como *"mañana"* o *"el lunes"*, o responde con el *número* de una opción sugerida:\n\n`;
        const emojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣'];
        diasDisponibles.forEach((dia, idx) => {
          const emoji = emojis[idx] || `${idx + 1}.`;
          msg += `${emoji} *${dia.diaNombre} ${dia.fechaDisplay}* (${dia.slotsCount} horarios)\n`;
        });

        await self.enviarMensaje(telefono, msg, 'bot', true);

        console.log(`🔄 Cita ${citaId} en proceso de REAGENDAMIENTO por ${telefono}`);
        return { processed: true, action: 'rescheduling', citaId };

      } else {
        await self.enviarMensaje(
          telefono,
          `🤔 No entendí tu respuesta.

Por favor responde con una opción:
1️⃣ *Confirmo mi asistencia*
2️⃣ *No podré asistir*
3️⃣ *Quiero otra fecha*

Puedes responder con el número o con tus propias palabras.`,
          'bot',
          true
        );
        return { processed: true, action: 'unrecognized' };
      }
    } catch (error) {
      console.error('❌ Error procesando respuesta:', error.message);
      return { processed: false, reason: 'error', error: error.message };
    }
  };

  // ─── Reintentar todos los mensajes fallidos/pendientes ───────
  const reintentarMensajesFallidos = async () => {
    try {
      // Respetar ventana horaria en reintentos masivos
      if (!estaEnVentanaSegura()) {
        console.log('🕐 [Reintentos] Fuera de ventana horaria segura. Posponiendo reintentos.');
        return { reintentados: 0, exitosos: 0 };
      }

      const pendientes = await new Promise((resolve, reject) => {
        db.all(
          `SELECT mp.*, p.nombre as paciente_nombre
           FROM mensajes_pendientes mp
           LEFT JOIN citas c ON mp.cita_id = c.id
           LEFT JOIN pacientes p ON c.paciente_id = p.id
           WHERE mp.estado IN ('pendiente', 'fallido')
           AND mp.intentos < 5
           AND mp.creado_en >= datetime('now', '-1 day')
           ORDER BY mp.creado_en ASC`,
          (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
          }
        );
      });

      if (pendientes.length === 0) {
        return { reintentados: 0, exitosos: 0 };
      }

      console.log(`🔄 [Reintentos] Reintentando ${pendientes.length} mensaje(s)...`);
      let reenviados = 0;

      for (const msg of pendientes) {
        const telefonoDestino = msg.telefono;
        const textoMensaje = msg.mensaje;
        if (!textoMensaje || !telefonoDestino) continue;

        if (msg.tipo === 'recordatorio' && msg.cita_id) {
          const cita = await new Promise((resolve, reject) => {
            db.get(
              `SELECT c.*, p.nombre as paciente_nombre, p.telefono as paciente_telefono
               FROM citas c JOIN pacientes p ON c.paciente_id = p.id WHERE c.id = ?`,
              [msg.cita_id],
              (err, row) => { if (err) reject(err); else resolve(row); }
            );
          });
          if (cita && (cita.estado === 'pendiente' || cita.estado === 'reagendada')) {
            const exito = await enviarRecordatorio(cita);
            if (exito) reenviados++;
          } else {
            // Si la cita ya está confirmada o cancelada, marcar el mensaje pendiente como obsoleto
            await actualizarEstadoMensaje(msg.id, 'obsoleto');
          }
        } else {
          const result = await self.enviarMensaje(telefonoDestino, textoMensaje, 'bot', false);
          await actualizarEstadoMensaje(msg.id, result.success ? 'enviado' : 'fallido');
          if (result.success) reenviados++;
        }

        // Delay entre reintentos
        if (pendientes.length > 1) {
          await delayAleatorio(3000, 7000);
        }
      }

      console.log(`🔄 Reintento: ${reenviados}/${pendientes.length} mensajes reenviados`);
      return { reintentados: pendientes.length, exitosos: reenviados };
    } catch (error) {
      console.error('❌ Error reintentando mensajes:', error.message);
      return { reintentados: 0, exitosos: 0, error: error.message };
    }
  };

  // ─── Obtener horarios disponibles para una fecha ─────────────
  const obtenerHorariosDisponibles = async (fecha, duracionCitaOverride = null) => {
    const config = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM configuraciones LIMIT 1', (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    if (!config) return [];

    const dateObj = new Date(fecha + 'T00:00:00');
    const diaSemana = dateObj.getDay();
    let diasLaborales = [];
    try {
      diasLaborales = JSON.parse(config.dias_laborales || '[]');
      if (Array.isArray(diasLaborales)) {
        diasLaborales = diasLaborales.map(Number);
      }
    } catch (e) {
      diasLaborales = [1, 2, 3, 4, 5];
    }
    if (!diasLaborales.includes(diaSemana)) return [];

    // Consultar bloqueos de la agenda
    const bloqueos = await new Promise((resolve, reject) => {
      db.all(
        `SELECT * FROM bloqueos_agenda WHERE fecha = ?`,
        [fecha],
        (err, rows) => { if (err) reject(err); else resolve(rows || []); }
      );
    });

    const bloqueoDiaCompleto = bloqueos.find(b => !b.hora_inicio && !b.hora_fin);
    if (bloqueoDiaCompleto) return [];

    // Consultar citas agendadas con su duración de servicio real
    const citas = await new Promise((resolve, reject) => {
      db.all(
        `SELECT c.hora, COALESCE(s.duracion, 60) as duracion
         FROM citas c
         LEFT JOIN servicios s ON c.servicio_id = s.id
         WHERE c.fecha = ? AND c.estado NOT IN ('cancelada', 'reagendada')`,
        [fecha],
        (err, rows) => { if (err) reject(err); else resolve(rows || []); }
      );
    });

    const parseTime = (timeStr) => {
      const [h, m] = timeStr.split(':').map(Number);
      return new Date(2020, 0, 1, h, m);
    };

    const ocupados = [];
    // 1. Añadir citas
    for (const c of citas) {
      const start = parseTime(c.hora.substring(0, 5));
      const end = new Date(start.getTime() + c.duracion * 60 * 1000);
      ocupados.push({ start, end });
    }
    // 2. Añadir bloqueos de rango de horas
    for (const b of bloqueos) {
      if (b.hora_inicio && b.hora_fin) {
        const start = parseTime(b.hora_inicio);
        const end = parseTime(b.hora_fin);
        ocupados.push({ start, end });
      }
    }

    const slots = [];
    let [hInicio, mInicio] = config.hora_inicio.split(':').map(Number);
    const [hFin, mFin] = config.hora_fin.split(':').map(Number);
    const duracion = duracionCitaOverride !== null ? Number(duracionCitaOverride) : (config.duracion_cita || 60);

    let actual = new Date(2020, 0, 1, hInicio, mInicio);
    const limite = new Date(2020, 0, 1, hFin, mFin);

    let recesoStart = null;
    let recesoEnd = null;
    if (config.receso_inicio && config.receso_fin) {
      const [rhIn, rmIn] = config.receso_inicio.split(':').map(Number);
      const [rhFin, rmFin] = config.receso_fin.split(':').map(Number);
      recesoStart = new Date(2020, 0, 1, rhIn, rmIn);
      recesoEnd = new Date(2020, 0, 1, rhFin, rmFin);
    }

    while (actual < limite) {
      const slotStart = new Date(actual.getTime());
      const slotEnd = new Date(actual.getTime() + duracion * 60 * 1000);

      let enReceso = false;
      if (recesoStart && recesoEnd) {
        if (slotStart < recesoEnd && slotEnd > recesoStart) {
          enReceso = true;
        }
      }

      let colisiona = false;
      for (const o of ocupados) {
        if (slotStart < o.end && slotEnd > o.start) {
          colisiona = true;
          break;
        }
      }

      const hh = String(actual.getHours()).padStart(2, '0');
      const mm = String(actual.getMinutes()).padStart(2, '0');
      const horaStr = `${hh}:${mm}`;

      if (!enReceso && !colisiona) {
        slots.push(horaStr);
      }
      actual.setMinutes(actual.getMinutes() + duracion);
    }

    const hoyStr = obtenerFechaLocal();
    if (fecha === hoyStr) {
      const ahora = new Date();
      const horaActualStr = `${String(ahora.getHours()).padStart(2, '0')}:${String(ahora.getMinutes()).padStart(2, '0')}`;
      return slots.filter(slot => slot > horaActualStr);
    }

    return slots;
  };

  // ─── Obtener los próximos días disponibles con slots ─────────
  const obtenerProximosDiasDisponibles = async (cantidad = 5, duracionCitaOverride = null) => {
    const dias = [];
    const hoy = new Date();
    // Revisar próximos 14 días para encontrar días con slots disponibles
    for (let i = 0; i < 14; i++) {
      const d = new Date();
      d.setDate(hoy.getDate() + i);
      const fechaISO = obtenerFechaLocal(d);
      const slots = await obtenerHorariosDisponibles(fechaISO);
      if (slots.length > 0) {
        const nombreDia = d.toLocaleDateString('es-ES', { weekday: 'long' });
        const diaNombre = nombreDia.charAt(0).toUpperCase() + nombreDia.slice(1);
        dias.push({
          fechaISO,
          fechaDisplay: `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`,
          diaNombre,
          slotsCount: slots.length,
        });
        if (dias.length >= cantidad) break;
      }
    }
    return dias;
  };

  // ─── Verificar y enviar encuestas de satisfacción ────────────
  const verificarYEnviarEncuestas = async () => {
    try {
      // Respetar ventana horaria
      if (!estaEnVentanaSegura()) return 0;

      const hoy = new Date();
      const fechaHoyStr = obtenerFechaLocal(hoy);

      const citas = await new Promise((resolve, reject) => {
        db.all(
          `SELECT c.*, p.nombre as paciente_nombre, p.telefono as paciente_telefono
           FROM citas c
           JOIN pacientes p ON c.paciente_id = p.id
           WHERE c.estado = 'confirmada'
           AND (c.encuesta_enviada IS NULL OR c.encuesta_enviada = 0)
           AND c.fecha = ?`,
          [fechaHoyStr],
          (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
          }
        );
      });

      let enviadas = 0;
      for (const cita of citas) {
        // Verificar que la hora de la cita + 2h ya haya pasado
        const citaDateTime = new Date(`${cita.fecha}T${cita.hora}:00`);
        const dosHorasDespues = new Date(citaDateTime.getTime() + 2 * 60 * 60 * 1000);

        if (hoy < dosHorasDespues) continue;

        const mensajeEncuesta = `⭐ *Encuesta de Satisfacción*\n\nHola ${cita.paciente_nombre}, agradecemos tu confianza al atenderte hoy.\n\nPara seguir mejorando, por favor califica tu experiencia del 1 al 5:\n\n5 — Excelente\n4 — Muy bueno\n3 — Bueno\n2 — Regular\n1 — Deficiente\n\nResponde con el número de tu calificación. ¡Tu opinión nos importa mucho! 🩺`;

        const msgId = await guardarMensajePendiente(
          cita.paciente_telefono,
          mensajeEncuesta,
          'encuesta',
          cita.id
        );

        await new Promise((resolve, reject) => {
          db.run(
            `INSERT OR REPLACE INTO conversaciones (telefono, estado, datos, actualizado_en)
             VALUES (?, 'esperando_encuesta', ?, datetime('now'))`,
            [cita.paciente_telefono, JSON.stringify({ citaId: cita.id, nombre: cita.paciente_nombre })],
            (err) => { if (err) reject(err); else resolve(); }
          );
        });

        const result = await self.enviarMensaje(cita.paciente_telefono, mensajeEncuesta, 'bot', false);

        if (result.success) {
          await actualizarEstadoMensaje(msgId, 'enviado');
          await new Promise((resolve, reject) => {
            db.run(
              `UPDATE citas SET encuesta_enviada = 1 WHERE id = ?`,
              [cita.id],
              (err) => { if (err) reject(err); else resolve(); }
            );
          });
          enviadas++;
          console.log(`⭐ Encuesta enviada para cita ${cita.id} de ${cita.paciente_nombre}`);
          // Delay entre encuestas
          if (citas.length > 1) await delayAleatorio(3000, 6000);
        } else {
          await actualizarEstadoMensaje(msgId, 'fallido');
        }
      }

      if (enviadas > 0) console.log(`📊 Encuestas enviadas: ${enviadas}/${citas.length}`);
      return enviadas;
    } catch (error) {
      console.error('❌ Error en encuestas:', error.message);
      return 0;
    }
  };

  // ─── Enviar notificación al WhatsApp del doctor ─────────────
  const notificarAlDoctor = async (tipo, info) => {
    try {
      const config = await new Promise((resolve) => {
        db.get('SELECT telefono_doctor FROM configuraciones LIMIT 1', (err, row) => {
          resolve(row);
        });
      });

      if (!config || !config.telefono_doctor) {
        return { success: false, error: 'No doctor phone configured' };
      }

      const telDoctor = normalizarTelefono(config.telefono_doctor);
      if (!telDoctor) return { success: false, error: 'Invalid doctor phone' };

      let mensaje = '';
      const formattedTelPaciente = info.telefono ? normalizarTelefono(info.telefono) : '';

      switch (tipo) {
        case 'creacion':
          mensaje = `🔔 *Nueva Cita Agendada*\n\nEl paciente *${info.nombre}* ha agendado una cita:\n\n📅 *Fecha:* ${info.fecha}\n⏰ *Hora:* ${info.hora.substring(0, 5)} hrs\n📝 *Motivo:* ${info.motivo || 'Consulta general'}\n📱 *Teléfono:* +${formattedTelPaciente}`;
          break;
        case 'confirmacion':
          mensaje = `✅ *Cita Confirmada*\n\nEl paciente *${info.nombre}* ha confirmado su asistencia para su cita:\n\n📅 *Fecha:* ${info.fecha}\n⏰ *Hora:* ${info.hora.substring(0, 5)} hrs\n📝 *Motivo:* ${info.motivo || 'Consulta general'}\n📱 *Teléfono:* +${formattedTelPaciente}`;
          break;
        case 'cancelacion':
          mensaje = `⚠️ *Cita Cancelada*\n\nEl paciente *${info.nombre}* ha cancelado su cita:\n\n📅 *Fecha:* ${info.fecha}\n⏰ *Hora:* ${info.hora.substring(0, 5)} hrs\n📝 *Motivo:* ${info.motivo || 'Consulta general'}\n📱 *Teléfono:* +${formattedTelPaciente}`;
          break;
        case 'reagendamiento':
          mensaje = `🔄 *Cita Reagendada*\n\nEl paciente *${info.nombre}* ha reagendado su cita:\n\n📅 *Nueva Fecha:* ${info.fecha}\n⏰ *Nueva Hora:* ${info.hora.substring(0, 5)} hrs\n📝 *Motivo:* ${info.motivo || 'Consulta general'}\n📱 *Teléfono:* +${formattedTelPaciente}`;
          break;
        default:
          return { success: false, error: 'Unknown notification type' };
      }

      // omitirAntiSpam = true para asegurar que el doctor reciba sus notificaciones de inmediato
      const result = await self.enviarMensaje(telDoctor, mensaje, 'bot', true);
      if (result.success) {
        console.log(`✉️ [Notificación Doctor] Mensaje de tipo '${tipo}' enviado al doctor (+${telDoctor})`);
      } else {
        console.warn(`⚠️ [Notificación Doctor] Falló el envío al doctor (+${telDoctor}): ${result.error}`);
      }
      return result;
    } catch (err) {
      console.error('❌ Error en notificarAlDoctor:', err.message);
      return { success: false, error: err.message };
    }
  };

  // ─── Iniciar scheduler automático ────────────────────────────
  const iniciarScheduler = (intervaloHoras = 1) => {
    console.log(`Sistema de recordatorios iniciado (24h: cada ${intervaloHoras}h | 10min: cada 5min | ventana ${HORA_INICIO_ENVIO}:00-${HORA_FIN_ENVIO}:00)`);

    // Esperar a que WhatsApp se conecte antes del primer chequeo
    setTimeout(() => {
      verificarYEnviarRecordatorios();
      verificarYEnviarEncuestas();
      verificarYEnviarAvisos10min();
    }, 20000);

    // Recordatorios 24h: cada 1 hora (o el intervalo configurado)
    setInterval(verificarYEnviarRecordatorios, intervaloHoras * 60 * 60 * 1000);

    // Avisos 10min: cada 5 minutos (CRITICO para no perder la ventana)
    setInterval(verificarYEnviarAvisos10min, 5 * 60 * 1000);

    // Encuestas: cada 30 minutos
    setInterval(verificarYEnviarEncuestas, 30 * 60 * 1000);

    // Reintentos: cada 45 minutos
    setInterval(reintentarMensajesFallidos, 45 * 60 * 1000);
  };

  self.enviarRecordatorio = enviarRecordatorio;
  self.enviarRecordatorioHoy = enviarRecordatorioHoy;
  self.verificarYEnviarRecordatorios = verificarYEnviarRecordatorios;
  self.verificarYEnviarRecordatoriosHoy = verificarYEnviarRecordatoriosHoy;
  self.verificarYEnviarAvisos10min = verificarYEnviarAvisos10min;
  self.procesarRespuestaRecordatorio = procesarRespuestaRecordatorio;
  self.iniciarScheduler = iniciarScheduler;
  self.reintentarMensajesFallidos = reintentarMensajesFallidos;
  self.guardarMensajePendiente = guardarMensajePendiente;
  self.actualizarEstadoMensaje = actualizarEstadoMensaje;
  self.interpretarRespuesta = interpretarRespuesta;
  self.normalizarTelefono = normalizarTelefono;
  self.obtenerHorariosDisponibles = obtenerHorariosDisponibles;
  self.obtenerProximosDiasDisponibles = obtenerProximosDiasDisponibles;
  self.verificarYEnviarEncuestas = verificarYEnviarEncuestas;
  self.estaEnVentanaSegura = estaEnVentanaSegura;
  self.actualizarCacheConfig = actualizarCacheConfig;
  self.delayAleatorio = delayAleatorio;
  self.notificarAlDoctor = notificarAlDoctor;

  return self;
}

module.exports = { crearSistemaRecordatorios };
