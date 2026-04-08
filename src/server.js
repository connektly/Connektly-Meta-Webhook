import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";

const PORT = Number(process.env.PORT || 8080);
const APP_SECRET = process.env.META_APP_SECRET || "";
const MAX_EVENTS = Number(process.env.MAX_EVENTS || 1000);
const WEBHOOK_PATHS = new Set(["/meta/webhook", "/api/wa/webhook", "/api/whatsapp/webhook", "/webhook"]);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const dataFile = path.join(rootDir, "data", "events.json");
const publicDir = path.join(rootDir, "public");
const localEnvPath = path.join(rootDir, ".env");
const localEnvLocalPath = path.join(rootDir, ".env.local");
const parentFirebaseConfigPath = path.resolve(rootDir, "..", "firebase-applet-config.json");
const localFirebaseConfigPath = path.join(rootDir, "firebase-applet-config.json");

dotenv.config({ path: localEnvPath, quiet: true });
dotenv.config({ path: localEnvLocalPath, override: true, quiet: true });

function getVerifyToken() {
  return process.env.META_VERIFY_TOKEN || process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || "";
}

const USE_CASES = {
  ads_management: "Create and Manage Ads",
  ad_apps: "Manage Ad Apps",
  whatsapp_cloud_api: "Connect on WhatsApp (Cloud API Platform)",
  ad_performance: "Measure Ad Performance",
  leads_management: "Capture and Manage Leads",
  pages_management: "Manage Pages",
  instagram_api: "Instagram API",
  messenger: "Messenger from Meta"
};

const MAX_BODY_BYTES = 2 * 1024 * 1024;

function normalizePhoneDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function phonesMatch(left, right) {
  const normalizedLeft = normalizePhoneDigits(left);
  const normalizedRight = normalizePhoneDigits(right);
  if (!normalizedLeft || !normalizedRight) return false;
  return normalizedLeft === normalizedRight || normalizedLeft.endsWith(normalizedRight) || normalizedRight.endsWith(normalizedLeft);
}

function normalizeCallEventToken(value) {
  return String(value || "").toLowerCase().replace(/[\s-]+/g, "_");
}

function getWebhookCallLabel(direction, status) {
  if (status === "missed") return direction === "incoming" ? "Missed voice call" : "Missed outgoing call";
  if (status === "ringing") return direction === "incoming" ? "Incoming voice call" : "Outgoing voice call";
  if (status === "failed") return direction === "incoming" ? "Incoming call failed" : "Outgoing call failed";
  if (status === "ended") return direction === "incoming" ? "Completed incoming call" : "Completed outgoing call";
  return direction === "incoming" ? "Incoming voice call" : "Outgoing voice call";
}

function inferWebhookCallDirection(message, contact, metadata) {
  const callPayload = message?.call || message || {};
  const contactWaId = contact?.wa_id || "";
  const callFrom = callPayload?.from || message?.from || "";
  const callTo = callPayload?.to || message?.to || "";
  const businessNumber = metadata?.display_phone_number || "";
  const directionHints = `${callPayload?.direction || ""} ${message?.direction || ""}`.toLowerCase();
  const directionToken = normalizeCallEventToken(callPayload?.direction || message?.direction || "");

  if (directionToken === "user_initiated") return "incoming";
  if (directionToken === "business_initiated") return "outgoing";

  if (contactWaId) {
    if (phonesMatch(callFrom, contactWaId) && !phonesMatch(callTo, contactWaId)) return "incoming";
    if (phonesMatch(callTo, contactWaId) && !phonesMatch(callFrom, contactWaId)) return "outgoing";
  }

  if (businessNumber) {
    if (phonesMatch(callTo, businessNumber) && !phonesMatch(callFrom, businessNumber)) return "incoming";
    if (phonesMatch(callFrom, businessNumber) && !phonesMatch(callTo, businessNumber)) return "outgoing";
  }

  return /outgoing|dialed|agent/.test(directionHints) ? "outgoing" : "incoming";
}

