const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./chatbot-citas.db');

db.run('CREATE TABLE IF NOT EXISTS mensajes_pendientes (id INTEGER PRIMARY KEY AUTOINCREMENT, telefono TEXT, mensaje TEXT, estado TEXT DEFAULT "pendiente", creado_en DATETIME DEFAULT CURRENT_TIMESTAMP, enviado_en DATETIME)', (err) => {
  if (err) {
    console.error('Error creando tabla:', err);
  } else {
    console.log('Tabla mensajes_pendientes creada exitosamente');
  }
  db.close();
});
