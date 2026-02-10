# Afiliados Pro Hub Backend

Backend en Node.js + Express para Afiliados Pro Hub.
Usa Firebase Admin SDK para autenticar y leer/escribir en Firestore.

## Requisitos
- Node 20+
- Firebase Project con Auth + Firestore habilitados
- Service Account JSON

## Variables de entorno
- `FIREBASE_SERVICE_ACCOUNT`: JSON del service account en una sola linea.
- `CORS_ORIGIN`: origen permitido (ej: `https://tu-dominio.vercel.app`).
- `PORT`: puerto (por defecto 8080).
- `ADMIN_EMAILS`: lista separada por comas de correos con acceso al panel admin.
- `SALES_API_KEY`: llave secreta para registrar ventas del bundle.
- `FX_PEN_TO_USD`: tipo de cambio PEN -> USD (ej: `0.27`).
- `REFUND_HOLD_DAYS`: dias de retencion antes de liberar comisiones (ej: `14`).
- `PAYOUT_MIN_USD`: monto minimo para pagos (ej: `100`).

## Comandos
```bash
npm install
npm run dev
```

## Deploy en Cloud Run
```bash
gcloud run deploy afiliados-pro-hub-backend --source . --region us-central1 --allow-unauthenticated
```

## Endpoints
- `GET /health`
- `POST /users/bootstrap`
- `GET /me`
- `GET /dashboard`
- `GET /tools`
- `GET /network`
- `GET /subscription`
- `POST /subscription/upgrade`
- `POST /bundle/sales` (requiere `x-sales-key`)
- `GET /admin/users`
- `PATCH /admin/users/:uid`
- `DELETE /admin/users/:uid`