function inferWebhookCallStatus(message, direction, lowerText, structuredMeta) {
  const callPayload = message?.call || message || {};
  const eventToken = normalizeCallEventToken(callPayload?.event || message?.event || "");
  const statusText = [
    callPayload?.status,
    callPayload?.direction,
    callPayload?.event,
    message?.status,
    message?.direction,
    message?.event,
    lowerText,
    structuredMeta
  ].filter(Boolean).join(" ").toLowerCase();

  if (["timeout", "missed", "no_answer", "not_answered", "unanswered"].includes(eventToken) || /missed|unanswered|not answered|no answer|timeout/.test(statusText)) {
    return "missed";
  }

  if (["connect", "pre_accept", "offer", "ringing", "invite", "alerting", "user_initiated"].includes(eventToken) || /ringing|offer|incoming|user initiated/.test(statusText)) {
    return "ringing";
  }

  if (["accept", "accepted", "answer", "answered", "ongoing", "connected"].includes(eventToken) || /accepted|answered|ongoing|in progress/.test(statusText)) {
    return "ongoing";
  }

  if (["reject", "rejected", "decline", "declined", "busy", "unavailable", "failed", "fail"].includes(eventToken) || /failed|declined|rejected|busy|unavailable/.test(statusText)) {
    return direction === "incoming" ? "missed" : "failed";
  }

  if (["terminate", "terminated", "hangup", "hang_up", "end", "ended", "disconnect", "disconnected", "complete", "completed", "finish", "finished"].includes(eventToken) || /ended|completed|finished|disconnect|hangup|terminated/.test(statusText)) {
    return "ended";
  }

  return "ringing";
}

function inferCallInfoFromWebhookMessage(message, contact, metadata) {
  const lowerText = [
    message?.text?.body,
    message?.button?.text,
    message?.interactive?.button_reply?.title,
    message?.interactive?.list_reply?.title,
    message?.caption,
    message?.system?.body,
    message?.call?.status,
    message?.call?.direction,
    message?.call?.event,
    message?.event,
    message?.unsupported?.title,
    message?.unsupported?.description,
    Array.isArray(message?.errors)
      ? message.errors.map((error) => `${error?.title || ""} ${error?.message || ""}`.trim()).join(" ")
      : ""
  ].filter(Boolean).join(" ").toLowerCase();

  const structuredMeta = JSON.stringify({
    type: message?.type,
    call: message?.call,
    errors: message?.errors,
    unsupported: message?.unsupported,
    system: message?.system,
    event: message?.call?.event || message?.event
  }).toLowerCase();

  const explicitCall = message?.type === "call" || Boolean(message?.call);
  const keywordCall = /(missed voice call|incoming voice call|outgoing voice call|voice call|video call|missed call|incoming call|outgoing call)/.test(lowerText);
  const unsupportedCall = message?.type === "unsupported" && /call/.test(structuredMeta);

  if (!(explicitCall || keywordCall || unsupportedCall)) {
    return null;
  }

  const direction = inferWebhookCallDirection(message, contact, metadata);
  const status = inferWebhookCallStatus(message, direction, lowerText, structuredMeta);

  return {
    direction,
    status,
    label: getWebhookCallLabel(direction, status),
    mode: "voice"
  };
}

function extractInboundWhatsappEvents(body) {
  const events = [];

  for (const entry of body?.entry || []) {
    for (const change of entry?.changes || []) {
      const value = change?.value;
      const metadata = value?.metadata;
      const contacts = Array.isArray(value?.contacts) ? value.contacts : [];
      const messages = Array.isArray(value?.messages) ? value.messages : [];
      const calls = Array.isArray(value?.calls) ? value.calls : [];

      for (const message of messages) {
        const matchingContact = contacts.find((contact) => contact?.wa_id === message?.from) || contacts[0] || null;
        events.push({
          entryId: entry?.id,
          changeField: change?.field,
          message,
          contact: matchingContact,
          metadata
        });
      }

      for (const call of calls) {
        const businessNumber = metadata?.display_phone_number || "";
        const callFrom = call?.from || "";
        const callTo = call?.to || "";
        const matchingContact =
          contacts.find((contact) => phonesMatch(contact?.wa_id, callFrom) || phonesMatch(contact?.wa_id, callTo)) ||
          contacts[0] ||
          null;
        const participantWaId =
          matchingContact?.wa_id ||
          (phonesMatch(callFrom, businessNumber) ? callTo : "") ||
          (phonesMatch(callTo, businessNumber) ? callFrom : "") ||
          call?.wa_id ||
          callFrom ||
          callTo ||
          "";

        events.push({
          entryId: entry?.id,
          changeField: change?.field,
          message: {
            ...call,
            id: call?.id || `wa-call-${participantWaId || Date.now()}`,
            from: participantWaId,
            timestamp: call?.timestamp || Math.floor(Date.now() / 1000).toString(),
            type: "call",
            call
          },
          contact: matchingContact,
          metadata
        });
      }
    }
  }

  return events;
}

