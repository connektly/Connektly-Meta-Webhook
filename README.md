# Connektly API Backend

Standalone deployable backend repository for `https://api.connektly.in`.

## What This Repo Includes

- WhatsApp Cloud API proxy routes
- WhatsApp webhook verification and inbound event routing
- WebSocket updates for the dashboard
- Meta embedded signup and Instagram/lead capture callbacks
- Firebase Admin access for per-user WhatsApp credentials and CRM writes
- `/api/health` health check for Render or similar hosts

## Files

- `server.ts`: Express + WebSocket backend
- `firebaseAdmin.ts`: Firebase Admin bootstrap
- `firebase-applet-config.json`: Firebase project metadata
- `.env.example`: required environment variables
- `render.yaml`: Render blueprint

## Local Run

1. `npm install`
2. Copy `.env.example` to `.env.local`
3. Fill in the required env vars
4. `npm run dev`

Server defaults to `http://127.0.0.1:3000`.

## Render Deploy

1. Create a new Render Web Service from this repository.
2. Let Render use `render.yaml`.
3. Set the custom domain to `api.connektly.in`.
4. Add all required env vars from `.env.example`.
5. Deploy.

## Required Production Values

- `APP_URL=https://app.connektly.in`
- `API_URL=https://api.connektly.in`
- `META_VERIFY_TOKEN`
- `FACEBOOK_APP_ID`
- `FACEBOOK_APP_SECRET`
- `FIREBASE_SERVICE_ACCOUNT_JSON` or `FIREBASE_SERVICE_ACCOUNT_PATH`

## Webhook URLs

- `https://api.connektly.in/meta/webhook`
- `https://api.connektly.in/api/wa/webhook`

Use the same verify token in Meta that you place in `META_VERIFY_TOKEN`.
