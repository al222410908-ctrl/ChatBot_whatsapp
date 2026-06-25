const axios = require('axios');

const API_KEY   = 'MiClaveSuperSecreta2026_WhatsApp';
const SESSION   = 'c685c60b-1933-4a51-b224-d25c0d5ead8f';
const BASE_URL  = 'http://localhost:2785/api';

async function enviar(chatId, texto) {
  const resp = await axios.post(
    `${BASE_URL}/sessions/${SESSION}/messages/send-text`,
    { chatId, text: texto },
    { headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY }, timeout: 30000 }
  );
  return resp.data;
}

(async () => {
  try {
    // --- Mensaje a María del Rocío (cita mañana) ---
    console.log('Enviando a María del Rocío...');
    const r1 = await enviar(
      '5215620788791@c.us',
      `🩺 *Recordatorio de Cita Médica*\n\nHola María del Rocío, te recordamos tu cita:\n\n📅 *Fecha:* 19/06/2026\n⏰ *Hora:* 10:20\n📝 *Motivo:* Cita de ortodoncia\n\nPor favor confirma tu asistencia respondiendo:\n1️⃣ *Si* - Confirmo mi asistencia\n2️⃣ *No* - No podré asistir\n3️⃣ *Reagendar* - Quiero otra fecha\n\n*Importante:* Confirma antes de 1 hora para evitar cancelaciones.`
    );
    console.log('✅ Enviado a María del Rocío! MessageId:', r1.messageId);
  } catch (err) {
    console.error('❌ Error:', err.response?.data || err.message);
  }
})();