function normalizeServiceAccount(serviceAccount) {
  if (serviceAccount?.private_key) {
    serviceAccount.private_key = String(serviceAccount.private_key).replace(/\\n/g, "\n");
  }
  return serviceAccount;
}

function loadFirebaseConfig() {
  if (process.env.FIREBASE_PROJECT_ID || process.env.FIREBASE_FIRESTORE_DATABASE_ID) {
    return {
      projectId: process.env.FIREBASE_PROJECT_ID || undefined,
      firestoreDatabaseId: process.env.FIREBASE_FIRESTORE_DATABASE_ID || undefined
    };
  }

  for (const candidate of [localFirebaseConfigPath, parentFirebaseConfigPath]) {
    if (fs.existsSync(candidate)) {
      try {
        const parsed = safeJsonParse(fs.readFileSync(candidate, "utf8"), null);
        if (parsed?.projectId || parsed?.firestoreDatabaseId) {
          return {
            projectId: parsed.projectId,
            firestoreDatabaseId: parsed.firestoreDatabaseId
          };
        }
      } catch {
        // Ignore malformed config file candidates.
      }
    }
  }

  return null;
}

function resolveFirebaseServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return {
      source: "FIREBASE_SERVICE_ACCOUNT_JSON",
      path: null,
      serviceAccount: normalizeServiceAccount(safeJsonParse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON, null))
    };
  }

  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!serviceAccountPath) {
    return { source: null, path: null, serviceAccount: null };
  }

  if (!fs.existsSync(serviceAccountPath)) {
    throw new Error(`Firebase service account file not found at ${serviceAccountPath}`);
  }

  const source = process.env.FIREBASE_SERVICE_ACCOUNT_PATH ? "FIREBASE_SERVICE_ACCOUNT_PATH" : "GOOGLE_APPLICATION_CREDENTIALS";
  return {
    source,
    path: serviceAccountPath,
    serviceAccount: normalizeServiceAccount(safeJsonParse(fs.readFileSync(serviceAccountPath, "utf8"), null))
  };
}

function initializeFirebaseAdmin() {
  try {
    const firebaseConfig = loadFirebaseConfig();
    const { source, path: credentialPath, serviceAccount } = resolveFirebaseServiceAccount();

    if (serviceAccount && !serviceAccount.project_id) {
      throw new Error("Resolved Firebase service account is missing project_id");
    }

    if (firebaseConfig?.projectId && serviceAccount?.project_id && firebaseConfig.projectId !== serviceAccount.project_id) {
      throw new Error(`Firebase project mismatch: config targets "${firebaseConfig.projectId}" but credentials belong to "${serviceAccount.project_id}"`);
    }

    const appOptions = {
      ...(firebaseConfig?.projectId ? { projectId: firebaseConfig.projectId } : {}),
      ...(serviceAccount ? { credential: admin.credential.cert(serviceAccount) } : {})
    };

    const app = admin.apps.length
      ? admin.app()
      : admin.initializeApp(Object.keys(appOptions).length ? appOptions : undefined);

    const db = firebaseConfig?.firestoreDatabaseId
      ? getFirestore(app, firebaseConfig.firestoreDatabaseId)
      : admin.firestore(app);

    console.log(
      serviceAccount
        ? `Firebase Admin initialized with ${source}${credentialPath ? ` (${credentialPath})` : ""}.`
        : "Firebase Admin initialized without explicit credentials."
    );

    return { db, firebaseConfig };
  } catch (error) {
    console.error(`Firebase Admin initialization failed: ${error.message}`);
    return { db: null, firebaseConfig: null };
  }
}

const { db } = initializeFirebaseAdmin();

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function loadEvents() {
  if (!fs.existsSync(dataFile)) return [];
  const raw = fs.readFileSync(dataFile, "utf8");
  const parsed = safeJsonParse(raw, []);
  return Array.isArray(parsed) ? parsed : [];
}

function saveEvents(events) {
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  fs.writeFileSync(dataFile, JSON.stringify(events, null, 2), "utf8");
}

