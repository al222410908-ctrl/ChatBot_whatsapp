# OpenWA - Información de Acceso

## 🔑 API Key
```
owa_k1_1ea34d8c6d9c5797424ead6af83b101201a58b46ac242d526b01a2b13be351ad
```

## 🌐 URLs de Acceso

- **Dashboard**: http://localhost:2886
- **API**: http://localhost:2785/api
- **Swagger Docs**: http://localhost:2785/api/docs

## 🚀 Comandos Docker

### Iniciar el proyecto
```bash
cd C:\Users\Alan Alcantara\OneDrive\Escritorio\wasap\OpenWA
docker compose -f docker-compose.dev.yml up -d
```

### Ver logs
```bash
docker logs openwa-api
```

### Detener el proyecto
```bash
docker compose -f docker-compose.dev.yml down
```

## 📝 Notas
- La API key se generó automáticamente al iniciar el proyecto
- Esta key se guarda en `data/.api-key` dentro del contenedor
- Para usar la API, incluye el header: `X-API-Key: owa_k1_1ea34d8c6d9c5797424ead6af83b101201a58b46ac242d526b01a2b13be351ad`
