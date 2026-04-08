# Connektly Meta Webhook Callback URL Server + Event Dashboard

A production-ready starter for **Connektly** to receive Meta webhooks and monitor events in a modern dashboard.

## Supported use cases

1. Create and Manage Ads
2. Manage Ad Apps
3. Connect on WhatsApp (Cloud API Platform)
4. Measure Ad Performance
5. Capture and Manage Leads
6. Manage Pages
7. Instagram API
8. Messenger from Meta

## Features

- Meta webhook verification endpoint (`GET /meta/webhook`)
- Meta webhook callback receiver (`POST /meta/webhook`)
- Also supports `/api/wa/webhook`, `/api/whatsapp/webhook`, and `/webhook`
- Event classification to all 8 use-case buckets
- Flattens multiple `entry[].changes[]` records into individual trackable events
- Optional Meta signature verification (`X-Hub-Signature-256`) when `META_APP_SECRET` is set
- Persistent local event storage (`data/events.json`)
- Optional Firebase Admin routing for inbound WhatsApp events into Connektly user workspaces
- Modern dashboard with:
  - Total event count and use-case cards
  - Source-level visibility
  - Filterable event stream (by use case + source)
  - Payload inspector
- REST APIs:
  - `GET /api/events?type=&source=&limit=`
  - `GET /api/stats`
  - `GET /health`

## Quick start

```bash
cp .env.example .env
npm run dev
```

Open: `http://localhost:8080`

## Environment variables

- `PORT` - service port (default: `8080`)
- `META_VERIFY_TOKEN` - token used by Meta for webhook subscription verification
- `WHATSAPP_WEBHOOK_VERIFY_TOKEN` - optional legacy alias for verification token
- `META_APP_SECRET` - when set, validates incoming `X-Hub-Signature-256`
- `MAX_EVENTS` - in-memory + persisted rolling event limit
- `FIREBASE_PROJECT_ID` - Firebase project ID
- `FIREBASE_FIRESTORE_DATABASE_ID` - named Firestore database ID if you do not use `(default)`
- `FIREBASE_SERVICE_ACCOUNT_PATH` or `FIREBASE_SERVICE_ACCOUNT_JSON` - Firebase Admin credentials for routing inbound WhatsApp events into Firestore

## Meta webhook setup

- Callback URL: `https://<your-domain>/meta/webhook`
- Verify token: value of `META_VERIFY_TOKEN`

Verification test:

```bash
curl "http://localhost:8080/meta/webhook?hub.mode=subscribe&hub.verify_token=connektly-meta-verify-token&hub.challenge=12345"
```

Expected response: `12345`

## Example webhook call

```bash
curl -X POST http://localhost:8080/meta/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "object": "whatsapp_business_account",
    "entry": [{
      "id": "WABA_ID",
      "time": 1712050000,
      "changes": [{
        "field": "messages",
        "value": {
          "messaging_product": "whatsapp",
          "messages": [{"id": "wamid.HBgL..."}]
        }
      }]
    }]
  }'
```

## Production notes

- Keep `META_APP_SECRET` enabled in production.
- Move event persistence from file storage to a durable DB (e.g., PostgreSQL/Redis).
- Put the service behind HTTPS and centralized logging/monitoring.
- For Connektly's inbox to show inbound WhatsApp messages, configure the same Firebase project/database used by the dashboard and provide Firebase Admin credentials so this webhook service can write to `users/{uid}/messages` and `users/{uid}/contacts`.