const eventStore = {
  events: loadEvents(),
  addMany(incomingEvents) {
    this.events = [...incomingEvents, ...this.events].slice(0, MAX_EVENTS);
    saveEvents(this.events);
  },
  all({ type, source, limit }) {
    return this.events
      .filter((event) => (type ? event.useCaseKey === type : true))
      .filter((event) => (source ? event.sourceObject === source : true))
      .slice(0, limit);
  },
  stats() {
    const byUseCase = Object.fromEntries(Object.keys(USE_CASES).map((key) => [key, 0]));
    const bySource = {};

    for (const event of this.events) {
      if (byUseCase[event.useCaseKey] !== undefined) byUseCase[event.useCaseKey] += 1;
      bySource[event.sourceObject] = (bySource[event.sourceObject] || 0) + 1;
    }

    return {
      total: this.events.length,
      byUseCase,
      bySource,
      labels: USE_CASES
    };
  }
};

function mapEventToUseCase(sourceObject, field, value) {
  const object = String(sourceObject || "").toLowerCase();
  const normalizedField = String(field || "").toLowerCase();

  if (object === "whatsapp_business_account" || value?.messaging_product === "whatsapp") return "whatsapp_cloud_api";
  if (object === "instagram" || normalizedField.includes("instagram")) return "instagram_api";
  if (normalizedField.includes("lead") || value?.leadgen_id || value?.form_id) return "leads_management";

  const hasMessagingArray = Array.isArray(value?.messaging) && value.messaging.length > 0;
  if (hasMessagingArray) return "messenger";

  if (object === "page" && normalizedField.includes("feed")) return "pages_management";
  if (object === "page" && normalizedField.includes("message")) return "messenger";

  if (normalizedField.includes("adcreative") || normalizedField.includes("adset") || normalizedField === "ads") return "ads_management";
  if (normalizedField.includes("application") || normalizedField.includes("app")) return "ad_apps";
  if (normalizedField.includes("insights") || normalizedField.includes("performance") || value?.metric) return "ad_performance";

  if (object === "page") return "pages_management";
  return "ad_performance";
}

function flattenPayloadToEvents(payload) {
  const sourceObject = payload?.object || "unknown";
  const entries = Array.isArray(payload?.entry) ? payload.entry : [];
  const now = new Date().toISOString();

  const events = [];

  if (!entries.length) {
    const useCaseKey = mapEventToUseCase(sourceObject, "", payload);
    events.push({
      id: crypto.randomUUID(),
      receivedAt: now,
      sourceObject,
      field: "",
      useCaseKey,
      useCaseLabel: USE_CASES[useCaseKey],
      payload
    });
    return events;
  }

  for (const entry of entries) {
    const entryId = entry?.id ?? null;
    const entryTime = entry?.time ?? null;
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];

    if (!changes.length) {
      const useCaseKey = mapEventToUseCase(sourceObject, "", entry);
      events.push({
        id: crypto.randomUUID(),
        receivedAt: now,
        sourceObject,
        entryId,
        entryTime,
        field: "",
        useCaseKey,
        useCaseLabel: USE_CASES[useCaseKey],
        payload: entry
      });
      continue;
    }

    for (const change of changes) {
      const field = change?.field || "";
      const value = change?.value || {};
      const useCaseKey = mapEventToUseCase(sourceObject, field, value);
      events.push({
        id: crypto.randomUUID(),
        receivedAt: now,
        sourceObject,
        entryId,
        entryTime,
        field,
        useCaseKey,
        useCaseLabel: USE_CASES[useCaseKey],
        payload: { object: sourceObject, entry: { id: entryId, time: entryTime }, change }
      });
    }
  }

  return events;
}

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*"
  });
  res.end(body);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Access-Control-Allow-Origin": "*"
  });
  res.end(text);
}

function serveStatic(res, pathname) {
  const filePath = pathname === "/" ? path.join(publicDir, "index.html") : path.join(publicDir, pathname);
  const resolved = path.resolve(filePath);

  if (!resolved.startsWith(publicDir)) return sendText(res, 403, "Forbidden");

  if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
    const fallback = path.join(publicDir, "index.html");
    const html = fs.readFileSync(fallback);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(html);
  }

  const ext = path.extname(resolved).toLowerCase();
  const mime = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8"
  }[ext] || "application/octet-stream";

  res.writeHead(200, { "Content-Type": mime });
  fs.createReadStream(resolved).pipe(res);
}

