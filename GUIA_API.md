# Guía Completa para Usar la API de OpenWA

## 📋 Tabla de Contenidos
1. [Configuración Inicial](#configuración-inicial)
2. [Crear una Sesión de WhatsApp](#crear-una-sesión-de-whatsapp)
3. [Escanear el Código QR](#escanear-el-código-qr)
4. [Enviar Mensajes](#enviar-mensajes)
5. [Configurar Webhooks](#configurar-webhooks)
6. [Ejemplos Prácticos](#ejemplos-prácticos)

---

## 🔑 Configuración Inicial

### Tu API Key
```
owa_k1_1ea34d8c6d9c5797424ead6af83b101201a58b46ac242d526b01a2b13be351ad
```

### URLs de la API
- **Base URL**: `http://localhost:2785/api`
- **Swagger Docs**: `http://localhost:2785/api/docs`
- **Dashboard**: `http://localhost:2886`

### Headers Requeridos
```http
Content-Type: application/json
X-API-Key: owa_k1_1ea34d8c6d9c5797424ead6af83b101201a58b46ac242d526b01a2b13be351ad
```

---

## 📱 Crear una Sesión de WhatsApp

### Paso 1: Crear la Sesión
```bash
curl -X POST http://localhost:2785/api/sessions \
  -H "Content-Type: application/json" \
  -H "X-API-Key: owa_k1_1ea34d8c6d9c5797424ead6af83b101201a58b46ac242d526b01a2b13be351ad" \
  -d '{
    "name": "mi-bot-whatsapp"
  }'
```

**Respuesta esperada:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "mi-bot-whatsapp",
  "status": "INITIALIZING",
  "createdAt": "2026-06-16T21:47:59.000Z"
}
```

**Guarda el `id` de la sesión** (lo necesitarás para los siguientes pasos).

---

## 📷 Escanear el Código QR

### Paso 2: Iniciar la Sesión
```bash
curl -X POST http://localhost:2785/api/sessions/{SESSION_ID}/start \
  -H "X-API-Key: owa_k1_1ea34d8c6d9c5797424ead6af83b101201a58b46ac242d526b01a2b13be351ad"
```

Reemplaza `{SESSION_ID}` con el ID que obtuviste en el paso anterior.

### Paso 3: Obtener el Código QR
```bash
curl http://localhost:2785/api/sessions/{SESSION_ID}/qr \
  -H "X-API-Key: owa_k1_1ea34d8c6d9c5797424ead6af83b101201a58b46ac242d526b01a2b13be351ad"
```

**Respuesta:**
```json
{
  "qr": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA..."
}
```

### Paso 4: Escanear el QR
1. Copia el contenido de `qr` (es una imagen en base64)
2. Pégalo en la barra de dirección de tu navegador
3. Escanea el código QR con WhatsApp en tu teléfono
   - Abre WhatsApp → Configuración → Aparatos vinculados → Vincular un aparato

### Paso 5: Verificar Estado
```bash
curl http://localhost:2785/api/sessions/{SESSION_ID}/status \
  -H "X-API-Key: owa_k1_1ea34d8c6d9c5797424ead6af83b101201a58b46ac242d526b01a2b13be351ad"
```

Cuando el estado sea `READY`, tu sesión está conectada y lista para enviar mensajes.

---

## 💬 Enviar Mensajes

### Enviar Mensaje de Texto
```bash
curl -X POST http://localhost:2785/api/sessions/{SESSION_ID}/messages/send-text \
  -H "Content-Type: application/json" \
  -H "X-API-Key: owa_k1_1ea34d8c6d9c5797424ead6af83b101201a58b46ac242d526b01a2b13be351ad" \
  -d '{
    "chatId": "521234567890@c.us",
    "text": "Hola desde OpenWA!"
  }'
```

**Formato de chatId:**
- Individual: `52<número>@c.us` (ej: `521234567890@c.us`)
- Grupo: `52<número>@g.us`

### Enviar Imagen
```bash
curl -X POST http://localhost:2785/api/sessions/{SESSION_ID}/messages/send-image \
  -H "Content-Type: application/json" \
  -H "X-API-Key: owa_k1_1ea34d8c6d9c5797424ead6af83b101201a58b46ac242d526b01a2b13be351ad" \
  -d '{
    "chatId": "521234567890@c.us",
    "image": {
      "url": "https://example.com/imagen.jpg",
      "mimetype": "image/jpeg"
    },
    "caption": "Esta es una imagen desde OpenWA"
  }'
```

### Enviar Video
```bash
curl -X POST http://localhost:2785/api/sessions/{SESSION_ID}/messages/send-video \
  -H "Content-Type: application/json" \
  -H "X-API-Key: owa_k1_1ea34d8c6d9c5797424ead6af83b101201a58b46ac242d526b01a2b13be351ad" \
  -d '{
    "chatId": "521234567890@c.us",
    "video": {
      "url": "https://example.com/video.mp4",
      "mimetype": "video/mp4"
    },
    "caption": "Video desde OpenWA"
  }'
```

### Enviar Documento
```bash
curl -X POST http://localhost:2785/api/sessions/{SESSION_ID}/messages/send-document \
  -H "Content-Type: application/json" \
  -H "X-API-Key: owa_k1_1ea34d8c6d9c5797424ead6af83b101201a58b46ac242d526b01a2b13be351ad" \
  -d '{
    "chatId": "521234567890@c.us",
    "document": {
      "url": "https://example.com/documento.pdf",
      "mimetype": "application/pdf"
    },
    "filename": "documento.pdf",
    "caption": "Documento importante"
  }'
```

---

## 🔔 Configurar Webhooks

### Crear un Webhook
```bash
curl -X POST http://localhost:2785/api/sessions/{SESSION_ID}/webhooks \
  -H "Content-Type: application/json" \
  -H "X-API-Key: owa_k1_1ea34d8c6d9c5797424ead6af83b101201a58b46ac242d526b01a2b13be351ad" \
  -d '{
    "url": "https://tu-servidor.com/webhook",
    "events": ["message.received", "session.status"],
    "secret": "tu-secreto-hmac"
  }'
