const axios = require('axios');

const API_KEY = 'MiClaveSuperSecreta2026_WhatsApp';
const SESSION_ID = 'c685c60b-1933-4a51-b224-d25c0d5ead8f';
const BASE_URL = 'http://localhost:2785/api';

// Datos de prueba - Cita médica
const citaPrueba = {
  paciente: 'Juan Pérez',
  telefono: '5215591065973', // Tu número de WhatsApp conectado
  fecha: '2026-06-17',
  hora: '10:00'
};

async function enviarRecordatorio(cita) {
  const chatId = `${cita.telefono}@c.us`;
  const mensaje = `
🏥 *Recordatorio de Cita Médica*

Hola ${cita.paciente},

Te recordamos tu cita para el:
📅 Fecha: ${cita.fecha}
⏰ Hora: ${cita.hora}

Por favor llegar 15 minutos antes.
Si no puedes asistir, avísanos con anticipación.

¡Gracias!
  `.trim();

  console.log('📤 Enviando recordatorio a:', cita.paciente);
  console.log('📱 Teléfono:', cita.telefono);
  console.log('💬 Mensaje:', mensaje);
  console.log('');

  try {
    const response = await axios.post(
      `${BASE_URL}/sessions/${SESSION_ID}/messages/send-text`,
      {
        chatId: chatId,
        text: mensaje
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': API_KEY
        }
      }
    );
    
    console.log('✅ Recordatorio enviado exitosamente!');
    console.log('📋 Respuesta:', response.data);
    return true;
  } catch (error) {
    console.error('❌ Error enviando recordatorio:');
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Data:', error.response.data);
    } else {
      console.error('Error:', error.message);
    }
    return false;
  }
}

// Ejecutar prueba
console.log('🚀 Iniciando prueba de recordatorio de cita médica...\n');
enviarRecordatorio(citaPrueba)
  .then(success => {
    if (success) {
      console.log('\n✨ Prueba completada exitosamente!');
    } else {
      console.log('\n❌ Prueba fallida');
    }
    process.exit(success ? 0 : 1);
  })
  .catch(error => {
    console.error('\n💥 Error inesperado:', error);
    process.exit(1);
  });