function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;

    req.on("data", (chunk) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const asText = raw.toString("utf8");
      const parsed = safeJsonParse(asText, null);
      if (asText && parsed === null) {
        reject(new Error("Invalid JSON body"));
        return;
      }
      resolve({ raw, parsed: parsed || {} });
    });

    req.on("error", reject);
  });
}

function hasValidMetaSignature(req, rawBody) {
  if (!APP_SECRET) return true;

  const signatureHeader = req.headers["x-hub-signature-256"];
  if (!signatureHeader || typeof signatureHeader !== "string") return false;

  const expected = `sha256=${crypto.createHmac("sha256", APP_SECRET).update(rawBody).digest("hex")}`;
  const provided = signatureHeader.trim();

  return provided.length === expected.length && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

async function routeInboundWhatsappEvents(body) {
  if (!db || body?.object !== "whatsapp_business_account") {
    return { routedUsers: 0, acceptedEvents: 0 };
  }

  const inboundEvents = extractInboundWhatsappEvents(body);
  if (!inboundEvents.length) {
    return { routedUsers: 0, acceptedEvents: 0 };
  }

  const routedUsers = new Set();

  for (const event of inboundEvents) {
    const { message, contact, metadata } = event;
    const callInfo = inferCallInfoFromWebhookMessage(message, contact, metadata);
    const messageText =
      callInfo?.label ||
      message?.text?.body ||
      message?.button?.text ||
      message?.interactive?.button_reply?.title ||
      message?.interactive?.list_reply?.title ||
      message?.caption ||
      "Media/Unsupported Message";
    const messageTimestamp = Number.parseInt(String(message?.timestamp || Date.now()), 10);
    const normalizedTimestamp = Number.isNaN(messageTimestamp)
      ? Date.now()
      : messageTimestamp < 10_000_000_000
        ? messageTimestamp * 1000
        : messageTimestamp;
    const targetPhoneNumberId = String(metadata?.phone_number_id || "");

    if (!targetPhoneNumberId) {
      console.warn("Inbound message received without metadata.phone_number_id. Skipping Firestore routing.");
      continue;
    }

    const usersSnapshot = await db.collection("users")
      .where("whatsappCredentials.phoneNumberId", "==", targetPhoneNumberId)
      .limit(20)
      .get();

    if (usersSnapshot.empty) {
      console.warn(`No matching user found for inbound phone_number_id=${targetPhoneNumberId}`);
      continue;
    }

    for (const userDoc of usersSnapshot.docs) {
      const userId = userDoc.id;
      routedUsers.add(userId);

      const callLogId = message?.call?.id || message?.id || `call-${normalizedTimestamp}`;
      const inboundMessageId =
        message?.id ||
        `msg-${targetPhoneNumberId}-${normalizePhoneDigits(message?.from || "")}-${normalizedTimestamp}`;
      const userRef = db.collection("users").doc(userId);

      if (callInfo) {
        await userRef.collection("callLogs").doc(callLogId).set({
          id: callLogId,
          callId: callLogId,
          contactName: contact?.profile?.name || message?.from || "",
          contactPhone: message?.from || "",
          direction: callInfo.direction,
          status: callInfo.status,
          label: callInfo.label,
          startedAt: normalizedTimestamp,
          ...(callInfo.status !== "ringing" ? { endedAt: normalizedTimestamp, durationSeconds: 0 } : {}),
          phoneNumberId: targetPhoneNumberId,
          businessPhoneNumber: metadata?.display_phone_number || "",
          source: "webhook",
          participants: [contact?.profile?.name || message?.from || ""],
          session: message?.call?.session || message?.session || null,
          rawCallPayload: message?.call || message
        }, { merge: true });
      }

      await userRef.collection("messages").doc(inboundMessageId).set({
        id: inboundMessageId,
        from: message?.from || "",
        to: metadata?.display_phone_number || "",
        text: messageText,
        timestamp: normalizedTimestamp,
        direction: "inbound",
        status: "RECEIVED",
        type: "received",
        owner: false,
        name: contact?.profile?.name || message?.from || "",
        phoneNumberId: targetPhoneNumberId,
        whatsappId: message?.id || "",
        ...(callInfo ? { messageKind: "call", callInfo, callPayload: message?.call || message } : {}),
        rawPayload: body
      }, { merge: true });

      const contactsCollection = userRef.collection("contacts");
      const normalizedContactPhone = String(message?.from || "");
      const existingContactSnapshot = await contactsCollection
        .where("whatsappNumber", "==", normalizedContactPhone)
        .limit(1)
        .get();

      const contactTimestampIso = new Date(normalizedTimestamp).toISOString();
      if (existingContactSnapshot.empty) {
        await contactsCollection.add({
          fullName: contact?.profile?.name || normalizedContactPhone || "Unknown",
          whatsappNumber: normalizedContactPhone,
          phone: normalizedContactPhone,
          lastMessage: messageText,
          lastMessageTime: contactTimestampIso,
          unreadCount: 1,
          tags: callInfo ? ["Webhook", "Call"] : ["Webhook"],
          notes: "",
          createdAt: contactTimestampIso,
          updatedAt: contactTimestampIso
        });
      } else {
        const existingContactDoc = existingContactSnapshot.docs[0];
        const existingContactData = existingContactDoc.data() || {};
        await existingContactDoc.ref.set({
          fullName: existingContactData.fullName || contact?.profile?.name || normalizedContactPhone || "Unknown",
          whatsappNumber: existingContactData.whatsappNumber || normalizedContactPhone,
          phone: existingContactData.phone || normalizedContactPhone,
          lastMessage: messageText,
          lastMessageTime: contactTimestampIso,
          unreadCount: Number(existingContactData.unreadCount || 0) + 1,
          updatedAt: contactTimestampIso
        }, { merge: true });
      }
    }
  }

  return { routedUsers: routedUsers.size, acceptedEvents: inboundEvents.length };
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = requestUrl.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Hub-Signature-256"
    });
    return res.end();
  }

  if (req.method === "GET" && pathname === "/health") {
    return sendJson(res, 200, {
      status: "ok",
      app: "connektly-meta-webhook-server",
      firebaseEnabled: Boolean(db),
      timestamp: new Date().toISOString()
    });
  }

  if (req.method === "GET" && WEBHOOK_PATHS.has(pathname)) {
    const mode = requestUrl.searchParams.get("hub.mode");
    const token = requestUrl.searchParams.get("hub.verify_token");
    const challenge = requestUrl.searchParams.get("hub.challenge") || "";
    const verifyToken = getVerifyToken();

    if (!verifyToken) {
      return sendJson(res, 500, {
        error: "Verification failed",
        expectedTokenHint: "Set META_VERIFY_TOKEN or WHATSAPP_WEBHOOK_VERIFY_TOKEN in your environment"
      });
    }

    if (mode === "subscribe" && token === verifyToken) return sendText(res, 200, challenge);
    return sendJson(res, 403, { error: "Verification failed" });
  }

  if (req.method === "POST" && WEBHOOK_PATHS.has(pathname)) {
    try {
      const { raw, parsed } = await parseRequestBody(req);

      if (!hasValidMetaSignature(req, raw)) {
        return sendJson(res, 401, { error: "Invalid X-Hub-Signature-256 signature" });
      }

      const events = flattenPayloadToEvents(parsed);
      eventStore.addMany(events);
      const routingResult = await routeInboundWhatsappEvents(parsed);

      return sendJson(res, 200, {
        received: true,
        acceptedEvents: events.length,
        routedWhatsappEvents: routingResult.acceptedEvents,
        routedUsers: routingResult.routedUsers,
        useCases: [...new Set(events.map((event) => event.useCaseKey))],
        receivedAt: new Date().toISOString()
      });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  if (req.method === "GET" && pathname === "/api/stats") {
    return sendJson(res, 200, eventStore.stats());
  }

  if (req.method === "GET" && pathname === "/api/events") {
    const limit = Math.min(Number(requestUrl.searchParams.get("limit") || 50), 200);
    const type = requestUrl.searchParams.get("type") || undefined;
    const source = requestUrl.searchParams.get("source") || undefined;

    return sendJson(res, 200, {
      events: eventStore.all({ type, source, limit }),
      useCases: USE_CASES,
      sources: [...new Set(eventStore.events.map((event) => event.sourceObject))]
    });
  }

  if (req.method === "GET") return serveStatic(res, pathname);

  return sendJson(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`Connektly webhook server running on http://localhost:${PORT}`);
});