```

**Eventos disponibles:**
- `message.received` - Cuando recibes un mensaje
- `message.sent` - Cuando envías un mensaje
- `message.ack` - Cuando el mensaje es entregado/leído
- `session.status` - Cambios de estado de la sesión

---

## 💡 Ejemplos Prácticos

### Ejemplo 1: Bot de Respuesta Automática
```javascript
// webhook.js (Node.js)
const express = require('express');
const crypto = require('crypto');
const app = express();

app.post('/webhook', express.json(), (req, res) => {
  const hmac = crypto.createHmac('sha256', 'tu-secreto-hmac');
  hmac.update(JSON.stringify(req.body));
  const signature = hmac.digest('hex');
  
  if (req.headers['x-openwa-signature'] !== signature) {
    return res.status(401).send('Invalid signature');
  }
  
  if (req.body.event === 'message.received') {
    const message = req.body.data;
    console.log('Mensaje recibido:', message.text);
    
    // Responder automáticamente
    if (message.text.toLowerCase() === 'hola') {
      // Aquí puedes llamar a la API para responder
    }
  }
  
  res.status(200).send('OK');
});

app.listen(3000, () => console.log('Webhook server running on port 3000'));
```

### Ejemplo 2: Enviar Mensaje Masivo
```bash
# Crear un archivo con los números
cat numeros.txt
521234567890@c.us
521234567891@c.us
521234567892@c.us

# Enviar a todos
while read -r chatId; do
  curl -X POST http://localhost:2785/api/sessions/{SESSION_ID}/messages/send-text \
    -H "Content-Type: application/json" \
    -H "X-API-Key: owa_k1_1ea34d8c6d9c5797424ead6af83b101201a58b46ac242d526b01a2b13be351ad" \
    -d "{
      \"chatId\": \"$chatId\",
      \"text\": \"Mensaje promocional\"
    }"
done < numeros.txt
```

---

## 📚 Recursos Adicionales

### Documentación Swagger
Visita `http://localhost:2785/api/docs` para ver toda la documentación interactiva de la API.

### Dashboard Web
Visita `http://localhost:2886` para usar la interfaz gráfica donde puedes:
- Crear y gestionar sesiones
- Ver mensajes enviados/recibidos
- Configurar webhooks
- Gestionar API keys

### Límites de WhatsApp
- **Texto**: Sin límite práctico
- **Imágenes**: Máximo 16 MB
- **Videos**: Máximo 64 MB
- **Audio**: Máximo 16 MB
- **Documentos**: Máximo 100 MB
- **Stickers**: Máximo 500 KB

---

## ⚠️ Notas Importantes

1. **No envíes spam** - WhatsApp puede banear tu número
2. **Usa webhooks** para recibir mensajes en tiempo real
3. **Guarda tu API key** de forma segura
4. **El chatId debe incluir el código de país** (ej: 52 para México)
5. **La sesión se desconecta** si no se usa por mucho tiempo - necesitarás escanear el QR de nuevo

---

## 🆘 Solución de Problemas

### Error: SESSION_NOT_READY
- La sesión no está conectada. Inicia la sesión y escanea el QR.

### Error: MESSAGE_SEND_FAILED
- Verifica que el número tenga WhatsApp
- Revisa tu conexión a internet
- Asegúrate de que la sesión esté en estado READY

### Error: UNAUTHORIZED
- Verifica que tu API key sea correcta
- Asegúrate de incluir el header `X-API-Key`

### El QR expiró
- Vuelve a llamar al endpoint `/qr` para generar uno nuevo
- Escanea el nuevo QR rápidamente

---

¿Necesitas ayuda con algún paso específico? Puedo guiarte en detalle para cualquier parte del proceso.
