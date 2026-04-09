import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import axios from "axios";
import http from "http";
import multer from "multer";
import { getAuth } from "firebase-admin/auth";

import { firebaseAdminApp, firebaseAdminContext, firebaseAdminDb } from "./firebaseAdmin.js";

// Initialize Firebase Admin
let db: any = firebaseAdminDb;

const normalizePhoneDigits = (value: any) => String(value || "").replace(/\D/g, "");

const phonesMatch = (left: any, right: any) => {
  const normalizedLeft = normalizePhoneDigits(left);
  const normalizedRight = normalizePhoneDigits(right);
  if (!normalizedLeft || !normalizedRight) return false;
  return normalizedLeft === normalizedRight || normalizedLeft.endsWith(normalizedRight) || normalizedRight.endsWith(normalizedLeft);
};

const normalizeCallEventToken = (value: any) => String(value || "").toLowerCase().replace(/[\s-]+/g, "_");
const webhookRoutes = ["/api/wa/webhook", "/api/whatsapp/webhook", "/webhook", "/meta/webhook"];
const getWebhookVerifyToken = () =>
  process.env.META_VERIFY_TOKEN ||
  process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN ||
  "";
const getRequestAccessToken = (authorizationHeader?: string | string[]) => {
  const rawValue = Array.isArray(authorizationHeader) ? authorizationHeader[0] : authorizationHeader;
  return String(rawValue || "").replace(/^Bearer\s+/i, "").trim();
};

const looksLikeJwt = (value: string) => value.split(".").length === 3;

const getAuthorizationBearerToken = (headers: Record<string, any>) =>
  getRequestAccessToken(headers?.authorization);

const getExplicitWhatsAppAccessToken = (headers: Record<string, any>) =>
  getRequestAccessToken(headers?.["x-whatsapp-access-token"]) ||
  getRequestAccessToken(headers?.["x-workspace-access-token"]);

const getFirebaseSessionToken = (headers: Record<string, any>) => {
  const explicitFirebaseToken =
    getRequestAccessToken(headers?.["x-firebase-authorization"]) ||
    getRequestAccessToken(headers?.["x-firebase-session-token"]);

  if (explicitFirebaseToken) {
    return explicitFirebaseToken;
  }

  const authorizationToken = getAuthorizationBearerToken(headers);
  return looksLikeJwt(authorizationToken) ? authorizationToken : "";
};

const resolveWhatsAppAccessToken = async (headers: Record<string, any>) => {
  const explicitAccessToken = getExplicitWhatsAppAccessToken(headers);
  if (explicitAccessToken) {
    return {
      accessToken: explicitAccessToken,
      source: "explicit_whatsapp_header"
    };
  }

  const firebaseSessionToken = getFirebaseSessionToken(headers);
  if (firebaseSessionToken) {
    try {
      const decodedToken = await getAuth(firebaseAdminApp).verifyIdToken(firebaseSessionToken);
      const userSnapshot = await db.collection("users").doc(decodedToken.uid).get();
      const whatsappAccessToken = String(userSnapshot.data()?.whatsappCredentials?.accessToken || "").trim();

      if (whatsappAccessToken) {
        return {
          accessToken: whatsappAccessToken,
          source: "firebase_session",
          userId: decodedToken.uid
        };
      }

      return {
        accessToken: "",
        source: "firebase_session",
        userId: decodedToken.uid,
        error: "WhatsApp access token is not configured for this workspace."
      };
    } catch (error) {
      if (!isFirebaseSessionTokenError(error) && !looksLikeJwt(firebaseSessionToken)) {
        return {
          accessToken: firebaseSessionToken,
          source: "authorization_header"
        };
      }

      return {
        accessToken: "",
        source: "firebase_session",
        error: "Invalid or expired Firebase session token."
      };
    }
  }

  const authorizationToken = getAuthorizationBearerToken(headers);
  if (authorizationToken) {
    return {
      accessToken: authorizationToken,
      source: "authorization_header"
    };
  }

  return {
    accessToken: "",
    source: "missing",
    error: "No WhatsApp access token provided for this workspace"
  };
};

const isFirebaseSessionTokenError = (error: any) => {
  const code = String(error?.code || "").trim();
  const message = String(error?.message || "").toLowerCase();

  return (
    code === "auth/id-token-expired" ||
    code === "auth/invalid-id-token" ||
    (code.startsWith("auth/") && message.includes("firebase id token")) ||
    message.includes("session cookie")
  );
};

const getAllowedCorsOrigins = () => {
  const configuredOrigins = [
    process.env.APP_URL,
    "https://app.connektly.in",
    "https://www.app.connektly.in",
    "https://connektly.firebaseapp.com",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:5173",
    "http://127.0.0.1:5173"
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  return new Set(configuredOrigins);
};

console.log(
  firebaseAdminContext.hasExplicitCredentials
    ? `Firebase Admin initialized with ${firebaseAdminContext.credentialSource}${firebaseAdminContext.credentialPath ? ` (${firebaseAdminContext.credentialPath})` : ""}.`
    : "Firebase Admin initialized without explicit credentials. Set FIREBASE_SERVICE_ACCOUNT_PATH, FIREBASE_SERVICE_ACCOUNT_JSON, or GOOGLE_APPLICATION_CREDENTIALS if server-side Firestore access fails."
);

if (!getWebhookVerifyToken()) {
  console.warn("[startup-warning] META_VERIFY_TOKEN / WHATSAPP_WEBHOOK_VERIFY_TOKEN is not configured. Meta webhook verification will fail.");
}

if (!process.env.FACEBOOK_APP_ID || !process.env.FACEBOOK_APP_SECRET) {
  console.warn("[startup-warning] FACEBOOK_APP_ID / FACEBOOK_APP_SECRET is not fully configured. Embedded signup and Meta OAuth flows may fail.");
}

const extractInboundWhatsappEvents = (body: any) => {
  const events: Array<{
    entryId?: string;
    changeField?: string;
    message: any;
    contact: any;
    metadata: any;
  }> = [];

  for (const entry of body?.entry || []) {
    for (const change of entry?.changes || []) {
      const value = change?.value;
      const metadata = value?.metadata;
      const contacts = Array.isArray(value?.contacts) ? value.contacts : [];
      const messages = Array.isArray(value?.messages) ? value.messages : [];
      const calls = Array.isArray(value?.calls) ? value.calls : [];

      for (const message of messages) {
        const matchingContact = contacts.find((contact: any) => contact?.wa_id === message?.from) || contacts[0] || null;
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
          contacts.find((contact: any) => phonesMatch(contact?.wa_id, callFrom) || phonesMatch(contact?.wa_id, callTo)) ||
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
            call,
          },
          contact: matchingContact,
          metadata
        });
      }
    }
  }

  return events;
};

const getWebhookCallLabel = (direction: "incoming" | "outgoing", status: "ringing" | "missed" | "ongoing" | "ended" | "failed") => {
  if (status === "missed") return direction === "incoming" ? "Missed voice call" : "Missed outgoing call";
  if (status === "ringing") return direction === "incoming" ? "Incoming voice call" : "Outgoing voice call";
  if (status === "failed") return direction === "incoming" ? "Incoming call failed" : "Outgoing call failed";
  if (status === "ended") return direction === "incoming" ? "Completed incoming call" : "Completed outgoing call";
  return direction === "incoming" ? "Incoming voice call" : "Outgoing voice call";
};

const inferWebhookCallDirection = (message: any, contact: any, metadata: any): "incoming" | "outgoing" => {
  const callPayload = message?.call || message || {};
  const contactWaId = contact?.wa_id || "";
  const callFrom = callPayload?.from || message?.from || "";
  const callTo = callPayload?.to || message?.to || "";
  const businessNumber = metadata?.display_phone_number || "";
  const directionHints = `${callPayload?.direction || ""} ${message?.direction || ""}`.toLowerCase();
  const directionToken = normalizeCallEventToken(callPayload?.direction || message?.direction || "");

  if (directionToken === "user_initiated") {
    return "incoming";
  }

  if (directionToken === "business_initiated") {
    return "outgoing";
  }

  if (contactWaId) {
    if (phonesMatch(callFrom, contactWaId) && !phonesMatch(callTo, contactWaId)) {
      return "incoming";
    }
    if (phonesMatch(callTo, contactWaId) && !phonesMatch(callFrom, contactWaId)) {
      return "outgoing";
    }
  }

  if (businessNumber) {
    if (phonesMatch(callTo, businessNumber) && !phonesMatch(callFrom, businessNumber)) {
      return "incoming";
    }
    if (phonesMatch(callFrom, businessNumber) && !phonesMatch(callTo, businessNumber)) {
      return "outgoing";
    }
  }

  return /outgoing|dialed|agent/.test(directionHints) ? "outgoing" : "incoming";
};

const normalizeWebhookCallSession = (raw: any) => {
  const rawPayload = raw?.call || raw || {};
  const sdp =
    rawPayload?.session?.sdp ||
    rawPayload?.session_description?.sdp ||
    rawPayload?.sessionDescription?.sdp ||
    raw?.session?.sdp ||
    raw?.session_description?.sdp ||
    raw?.sessionDescription?.sdp;
  const rawType =
    rawPayload?.session?.sdp_type ||
    rawPayload?.session?.sdpType ||
    rawPayload?.session?.type ||
    rawPayload?.session_description?.sdp_type ||
    rawPayload?.session_description?.sdpType ||
    rawPayload?.session_description?.type ||
    rawPayload?.sessionDescription?.sdp_type ||
    rawPayload?.sessionDescription?.sdpType ||
    rawPayload?.sessionDescription?.type ||
    raw?.session?.sdp_type ||
    raw?.session?.sdpType ||
    raw?.session?.type ||
    raw?.session_description?.sdp_type ||
    raw?.session_description?.sdpType ||
    raw?.session_description?.type ||
    raw?.sessionDescription?.sdp_type ||
    raw?.sessionDescription?.sdpType ||
    raw?.sessionDescription?.type;
  const sdpType = String(rawType || "").toLowerCase();

  if (!sdp || !["offer", "answer", "pranswer"].includes(sdpType)) {
    return null;
  }

  return {
    sdpType,
    sdp
  };
};

const inferWebhookCallStatus = (
  message: any,
  direction: "incoming" | "outgoing",
  lowerText: string,
  structuredMeta: string
): "ringing" | "missed" | "ongoing" | "ended" | "failed" => {
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
};

const inferCallInfoFromWebhookMessage = (message: any, contact: any, metadata: any) => {
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
      ? message.errors.map((error: any) => `${error?.title || ""} ${error?.message || ""}`.trim()).join(" ")
      : ""
  ].filter(Boolean).join(" ").toLowerCase();

  const structuredMeta = JSON.stringify({
    type: message?.type,
    call: message?.call,
    system: message?.system,
    unsupported: message?.unsupported,
    errors: message?.errors
  }).toLowerCase();

  const explicitCall =
    String(message?.type || "").toLowerCase() === "call" ||
    Boolean(message?.call);
  const keywordCall = /(missed voice call|incoming voice call|outgoing voice call|voice call|video call|missed call|incoming call|outgoing call)/.test(lowerText);
  const unsupportedCall = String(message?.type || "").toLowerCase() === "unsupported" && /call/.test(structuredMeta);

  if (!(explicitCall || keywordCall || unsupportedCall)) {
    return null;
  }

  const direction = inferWebhookCallDirection(message, contact, metadata);
  const status = inferWebhookCallStatus(message, direction, lowerText, structuredMeta);

  return {
    direction,
    status,
    label: getWebhookCallLabel(direction, status),
    mode: "voice" as const
  };
};

const supportedWebhookMediaTypes = ["image", "video", "audio", "document", "sticker"] as const;
type SupportedWebhookMediaType = typeof supportedWebhookMediaTypes[number];

const isSupportedWebhookMediaType = (value: any): value is SupportedWebhookMediaType =>
  supportedWebhookMediaTypes.includes(String(value || "").toLowerCase() as SupportedWebhookMediaType);

const getWebhookMediaLabel = (mediaType?: string | null) => {
  const normalizedType = String(mediaType || "").toLowerCase();
  if (normalizedType === "image") return "Image";
  if (normalizedType === "video") return "Video";
  if (normalizedType === "audio") return "Audio";
  if (normalizedType === "document") return "Document";
  if (normalizedType === "sticker") return "Sticker";
  return "Media";
};

const inferWebhookMediaInfo = (message: any) => {
  const explicitType = String(message?.type || "").toLowerCase();
  const mediaType =
    supportedWebhookMediaTypes.find((candidate) => Boolean(message?.[candidate])) ||
    (isSupportedWebhookMediaType(explicitType) ? explicitType : "");

  if (!mediaType) {
    return null;
  }

  const mediaPayload = message?.[mediaType] || {};
  return {
    type: mediaType,
    id: String(mediaPayload?.id || ""),
    mimeType: String(mediaPayload?.mime_type || mediaPayload?.mimeType || ""),
    sha256: String(mediaPayload?.sha256 || ""),
    filename: String(mediaPayload?.filename || ""),
    caption: String(mediaPayload?.caption || message?.caption || ""),
  };
};

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v25.0";
const DEFAULT_LOCAL_APP_URL = "http://127.0.0.1:3000";
const APP_URL = (process.env.APP_URL || DEFAULT_LOCAL_APP_URL).replace(/\/$/, "");
const API_URL = (process.env.API_URL || APP_URL || DEFAULT_LOCAL_APP_URL).replace(/\/$/, "");
const RESEND_EMAIL_API_URL = "https://api.resend.com/emails";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || process.env.INVITE_FROM_EMAIL || "";
const RESEND_REPLY_TO = process.env.RESEND_REPLY_TO || process.env.INVITE_REPLY_TO || "";
const INSTAGRAM_APP_ID = process.env.INSTAGRAM_APP_ID || process.env.FACEBOOK_APP_ID || "";
const INSTAGRAM_APP_SECRET = process.env.INSTAGRAM_APP_SECRET || process.env.FACEBOOK_APP_SECRET || "";
const INSTAGRAM_OAUTH_SCOPES = [
  "instagram_basic",
  "instagram_manage_messages",
  "pages_manage_metadata",
  "pages_show_list",
];
const META_APP_ID = process.env.FACEBOOK_APP_ID || INSTAGRAM_APP_ID;
const META_APP_SECRET = process.env.FACEBOOK_APP_SECRET || INSTAGRAM_APP_SECRET;
const META_LEADS_OAUTH_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_metadata",
  "pages_manage_ads",
  "ads_management",
  "leads_retrieval",
];
const META_LEADS_TESTING_TOOL_URL = "https://developers.facebook.com/tools/lead-ads-testing";
const instagramAuthStates = new Map<string, { userId: string; createdAt: number }>();
const metaLeadAuthStates = new Map<string, { userId: string; createdAt: number }>();

const base64UrlEncode = (value: string) =>
  Buffer.from(value, "utf8").toString("base64url");

const base64UrlDecode = (value: string) =>
  Buffer.from(value, "base64url").toString("utf8");

const createInstagramState = (userId: string) => {
  const nonce = Math.random().toString(36).slice(2);
  const state = base64UrlEncode(JSON.stringify({ userId, nonce, createdAt: Date.now() }));
  instagramAuthStates.set(state, { userId, createdAt: Date.now() });
  return state;
};

const consumeInstagramState = (rawState?: string | null) => {
  if (!rawState) return null;
  const stateRecord = instagramAuthStates.get(rawState);
  if (!stateRecord) return null;
  instagramAuthStates.delete(rawState);
  if (Date.now() - stateRecord.createdAt > 15 * 60 * 1000) {
    return null;
  }

  try {
    const parsed = JSON.parse(base64UrlDecode(rawState));
    if (parsed?.userId !== stateRecord.userId) {
      return null;
    }
    return stateRecord.userId;
  } catch {
    return null;
  }
};

const createMetaLeadState = (userId: string) => {
  const nonce = Math.random().toString(36).slice(2);
  const state = base64UrlEncode(JSON.stringify({ userId, nonce, createdAt: Date.now() }));
  metaLeadAuthStates.set(state, { userId, createdAt: Date.now() });
  return state;
};

const consumeMetaLeadState = (rawState?: string | null) => {
  if (!rawState) return null;
  const stateRecord = metaLeadAuthStates.get(rawState);
  if (!stateRecord) return null;
  metaLeadAuthStates.delete(rawState);
  if (Date.now() - stateRecord.createdAt > 15 * 60 * 1000) {
    return null;
  }

  try {
    const parsed = JSON.parse(base64UrlDecode(rawState));
    if (parsed?.userId !== stateRecord.userId) {
      return null;
    }
    return stateRecord.userId;
  } catch {
    return null;
  }
};

const workspaceInviteAppLabels: Record<string, string> = {
  whatsapp: "Connektly Inbox",
  crm: "Connektly CRM",
  email: "Email Marketing",
  analytics: "Advanced Analytics",
};

const escapeHtml = (value: any) =>
  String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const getWorkspaceInviteAppLabel = (appId: any) => {
  const normalizedId = String(appId || "").trim();
  if (!normalizedId) return "";
  return workspaceInviteAppLabels[normalizedId] || normalizedId.replace(/[_-]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
};

const buildWorkspaceInviteLink = ({
  inviteeEmail,
  inviteeName,
}: {
  inviteeEmail: string;
  inviteeName: string;
}) => {
  const params = new URLSearchParams();
  params.set("mode", "signup");
  if (inviteeEmail) params.set("email", inviteeEmail);
  if (inviteeName) params.set("name", inviteeName);
  params.set("invite", "team");
  return `${APP_URL}/auth?${params.toString()}`;
};

const buildWorkspaceInviteEmail = ({
  inviteeName,
  inviteeEmail,
  inviterName,
  inviterEmail,
  role,
  title,
  assignedApps,
}: {
  inviteeName: string;
  inviteeEmail: string;
  inviterName: string;
  inviterEmail: string;
  role: string;
  title: string;
  assignedApps: string[];
}) => {
  const safeInviterName = inviterName || "A Connektly admin";
  const safeInviteeName = inviteeName || inviteeEmail || "there";
  const roleLine = role ? `Role: ${role}` : "";
  const titleLine = title ? `Title: ${title}` : "";
  const appLabels = assignedApps.length
    ? assignedApps.map(getWorkspaceInviteAppLabel).filter(Boolean)
    : ["Connektly workspace access"];
  const inviteLink = buildWorkspaceInviteLink({
    inviteeEmail,
    inviteeName,
  });
  const emailSubject = `${safeInviterName} invited you to join Connektly!`;
  const appsText = appLabels.join(", ");
  const appItemsHtml = appLabels.map((appLabel) => `<li style="margin: 0 0 8px;">${escapeHtml(appLabel)}</li>`).join("");

  return {
    inviteLink,
    emailSubject,
    text: [
      `Connektly Invite`,
      ``,
      `You have been invited to join Connektly`,
      ``,
      `Hi ${safeInviteeName},`,
      ``,
      `${safeInviterName} invited you to collaborate inside Connektly.`,
      ``,
      `Invitation details:`,
      roleLine,
      titleLine,
      `Apps: ${appsText}`,
      ``,
      `Join Now: ${inviteLink}`,
      ``,
      `If the button does not open, use this link: ${inviteLink}`,
      inviterEmail ? `Questions? Reply to ${inviterEmail}` : "",
      ``,
      `If you were not expecting this invitation, you can safely ignore this email.`,
    ].filter(Boolean).join("\n"),
    html: `
      <div style="font-family: Arial, sans-serif; background: #f5fff8; padding: 32px 18px; color: #0f172a;">
        <div style="max-width: 640px; margin: 0 auto; background: #ffffff; border: 1px solid #d1fae5; border-radius: 24px; padding: 32px;">
          <p style="margin: 0 0 12px; font-size: 11px; font-weight: 700; letter-spacing: 0.24em; text-transform: uppercase; color: #00c471;">Connektly Invite</p>
          <h1 style="margin: 0; font-size: 28px; line-height: 1.2; color: #0f172a;">You have been invited to join Connektly</h1>
          <p style="margin: 18px 0 0; font-size: 15px; line-height: 1.7; color: #475569;">
            Hi ${escapeHtml(safeInviteeName)},<br /><br />
            <strong>${escapeHtml(safeInviterName)}</strong> invited you to collaborate inside Connektly.
          </p>

          <div style="margin-top: 24px; border: 1px solid #dcfce7; background: #f0fdf4; border-radius: 18px; padding: 20px;">
            <p style="margin: 0 0 10px; font-size: 12px; font-weight: 700; letter-spacing: 0.18em; text-transform: uppercase; color: #16a34a;">Invitation details</p>
            <p style="margin: 0 0 8px; font-size: 14px; color: #0f172a;"><strong>Role:</strong> ${escapeHtml(role || "Team Member")}</p>
            ${title ? `<p style="margin: 0 0 8px; font-size: 14px; color: #0f172a;"><strong>Title:</strong> ${escapeHtml(title)}</p>` : ""}
            <p style="margin: 0; font-size: 14px; color: #0f172a;"><strong>Apps assigned:</strong></p>
            <ul style="margin: 12px 0 0 18px; padding: 0; font-size: 14px; color: #334155;">
              ${appItemsHtml}
            </ul>
          </div>

          <div style="margin-top: 28px;">
            <a href="${escapeHtml(inviteLink)}" style="display: inline-block; background: #00c471; color: #ffffff; text-decoration: none; padding: 14px 22px; border-radius: 16px; font-size: 14px; font-weight: 700;">
              Join Now
            </a>
          </div>

          <p style="margin: 20px 0 0; font-size: 13px; line-height: 1.7; color: #64748b;">
            If the button does not open, use this link:<br />
            <a href="${escapeHtml(inviteLink)}" style="color: #00a860;">${escapeHtml(inviteLink)}</a>
          </p>
          ${inviterEmail ? `<p style="margin: 16px 0 0; font-size: 13px; line-height: 1.7; color: #64748b;">Questions? Reply to <strong>${escapeHtml(inviterEmail)}</strong>.</p>` : ""}
          <p style="margin: 20px 0 0; font-size: 12px; line-height: 1.7; color: #94a3b8;">If you were not expecting this invitation, you can safely ignore this email.</p>
        </div>
      </div>
    `.trim(),
  };
};

const sendWorkspaceInviteEmail = async ({
  inviteeName,
  inviteeEmail,
  inviterName,
  inviterEmail,
  workspaceName,
  role,
  title,
  assignedApps,
}: {
  inviteeName: string;
  inviteeEmail: string;
  inviterName: string;
  inviterEmail: string;
  workspaceName: string;
  role: string;
  title: string;
  assignedApps: string[];
}) => {
  if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) {
    throw new Error("Invite email service is not configured. Add RESEND_API_KEY and RESEND_FROM_EMAIL to the server environment.");
  }

  const emailPayload = buildWorkspaceInviteEmail({
    inviteeName,
    inviteeEmail,
    inviterName,
    inviterEmail,
    role,
    title,
    assignedApps,
  });

  const response = await axios.post(
    RESEND_EMAIL_API_URL,
    {
      from: RESEND_FROM_EMAIL,
      to: [inviteeEmail],
      subject: emailPayload.emailSubject,
      html: emailPayload.html,
      text: emailPayload.text,
      ...(RESEND_REPLY_TO ? { reply_to: RESEND_REPLY_TO } : inviterEmail ? { reply_to: inviterEmail } : {}),
    },
    {
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );

  return {
    inviteLink: emailPayload.inviteLink,
    sentAt: new Date().toISOString(),
    emailId: response.data?.id || null,
  };
};

const buildInstagramRedirectUrl = (status: "success" | "error", message: string) =>
  `${APP_URL}/whatsapp?tab=channel_status&channel=instagram&ig_status=${encodeURIComponent(status)}&ig_message=${encodeURIComponent(message)}`;

const buildMetaLeadCaptureRedirectUrl = (status: "success" | "error", message: string) =>
  `${APP_URL}/crm?view=meta_setup&meta_status=${encodeURIComponent(status)}&meta_message=${encodeURIComponent(message)}`;

const exchangeInstagramCodeForUserToken = async (code: string) => {
  const response = await axios.get("https://graph.facebook.com/oauth/access_token", {
    params: {
      client_id: INSTAGRAM_APP_ID,
      client_secret: INSTAGRAM_APP_SECRET,
      redirect_uri: `${API_URL}/api/ig/auth/callback`,
      code,
    },
  });

  return response.data?.access_token as string;
};

const exchangeForLongLivedUserToken = async (
  shortLivedToken: string,
  appId: string = INSTAGRAM_APP_ID,
  appSecret: string = INSTAGRAM_APP_SECRET
) => {
  const response = await axios.get(`https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`, {
    params: {
      grant_type: "fb_exchange_token",
      client_id: appId,
      client_secret: appSecret,
      fb_exchange_token: shortLivedToken,
    },
  });

  return {
    accessToken: response.data?.access_token as string,
    expiresIn: response.data?.expires_in as number | undefined,
  };
};

const exchangeMetaLeadsCodeForUserToken = async (code: string) => {
  const response = await axios.get("https://graph.facebook.com/oauth/access_token", {
    params: {
      client_id: META_APP_ID,
      client_secret: META_APP_SECRET,
      redirect_uri: `${API_URL}/api/meta/leads/callback`,
      code,
    },
  });

  return response.data?.access_token as string;
};

const normalizeMetaLeadFieldName = (value: any) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

const readMetaLeadFieldValue = (leadData: any, candidates: string[]) => {
  const wantedNames = new Set(candidates.map(normalizeMetaLeadFieldName));
  const fieldData = Array.isArray(leadData?.field_data) ? leadData.field_data : [];

  for (const field of fieldData) {
    const normalizedFieldName = normalizeMetaLeadFieldName(field?.name);
    if (!wantedNames.has(normalizedFieldName)) continue;
    const rawValues = Array.isArray(field?.values) ? field.values : [];
    const firstValue = rawValues[0];
    if (firstValue == null) continue;
    const trimmedValue = String(firstValue).trim();
    if (trimmedValue) {
      return trimmedValue;
    }
  }

  return "";
};

const formatMetaTimestampIso = (value: any) => {
  if (!value) return new Date().toISOString();
  const parsedDate = new Date(value);
  if (!Number.isNaN(parsedDate.getTime())) {
    return parsedDate.toISOString();
  }

  const numericValue = Number(value);
  if (!Number.isNaN(numericValue)) {
    const milliseconds = numericValue < 10_000_000_000 ? numericValue * 1000 : numericValue;
    return new Date(milliseconds).toISOString();
  }

  return new Date().toISOString();
};

const fetchMetaLeadgenForms = async (pageId: string, pageAccessToken: string) => {
  const response = await axios.get(`https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/leadgen_forms`, {
    params: {
      access_token: pageAccessToken,
      fields: "id,name,status,locale",
      limit: 50,
    },
  });

  return Array.isArray(response.data?.data)
    ? response.data.data.map((form: any) => ({
        id: String(form?.id || ""),
        name: String(form?.name || "Untitled form"),
        status: String(form?.status || "UNKNOWN"),
        locale: String(form?.locale || ""),
      }))
    : [];
};

const listMetaLeadPages = async (userToken: string) => {
  const pagesResponse = await axios.get(`https://graph.facebook.com/${GRAPH_VERSION}/me/accounts`, {
    params: {
      access_token: userToken,
      fields: "id,name,access_token",
      limit: 50,
    },
  });

  const pages = Array.isArray(pagesResponse.data?.data) ? pagesResponse.data.data : [];

  return Promise.all(pages.map(async (page: any) => {
    const pageId = String(page?.id || "");
    const pageAccessToken = String(page?.access_token || "");
    const forms = pageId && pageAccessToken
      ? await fetchMetaLeadgenForms(pageId, pageAccessToken).catch(() => [])
      : [];

    return {
      id: pageId,
      name: String(page?.name || "Untitled Page"),
      accessToken: pageAccessToken,
      forms,
    };
  }));
};

const subscribeAppToLeadgenWebhook = async (pageId: string, pageAccessToken: string) => {
  await axios.post(`https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/subscribed_apps`, null, {
    params: {
      subscribed_fields: "leadgen",
      access_token: pageAccessToken,
    },
  });
};

const fetchMetaLeadById = async (leadId: string, pageAccessToken: string) => {
  const response = await axios.get(`https://graph.facebook.com/${GRAPH_VERSION}/${leadId}`, {
    params: {
      access_token: pageAccessToken,
      fields: "id,created_time,form_id,field_data,ad_id,adgroup_id,is_organic",
    },
  });

  return response.data || null;
};

const fetchLatestMetaLeadsForForm = async (formId: string, pageAccessToken: string) => {
  const response = await axios.get(`https://graph.facebook.com/${GRAPH_VERSION}/${formId}/leads`, {
    params: {
      access_token: pageAccessToken,
      fields: "id,created_time,form_id,field_data,ad_id,adgroup_id,is_organic",
      limit: 10,
    },
  });

  return Array.isArray(response.data?.data) ? response.data.data : [];
};

const extractMetaLeadgenEvents = (body: any) => {
  if (body?.object !== "page") {
    return [] as Array<{
      pageId: string;
      leadgenId: string;
      formId: string;
      createdTime: string;
      adId: string;
      adgroupId: string;
    }>;
  }

  return (Array.isArray(body?.entry) ? body.entry : []).flatMap((entry: any) => {
    const pageId = String(entry?.id || "");
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];

    return changes.flatMap((change: any) => {
      if (String(change?.field || "") !== "leadgen") {
        return [];
      }

      const value = change?.value || {};
      const leadgenId = String(value?.leadgen_id || "");
      if (!leadgenId) {
        return [];
      }

      return [{
        pageId: String(value?.page_id || pageId || ""),
        leadgenId,
        formId: String(value?.form_id || ""),
        createdTime: String(value?.created_time || ""),
        adId: String(value?.ad_id || ""),
        adgroupId: String(value?.adgroup_id || ""),
      }];
    });
  });
};

const ingestMetaLeadForUser = async (
  userId: string,
  userData: any,
  leadData: any,
  metaContext: {
    pageId: string;
    pageName?: string;
    formId?: string;
    formName?: string;
    captureMode: "webhook" | "manual";
  }
) => {
  const existingLeads = Array.isArray(userData?.crmSetup?.leads) ? userData.crmSetup.leads : [];
  const existingLeadSources = Array.isArray(userData?.crmSetup?.leadSources) ? userData.crmSetup.leadSources : [];
  const teamMembers = Array.isArray(userData?.crmSetup?.teamMembers) ? userData.crmSetup.teamMembers : [];
  const pipelineStages = Array.isArray(userData?.crmSetup?.pipelineStages) ? userData.crmSetup.pipelineStages : [];
  const leadgenId = String(leadData?.id || "");
  const createdAtIso = formatMetaTimestampIso(leadData?.created_time);
  const firstName = readMetaLeadFieldValue(leadData, ["first_name", "firstname"]);
  const lastName = readMetaLeadFieldValue(leadData, ["last_name", "lastname"]);
  const fullName =
    readMetaLeadFieldValue(leadData, ["full_name", "fullname", "name"]) ||
    [firstName, lastName].filter(Boolean).join(" ").trim() ||
    `Meta Lead ${leadgenId.slice(-6) || Date.now()}`;
  const email = readMetaLeadFieldValue(leadData, ["email", "email_address"]).trim();
  const phone = normalizePhoneDigits(
    readMetaLeadFieldValue(leadData, ["phone_number", "phone", "mobile_phone", "contact_number", "whatsapp_number"])
  );
  const company =
    readMetaLeadFieldValue(leadData, ["company_name", "company", "business_name"]) ||
    metaContext.pageName ||
    "Meta Lead";
  const ownerName =
    teamMembers[0]?.name ||
    userData?.crmSetup?.ownerName ||
    userData?.displayName ||
    "Workspace Owner";
  const stageName = pipelineStages[0] || "New Lead";
  const remarkText = `Captured from Meta Lead Ads${metaContext.pageName ? ` on ${metaContext.pageName}` : ""}${metaContext.formName ? ` via ${metaContext.formName}` : ""}.`;

  const duplicateLead = existingLeads.find((existingLead: any) => {
    const existingPhone = normalizePhoneDigits(existingLead?.phone || "");
    const existingEmail = String(existingLead?.email || "").trim().toLowerCase();
    return (leadgenId && String(existingLead?.metaLeadgenId || "") === leadgenId) ||
      (phone && existingPhone === phone) ||
      (email && existingEmail === email.toLowerCase());
  });

  const nextLead = duplicateLead
    ? null
    : {
        id: `meta-${leadgenId || Date.now()}`,
        name: fullName,
        company,
        email,
        phone,
        stage: stageName,
        source: "Meta Ads",
        owner: ownerName,
        value: "INR 0",
        lastTouch: "Just now",
        note: remarkText,
        primaryRemark: remarkText,
        dateAdded: createdAtIso,
        remarks: [{
          id: `meta-remark-${leadgenId || Date.now()}`,
          text: remarkText,
          createdAt: createdAtIso,
          author: "Meta Lead Ads",
        }],
        temperature: "warm",
        metaLeadgenId: leadgenId,
        metaFormId: String(leadData?.form_id || metaContext.formId || ""),
        metaPageId: metaContext.pageId,
        metaCaptureMode: metaContext.captureMode,
      };

  const currentMetaLeadCapture = userData?.crmSetup?.metaLeadCapture || {};
  const configuredAt = new Date().toISOString();
  const nextMetaLeadCapture = {
    ...currentMetaLeadCapture,
    connected: true,
    status: "configured",
    pageId: metaContext.pageId || currentMetaLeadCapture.pageId || "",
    pageName: metaContext.pageName || currentMetaLeadCapture.pageName || "",
    formId: String(leadData?.form_id || metaContext.formId || currentMetaLeadCapture.formId || ""),
    formName: metaContext.formName || currentMetaLeadCapture.formName || "",
    testingToolUrl: META_LEADS_TESTING_TOOL_URL,
    webhookUrl: `${API_URL}/meta/webhook`,
    configuredAt,
    lastWebhookLeadId: leadgenId || currentMetaLeadCapture.lastWebhookLeadId || "",
    lastWebhookLeadAt: createdAtIso,
    lastRetrievedLeadId: leadgenId || currentMetaLeadCapture.lastRetrievedLeadId || "",
    lastRetrievedLeadAt: configuredAt,
    updatedAt: configuredAt,
  };

  await db.collection("users").doc(userId).set({
    crmSetup: {
      metaLeadCapture: nextMetaLeadCapture,
      metaLeadCaptureConfigured: true,
      metaLeadCaptureConfiguredAt: configuredAt,
      leadSources: Array.from(new Set([...existingLeadSources, "Meta Ads"])).filter(Boolean),
      ...(nextLead ? { leads: [nextLead, ...existingLeads] } : {}),
    },
  }, { merge: true });

  return {
    duplicate: Boolean(duplicateLead),
    leadgenId,
    configuredAt,
  };
};

const findInstagramPageConnection = async (userToken: string) => {
  const pagesResponse = await axios.get(`https://graph.facebook.com/${GRAPH_VERSION}/me/accounts`, {
    params: {
      access_token: userToken,
      fields: "id,name,access_token,instagram_business_account{id,username,name,profile_picture_url}",
      limit: 50,
    },
  });

  const pages = Array.isArray(pagesResponse.data?.data) ? pagesResponse.data.data : [];
  const connectedPage = pages.find((page: any) => page.instagram_business_account?.id);

  if (!connectedPage) {
    return null;
  }

  return {
    pageId: connectedPage.id as string,
    pageName: connectedPage.name as string,
    pageAccessToken: connectedPage.access_token as string,
    instagramAccountId: connectedPage.instagram_business_account.id as string,
    instagramUsername: connectedPage.instagram_business_account.username as string | undefined,
    instagramName: connectedPage.instagram_business_account.name as string | undefined,
    instagramProfilePictureUrl: connectedPage.instagram_business_account.profile_picture_url as string | undefined,
  };
};

async function startServer() {
  const app = express();
  const server = http.createServer(app);
  const PORT = Number(process.env.PORT || 3000);
  console.log("Webhook URL:");
  console.log(`${API_URL}/meta/webhook`);
  if (false) {
  console.log("🌍 Webhook URL:");
console.log(`${API_URL}/meta/webhook`);
  }
  const multipartUpload = multer({ storage: multer.memoryStorage() });

  // WebSocket Server
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();
  const clientSessions = new Map<WebSocket, { userId?: string; phoneNumberId?: string }>();
  const sendSocketJson = (client: WebSocket, payload: any) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(payload));
    }
  };

  const sendCallDiagnostic = (
    sessions: Array<[WebSocket, { userId?: string; phoneNumberId?: string }]>,
    payload: Record<string, any>
  ) => {
    sessions.forEach(([client]) => {
      sendSocketJson(client, {
        type: "call_diagnostics",
        payload: {
          timestamp: Date.now(),
          ...payload,
        },
      });
    });
  };

  wss.on("connection", (ws) => {
    clients.add(ws);
    clientSessions.set(ws, {});
    console.log("New WebSocket client connected");

    ws.on("message", (rawMessage) => {
      try {
        const payload = JSON.parse(String(rawMessage || ""));
        if (payload?.type === "register_dashboard") {
          const nextSession = {
            userId: typeof payload.userId === "string" && payload.userId ? payload.userId : undefined,
            phoneNumberId: typeof payload.phoneNumberId === "string" && payload.phoneNumberId ? payload.phoneNumberId : undefined,
          };
          clientSessions.set(ws, nextSession);
          sendSocketJson(ws, {
            type: "call_diagnostics",
            payload: {
              kind: "socket_registration",
              timestamp: Date.now(),
              userId: nextSession.userId || null,
              phoneNumberId: nextSession.phoneNumberId || null,
              note: "Dashboard registered for live call routing.",
            },
          });
        }
      } catch {
        // Ignore non-JSON client messages.
      }
    });

    ws.on("close", () => {
      clients.delete(ws);
       clientSessions.delete(ws);
      console.log("WebSocket client disconnected");
    });
  });

  server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url || "", `http://${request.headers.host}`).pathname;
    if (pathname === "/ws") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  const allowedCorsOrigins = getAllowedCorsOrigins();

  app.use((req, res, next) => {
    const requestOrigin = String(req.headers.origin || "").trim();
    if (requestOrigin && allowedCorsOrigins.has(requestOrigin)) {
      res.setHeader("Access-Control-Allow-Origin", requestOrigin);
      res.setHeader("Vary", "Origin");
    }

    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-WhatsApp-Access-Token, X-Workspace-Access-Token, X-Firebase-Authorization, X-Firebase-Session-Token");

    if (req.method === "OPTIONS") {
      return res.status(204).end();
    }

    next();
  });

  app.use(express.json({ limit: "2mb" }));

  app.post("/api/workspace/send-invite", async (req, res) => {
    const idToken = getRequestAccessToken(req.headers.authorization);
    if (!idToken) {
      return res.status(401).json({ error: "Missing Firebase session token." });
    }

    let decodedToken;

    try {
      decodedToken = await getAuth(firebaseAdminApp).verifyIdToken(idToken);
    } catch (error: any) {
      console.error("Firebase session token verification failed:", error?.message || error);
      return res.status(401).json({
        error: isFirebaseSessionTokenError(error)
          ? "Invalid Firebase session token. Please sign in again. If the issue continues, confirm the frontend Firebase config and backend admin credentials use the same Firebase project."
          : "Unable to verify the Firebase session for this request."
      });
    }

    try {
      const inviterUserId = String(req.body?.inviterUserId || "").trim();

      if (!inviterUserId || inviterUserId !== decodedToken.uid) {
        return res.status(403).json({ error: "Invite request does not match the authenticated user." });
      }

      const inviterSnapshot = await db.collection("users").doc(decodedToken.uid).get();
      const inviterProfile = inviterSnapshot.exists ? inviterSnapshot.data() || {} : {};
      const inviteeName = String(req.body?.inviteeName || "").trim();
      const inviteeEmail = String(req.body?.inviteeEmail || "").trim().toLowerCase();
      const workspaceName = String(
        req.body?.workspaceName ||
        inviterProfile?.companyName ||
        inviterProfile?.displayName ||
        "Connektly Workspace"
      ).trim();
      const inviterName = String(
        req.body?.inviterName ||
        inviterProfile?.displayName ||
        decodedToken.name ||
        decodedToken.email ||
        "A Connektly admin"
      ).trim();
      const inviterEmail = String(
        req.body?.inviterEmail ||
        inviterProfile?.emailAddress ||
        inviterProfile?.email ||
        decodedToken.email ||
        ""
      ).trim();
      const role = String(req.body?.role || "Team Member").trim();
      const title = String(req.body?.title || "").trim();
      const assignedApps = Array.isArray(req.body?.assignedApps)
        ? req.body.assignedApps.map((entry: any) => String(entry || "").trim()).filter(Boolean)
        : [];

      if (!inviteeEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inviteeEmail)) {
        return res.status(400).json({ error: "A valid invitee email address is required." });
      }

      const inviteEmailResult = await sendWorkspaceInviteEmail({
        inviteeName,
        inviteeEmail,
        inviterName,
        inviterEmail,
        workspaceName,
        role,
        title,
        assignedApps,
      });

      return res.status(200).json({
        ok: true,
        provider: "resend",
        sentAt: inviteEmailResult.sentAt,
        inviteLink: inviteEmailResult.inviteLink,
        emailId: inviteEmailResult.emailId,
      });
    } catch (error: any) {
      const providerMessage =
        error?.response?.data?.message ||
        error?.response?.data?.error?.message ||
        error?.response?.data?.error ||
        error?.message ||
        "Unable to send the workspace invitation email right now.";
      const statusCode = error?.response?.status || (String(providerMessage).includes("configured") ? 503 : 500);

      console.error("Workspace invite email error:", error?.response?.data || error);
      return res.status(statusCode).json({ error: String(providerMessage) });
    }
  });

  app.get("/api/ig/auth/start", async (req, res) => {
    const userId = typeof req.query.uid === "string" ? req.query.uid : "";

    if (!INSTAGRAM_APP_ID || !INSTAGRAM_APP_SECRET) {
      return res.status(500).json({ error: "Instagram app credentials are not configured on the server." });
    }

    if (!userId) {
      return res.status(400).json({ error: "Missing uid query parameter." });
    }

    const authUrl = new URL(`https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`);
    authUrl.searchParams.set("client_id", INSTAGRAM_APP_ID);
    authUrl.searchParams.set("redirect_uri", `${API_URL}/api/ig/auth/callback`);
    authUrl.searchParams.set("scope", INSTAGRAM_OAUTH_SCOPES.join(","));
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("state", createInstagramState(userId));

    return res.redirect(authUrl.toString());
  });

  app.get("/api/ig/auth/callback", async (req, res) => {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const errorReason = typeof req.query.error_reason === "string" ? req.query.error_reason : "";
    const errorDescription = typeof req.query.error_description === "string" ? req.query.error_description : "";
    const userId = consumeInstagramState(typeof req.query.state === "string" ? req.query.state : null);

    if (errorReason || errorDescription) {
      return res.redirect(buildInstagramRedirectUrl("error", errorDescription || errorReason || "Instagram connection was cancelled."));
    }

    if (!userId) {
      return res.redirect(buildInstagramRedirectUrl("error", "Instagram login session expired. Please try again."));
    }

    if (!code) {
      return res.redirect(buildInstagramRedirectUrl("error", "Instagram login did not return an authorization code."));
    }

    try {
      const shortLivedToken = await exchangeInstagramCodeForUserToken(code);
      const longLivedToken = await exchangeForLongLivedUserToken(shortLivedToken);
      const connection = await findInstagramPageConnection(longLivedToken.accessToken);

      if (!connection) {
        return res.redirect(buildInstagramRedirectUrl("error", "No Instagram Business account was found on the connected Facebook Pages."));
      }

      await db.collection("users").doc(userId).set({
        channelConnections: {
          instagram: true,
        },
        instagramConnection: {
          connected: true,
          appId: INSTAGRAM_APP_ID,
          pageId: connection.pageId,
          pageName: connection.pageName,
          pageAccessToken: connection.pageAccessToken,
          userAccessToken: longLivedToken.accessToken,
          userTokenExpiresIn: longLivedToken.expiresIn || null,
          instagramAccountId: connection.instagramAccountId,
          instagramUsername: connection.instagramUsername || null,
          instagramName: connection.instagramName || null,
          instagramProfilePictureUrl: connection.instagramProfilePictureUrl || null,
          scopes: INSTAGRAM_OAUTH_SCOPES,
          connectedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        toolSetup: {
          instagram: true,
        },
      }, { merge: true });

      return res.redirect(buildInstagramRedirectUrl("success", "Instagram Business account connected successfully."));
    } catch (error: any) {
      console.error("Instagram OAuth callback failed:", error.response?.data || error.message);
      return res.redirect(buildInstagramRedirectUrl("error", "Instagram connection failed. Please verify your Meta app permissions and try again."));
    }
  });

  app.get("/api/meta/leads/auth/start", async (req, res) => {
    const userId = typeof req.query.uid === "string" ? req.query.uid : "";

    if (!META_APP_ID || !META_APP_SECRET) {
      return res.status(500).json({ error: "Meta app credentials are not configured on the server." });
    }

    if (!userId) {
      return res.status(400).json({ error: "Missing uid query parameter." });
    }

    const authUrl = new URL(`https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`);
    authUrl.searchParams.set("client_id", META_APP_ID);
    authUrl.searchParams.set("redirect_uri", `${API_URL}/api/meta/leads/callback`);
    authUrl.searchParams.set("scope", META_LEADS_OAUTH_SCOPES.join(","));
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("state", createMetaLeadState(userId));

    return res.redirect(authUrl.toString());
  });

  app.get("/api/meta/leads/callback", async (req, res) => {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const errorReason = typeof req.query.error_reason === "string" ? req.query.error_reason : "";
    const errorDescription = typeof req.query.error_description === "string" ? req.query.error_description : "";
    const userId = consumeMetaLeadState(typeof req.query.state === "string" ? req.query.state : null);

    if (errorReason || errorDescription) {
      return res.redirect(buildMetaLeadCaptureRedirectUrl("error", errorDescription || errorReason || "Meta lead capture connection was cancelled."));
    }

    if (!userId) {
      return res.redirect(buildMetaLeadCaptureRedirectUrl("error", "Meta login session expired. Please try again."));
    }

    if (!code) {
      return res.redirect(buildMetaLeadCaptureRedirectUrl("error", "Meta login did not return an authorization code."));
    }

    try {
      const shortLivedToken = await exchangeMetaLeadsCodeForUserToken(code);
      const longLivedToken = await exchangeForLongLivedUserToken(shortLivedToken, META_APP_ID, META_APP_SECRET);
      const pages = await listMetaLeadPages(longLivedToken.accessToken);

      await db.collection("users").doc(userId).set({
        crmSetup: {
          metaLeadCapture: {
            connected: pages.length > 0,
            status: pages.length > 0 ? "page_selection" : "needs_page_access",
            userAccessToken: longLivedToken.accessToken,
            userTokenExpiresIn: longLivedToken.expiresIn || null,
            pages,
            testingToolUrl: META_LEADS_TESTING_TOOL_URL,
            webhookUrl: `${API_URL}/meta/webhook`,
            scopes: META_LEADS_OAUTH_SCOPES,
            connectedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        },
      }, { merge: true });

      if (!pages.length) {
        return res.redirect(buildMetaLeadCaptureRedirectUrl("error", "No Facebook Pages were found on this Meta account."));
      }

      return res.redirect(buildMetaLeadCaptureRedirectUrl("success", "Meta account connected. Select the Page and instant form to finish lead capture setup."));
    } catch (error: any) {
      console.error("Meta lead capture OAuth callback failed:", error.response?.data || error.message);
      return res.redirect(buildMetaLeadCaptureRedirectUrl("error", "Meta lead capture connection failed. Please verify your app permissions and try again."));
    }
  });

  app.get("/api/meta/leads/forms", async (req, res) => {
    const userId = typeof req.query.uid === "string" ? req.query.uid : "";
    const pageId = typeof req.query.pageId === "string" ? req.query.pageId : "";

    if (!userId || !pageId) {
      return res.status(400).json({ error: "Both uid and pageId are required." });
    }

    try {
      const userDoc = await db.collection("users").doc(userId).get();
      const userData = userDoc.data() || {};
      const metaLeadCapture = userData?.crmSetup?.metaLeadCapture || {};
      const pages = Array.isArray(metaLeadCapture.pages) ? metaLeadCapture.pages : [];
      const selectedPage = pages.find((page: any) => String(page?.id || "") === pageId);

      if (!selectedPage?.accessToken) {
        return res.status(404).json({ error: "The selected Meta Page is not available for this workspace." });
      }

      const forms = await fetchMetaLeadgenForms(pageId, selectedPage.accessToken);
      const nextPages = pages.map((page: any) => String(page?.id || "") === pageId
        ? { ...page, forms }
        : page
      );

      await db.collection("users").doc(userId).set({
        crmSetup: {
          metaLeadCapture: {
            ...metaLeadCapture,
            pages: nextPages,
            updatedAt: new Date().toISOString(),
          },
        },
      }, { merge: true });

      return res.json({ success: true, forms });
    } catch (error: any) {
      console.error("Fetching Meta leadgen forms failed:", error.response?.data || error.message);
      return res.status(500).json({ error: "Unable to load lead forms for the selected Meta Page." });
    }
  });

  app.post("/api/meta/leads/connect-page", async (req, res) => {
    const { uid: userId, pageId, formId } = req.body || {};

    if (!userId || typeof userId !== "string" || !pageId || typeof pageId !== "string") {
      return res.status(400).json({ error: "Both uid and pageId are required." });
    }

    try {
      const userRef = db.collection("users").doc(userId);
      const userDoc = await userRef.get();
      const userData = userDoc.data() || {};
      const metaLeadCapture = userData?.crmSetup?.metaLeadCapture || {};
      const pages = Array.isArray(metaLeadCapture.pages) ? metaLeadCapture.pages : [];
      const selectedPage = pages.find((page: any) => String(page?.id || "") === pageId);

      if (!selectedPage?.accessToken) {
        return res.status(404).json({ error: "The selected Meta Page is not available for this workspace." });
      }

      const forms = await fetchMetaLeadgenForms(pageId, selectedPage.accessToken);
      const selectedForm = forms.find((form: any) => form.id === formId) || forms[0] || null;

      if (!selectedForm) {
        return res.status(400).json({ error: "No instant lead form was found on the selected Meta Page yet." });
      }

      await subscribeAppToLeadgenWebhook(pageId, selectedPage.accessToken);

      const nextPages = pages.map((page: any) => String(page?.id || "") === pageId
        ? { ...page, forms }
        : page
      );

      await userRef.set({
        crmSetup: {
          metaLeadCapture: {
            ...metaLeadCapture,
            connected: true,
            status: "pending_test",
            pages: nextPages,
            pageId,
            pageName: selectedPage.name,
            pageAccessToken: selectedPage.accessToken,
            formId: selectedForm.id,
            formName: selectedForm.name,
            forms,
            testingToolUrl: META_LEADS_TESTING_TOOL_URL,
            webhookUrl: `${API_URL}/meta/webhook`,
            updatedAt: new Date().toISOString(),
          },
          metaLeadCaptureConfigured: false,
        },
      }, { merge: true });

      return res.json({
        success: true,
        page: { id: pageId, name: selectedPage.name },
        form: selectedForm,
        forms,
        message: "Meta Page connected. Submit a test lead from the official Lead Ads Testing Tool, then retrieve it here.",
      });
    } catch (error: any) {
      console.error("Connecting Meta Page to CRM failed:", error.response?.data || error.message);
      return res.status(500).json({
        error: error.response?.data?.error?.message || "Unable to connect the selected Meta Page to Connektly CRM.",
      });
    }
  });

  app.post("/api/meta/leads/retrieve-test", async (req, res) => {
    const { uid: userId } = req.body || {};

    if (!userId || typeof userId !== "string") {
      return res.status(400).json({ error: "A valid uid is required." });
    }

    try {
      const userRef = db.collection("users").doc(userId);
      const userDoc = await userRef.get();
      const userData = userDoc.data() || {};
      const metaLeadCapture = userData?.crmSetup?.metaLeadCapture || {};
      const pageAccessToken = String(metaLeadCapture.pageAccessToken || "");
      const formId = String(metaLeadCapture.formId || "");
      const pageId = String(metaLeadCapture.pageId || "");

      if (!pageAccessToken || !formId || !pageId) {
        return res.status(400).json({ error: "Connect a Meta Page and lead form before testing lead capture." });
      }

      const testRequestedAtMs = Date.parse(String(metaLeadCapture.lastTestRequestedAt || metaLeadCapture.connectedAt || "")) || 0;
      const latestLeads = await fetchLatestMetaLeadsForForm(formId, pageAccessToken);
      const matchingLead = latestLeads
        .slice()
        .sort((left: any, right: any) => new Date(right?.created_time || 0).getTime() - new Date(left?.created_time || 0).getTime())
        .find((lead: any) => {
          const createdAtMs = new Date(lead?.created_time || 0).getTime();
          return !testRequestedAtMs || createdAtMs >= testRequestedAtMs;
        });

      if (!matchingLead?.id) {
        await userRef.set({
          crmSetup: {
            metaLeadCapture: {
              ...metaLeadCapture,
              status: "pending_test",
              updatedAt: new Date().toISOString(),
            },
            metaLeadCaptureConfigured: false,
          },
        }, { merge: true });

        return res.status(404).json({
          error: "No fresh test lead was found yet. Submit one from Meta's official Lead Ads Testing Tool, then try again.",
        });
      }

      const leadDetails = await fetchMetaLeadById(String(matchingLead.id), pageAccessToken);
      const ingestResult = await ingestMetaLeadForUser(userId, userData, leadDetails, {
        pageId,
        pageName: metaLeadCapture.pageName,
        formId,
        formName: metaLeadCapture.formName,
        captureMode: "manual",
      });

      return res.json({
        success: true,
        configured: true,
        leadgenId: ingestResult.leadgenId,
        duplicate: ingestResult.duplicate,
        message: ingestResult.duplicate
          ? "A recent Meta test lead was received. CRM was already holding this lead, so no duplicate was created."
          : "Test lead received and added to CRM successfully.",
      });
    } catch (error: any) {
      console.error("Retrieving Meta test lead failed:", error.response?.data || error.message);
      return res.status(500).json({
        error: error.response?.data?.error?.message || "Unable to retrieve the latest Meta test lead right now.",
      });
    }
  });

  app.post("/api/webhooks/test", async (req, res) => {
    const { webhookUrl, payload } = req.body || {};

    if (!webhookUrl || typeof webhookUrl !== "string") {
      return res.status(400).json({ success: false, message: "A valid webhook URL is required." });
    }

    try {
      const parsedUrl = new URL(webhookUrl);
      if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        return res.status(400).json({ success: false, message: "Webhook URL must start with http:// or https://." });
      }
    } catch {
      return res.status(400).json({ success: false, message: "Webhook URL is not valid." });
    }

    const samplePayload = payload || {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "1234567890",
          changes: [
            {
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "1234567890",
                  phone_number_id: "1234567890"
                },
                contacts: [
                  {
                    profile: {
                      name: "Test User"
                    },
                    wa_id: "1234567890"
                  }
                ],
                messages: [
                  {
                    from: "1234567890",
                    id: "wamid.test.webhook",
                    timestamp: Math.floor(Date.now() / 1000).toString(),
                    text: {
                      body: "This is a test message from Visionary Webhook Tester."
                    },
                    type: "text"
                  }
                ]
              },
              field: "messages"
            }
          ]
        }
      ]
    };

    try {
      const response = await axios.post(webhookUrl, samplePayload, {
        headers: {
          "Content-Type": "application/json"
        },
        timeout: 10000,
        validateStatus: () => true
      });

      const success = response.status >= 200 && response.status < 300;
      return res.status(success ? 200 : 502).json({
        success,
        status: response.status,
        message: `Destination responded with ${response.status} ${response.statusText}`
      });
    } catch (error: any) {
      return res.status(502).json({
        success: false,
        message: error.code === "ECONNABORTED"
          ? "Webhook test timed out after 10 seconds."
          : (error.message || "Failed to reach webhook URL")
      });
    }
  });

  // Webhook for WhatsApp / Meta
  app.get(webhookRoutes, (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  const expectedToken = getWebhookVerifyToken();
  console.log("Webhook GET request received.");
  if (false) {

  console.log("🔔 Webhook GET hit:", {
    path: req.path,
    mode,
    hasToken: Boolean(token),
    hasChallenge: Boolean(challenge),
  });
  }

  // ✅ Health check (VERY IMPORTANT)
  if (!mode && !token) {
    return res.status(200).json({
      status: "ok",
      message: "Webhook endpoint is live",
      path: req.path,
    });
  }

  // ❗ Missing env token
  if (!expectedToken) {
    console.error("Webhook verification failed because META_VERIFY_TOKEN is not configured.");
    if (false) {
    console.error("❌ META_VERIFY_TOKEN NOT SET");
    }
    return res.status(500).json({
      error: "META_VERIFY_TOKEN not configured",
    });
  }

  // ✅ Meta verification
  if (mode === "subscribe") {
    if (token === expectedToken) {
      console.log("Webhook verified successfully.");
      if (false) {
      console.log("✅ WEBHOOK VERIFIED SUCCESSFULLY");
      }
      return res.status(200).send(challenge);
    } else {
      console.error("Webhook verify token mismatch.");
      if (false) {
      console.error("❌ TOKEN MISMATCH", {
        expectedConfigured: Boolean(expectedToken),
        receivedToken: Boolean(token),
      });
      }
      return res.status(403).json({
        error: "Invalid verify token",
      });
    }
  }

  return res.status(400).json({
    error: "Invalid webhook request",
  });
});

  app.post(webhookRoutes, async (req, res) => {
  const body = req.body;
  console.log("Incoming Meta webhook request received.");
  if (false) {

  console.log("📩 Incoming Meta Webhook:", {
    path: req.path,
    object: body?.object,
  });
  }

  res.sendStatus(200); // REQUIRED for Meta

    if (body.object === "page") {
      const leadgenEvents = extractMetaLeadgenEvents(body);

      if (!leadgenEvents.length) {
        console.log("Meta page webhook received, but no leadgen events were found in the payload.");
        return;
      }

      for (const event of leadgenEvents) {
        try {
          const usersSnapshot = await db.collection("users")
            .where("crmSetup.metaLeadCapture.pageId", "==", event.pageId)
            .limit(20)
            .get();

          if (usersSnapshot.empty) {
            console.warn(`Leadgen webhook received for page_id=${event.pageId}, but no CRM workspace is connected to that Meta Page.`);
            continue;
          }

          for (const userDoc of usersSnapshot.docs) {
            const userData = userDoc.data() || {};
            const metaLeadCapture = userData?.crmSetup?.metaLeadCapture || {};
            const pageAccessToken = String(metaLeadCapture.pageAccessToken || "");

            if (!pageAccessToken) {
              console.warn(`Leadgen webhook received for user=${userDoc.id}, but no page access token is stored for Meta lead capture.`);
              continue;
            }

            const leadDetails = await fetchMetaLeadById(event.leadgenId, pageAccessToken);
            await ingestMetaLeadForUser(userDoc.id, userData, leadDetails, {
              pageId: event.pageId,
              pageName: metaLeadCapture.pageName,
              formId: event.formId || metaLeadCapture.formId,
              formName: metaLeadCapture.formName,
              captureMode: "webhook",
            });
          }
        } catch (error: any) {
          console.error("Error routing Meta leadgen webhook:", error.response?.data || error.message);
        }
      }

      return;
    }

    if (body.object !== "whatsapp_business_account") {
      return;
    }

    const inboundEvents = extractInboundWhatsappEvents(body);

    if (!inboundEvents.length) {
      console.log("Webhook received, but no inbound messages were found in the payload.");
      return;
    }

    for (const event of inboundEvents) {
      const { message, contact, metadata } = event;
      const callInfo = inferCallInfoFromWebhookMessage(message, contact, metadata);
      const callSession = callInfo ? normalizeWebhookCallSession(message) : null;
      const mediaInfo = inferWebhookMediaInfo(message);

      const messageText =
        callInfo?.label ||
        message?.text?.body ||
        message?.button?.text ||
        message?.interactive?.button_reply?.title ||
        message?.interactive?.list_reply?.title ||
        mediaInfo?.caption ||
        message?.caption ||
        (mediaInfo ? `${getWebhookMediaLabel(mediaInfo.type)}${mediaInfo.filename ? `: ${mediaInfo.filename}` : ""}` : "") ||
        "Media/Unsupported Message";
      const messageTimestamp = Number.parseInt(String(message?.timestamp || Date.now()), 10);
      const normalizedTimestamp = Number.isNaN(messageTimestamp)
        ? Date.now()
        : messageTimestamp < 10_000_000_000
          ? messageTimestamp * 1000
          : messageTimestamp;
      const targetPhoneNumberId = String(metadata?.phone_number_id || "");

      if (!targetPhoneNumberId) {
        console.warn("Inbound message received without metadata.phone_number_id. Skipping user routing.");
        continue;
      }

      const payload = {
        type: "whatsapp_message",
        payload: {
          from: message?.from,
          text: messageText,
          timestamp: normalizedTimestamp,
          name: contact?.profile?.name || message?.from,
          id: message?.id,
          callInfo,
          callId: message?.call?.id || message?.id,
          callPayload: message?.call || (callInfo ? message : null),
          session: callSession,
          mediaInfo,
          phoneNumberId: targetPhoneNumberId,
          businessNumber: metadata?.display_phone_number || ""
        }
      };

      const matchingClientSessions = Array.from(clientSessions.entries())
        .filter(([, session]) => session.phoneNumberId === targetPhoneNumberId);
      const routedUserIds = new Set<string>(matchingClientSessions.map(([, session]) => session.userId || "").filter(Boolean));
      let firestoreUsers: any[] = [];

      try {
        const usersSnapshot = await db.collection("users")
          .where("whatsappCredentials.phoneNumberId", "==", targetPhoneNumberId)
          .limit(10)
          .get();

        firestoreUsers = usersSnapshot.docs;
        firestoreUsers.forEach((userDoc) => routedUserIds.add(userDoc.id));
      } catch (err) {
        console.error("Error looking up inbound WhatsApp route in Firestore:", err);
      }

      if (!firestoreUsers.length && !matchingClientSessions.length) {
        console.warn(`Inbound message received for phone_number_id=${targetPhoneNumberId}, but no matching user workspace was found.`);
        continue;
      }

      if (matchingClientSessions.length) {
        sendCallDiagnostic(matchingClientSessions, {
          kind: "webhook_route",
          phoneNumberId: targetPhoneNumberId,
          businessNumber: metadata?.display_phone_number || "",
          callId: message?.call?.id || message?.id || null,
          callEvent: message?.call?.event || message?.event || null,
          callDirection: callInfo?.direction || null,
          callStatus: callInfo?.status || null,
          webhookDirection: message?.call?.direction || message?.direction || null,
          webhookStatus: message?.call?.status || message?.status || null,
          contactName: contact?.profile?.name || message?.from || "",
          contactPhone: message?.from || "",
          matchedClientSessions: matchingClientSessions.length,
          matchedFirestoreUsers: firestoreUsers.length,
          routedUserIds: Array.from(routedUserIds),
          note: firestoreUsers.length
            ? "Incoming call webhook reached this dashboard and matched a workspace route."
            : "Incoming call webhook reached this dashboard through live phone-number routing.",
        });
      }

      try {
        for (const userId of Array.from(routedUserIds)) {
          let userData = firestoreUsers.find(doc => doc.id === userId)?.data();
          if (!userData) {
            const userDoc = await db.collection("users").doc(userId).get();
            userData = userDoc.data();
          }
          const callLogId = message?.call?.id || message?.id || `call-${normalizedTimestamp}`;
          const inboundMessageId =
            message?.id ||
            `msg-${targetPhoneNumberId}-${normalizePhoneDigits(message?.from || "")}-${normalizedTimestamp}`;

          if (callInfo) {
            await db.collection("users").doc(userId).collection("callLogs").doc(callLogId).set({
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
              session: callSession,
              rawCallPayload: message?.call || message
            }, { merge: true });
          }

          await db.collection("users").doc(userId).collection("messages").doc(inboundMessageId).set({
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
            ...(mediaInfo ? {
              messageKind: mediaInfo.type,
              mediaType: mediaInfo.type,
              mediaId: mediaInfo.id,
              mimeType: mediaInfo.mimeType,
              caption: mediaInfo.caption,
              filename: mediaInfo.filename,
              mediaSha256: mediaInfo.sha256
            } : {}),
            ...(callInfo ? { messageKind: "call", callInfo, callPayload: message?.call || message, session: callSession } : {}),
            rawPayload: body
          }, { merge: true });

          const contactsCollection = db.collection("users").doc(userId).collection("contacts");
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

          if (userData?.webhookUrl) {
            axios.post(userData.webhookUrl, body, { timeout: 5000 }).catch((error) => {
              console.error(`Forwarding failed for ${userId}:`, error.message);
            });
          }
        }
      } catch (err) {
        console.error("Error routing inbound WhatsApp message:", err);
      }

      if (matchingClientSessions.length) {
        for (const [client, session] of matchingClientSessions) {
          sendSocketJson(client, { ...payload, targetUserId: session.userId || null });
        }
      } else {
        routedUserIds.forEach((userId) => {
          clients.forEach((client) => {
            sendSocketJson(client, { ...payload, targetUserId: userId });
          });
        });
      }
    }
  });

  app.post("/api/wa/embedded-signup", async (req, res) => {
    const { code, wabaId: requestedWabaId, phoneNumberId: requestedPhoneNumberId } = req.body;
    const appId = process.env.FACEBOOK_APP_ID || "";
    const appSecret = process.env.FACEBOOK_APP_SECRET || "";

    if (!code || !appId || !appSecret) {
      return res.status(400).json({ error: "Missing code, FACEBOOK_APP_ID, or FACEBOOK_APP_SECRET" });
    }

    try {
      // 1. Exchange code for access token
      const tokenResponse = await axios.get(`https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`, {
        params: {
          client_id: appId,
          client_secret: appSecret,
          code: code
        }
      });

      const accessToken = tokenResponse.data.access_token;

      // 2. Prefer the WABA/phone number metadata returned by the embedded signup popup.
      let wabaId = typeof requestedWabaId === "string" && requestedWabaId.trim() ? requestedWabaId.trim() : "";
      let phoneNumberId = typeof requestedPhoneNumberId === "string" && requestedPhoneNumberId.trim() ? requestedPhoneNumberId.trim() : "";

      if (!wabaId) {
        const debugResponse = await axios.get(`https://graph.facebook.com/${GRAPH_VERSION}/debug_token`, {
          params: {
            input_token: accessToken,
            access_token: `${appId}|${appSecret}`
          }
        });

        const granularScopes = debugResponse.data.data.granular_scopes;
        const wabaScope = granularScopes?.find((scope: any) => scope.scope === "whatsapp_business_management" || scope.scope === "whatsapp_business_messaging");
        wabaId = wabaScope?.target_ids?.[0] || "";
      }

      if (!wabaId) {
        return res.status(400).json({ error: "No WhatsApp Business Account found in the granted scopes." });
      }

      // 3. Get Phone Number ID if the popup did not already provide one.
      let phoneNumbers: any[] = [];
      if (!phoneNumberId) {
        const phoneNumbersResponse = await axios.get(`https://graph.facebook.com/${GRAPH_VERSION}/${wabaId}/phone_numbers`, {
          params: {
            access_token: accessToken
          }
        });

        phoneNumbers = phoneNumbersResponse.data.data || [];
        phoneNumberId = phoneNumbers[0]?.id || "";
      } else {
        phoneNumbers = [{ id: phoneNumberId }];
      }

      res.json({
        accessToken,
        wabaId,
        phoneNumberId,
        phoneNumbers
      });
    } catch (error: any) {
      console.error("Embedded signup error:", error.response?.data || error.message);
      const graphErrorMessage = error.response?.data?.error?.message;
      res.status(500).json({
        error: graphErrorMessage || "Failed to process embedded signup",
        details: error.response?.data
      });
    }
  });

  app.post("/api/wa/upload-handle", multipartUpload.single("file"), async (req, res) => {
    const authState = await resolveWhatsAppAccessToken(req.headers as Record<string, any>);
    const accessToken = authState.accessToken;
    const appId = String(req.body?.app_id || process.env.FACEBOOK_APP_ID || process.env.INSTAGRAM_APP_ID || "");
    const file = req.file;

    if (!accessToken) {
      return res.status(401).json({ error: authState.error || "No WhatsApp access token provided for this workspace" });
    }

    if (!appId) {
      return res.status(400).json({ error: "Missing Meta app ID for upload handle generation" });
    }

    if (!file) {
      return res.status(400).json({ error: "No file provided" });
    }

    try {
      const startResponse = await axios.post(`https://graph.facebook.com/${GRAPH_VERSION}/${appId}/uploads`, null, {
        params: {
          file_name: file.originalname,
          file_length: file.size,
          file_type: file.mimetype || "application/octet-stream"
        },
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      });

      const uploadSessionId = startResponse.data?.id;
      if (!uploadSessionId) {
        return res.status(502).json({ error: "Failed to create Meta upload session" });
      }

      const uploadResponse = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${uploadSessionId}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          file_offset: "0",
          "Content-Type": "application/octet-stream"
        },
        body: file.buffer
      });

      const uploadText = await uploadResponse.text();
      const uploadData = uploadText ? JSON.parse(uploadText) : {};

      if (!uploadResponse.ok) {
        return res.status(uploadResponse.status).json(uploadData);
      }

      if (!uploadData?.h) {
        return res.status(502).json({ error: "Meta upload completed but no handle was returned" });
      }

      return res.json({ handle: uploadData.h });
    } catch (error: any) {
      console.error("WhatsApp Upload Handle Error:", error.response?.data || error.message);
      return res.status(error.response?.status || 500).json(error.response?.data || { error: error.message });
    }
  });

  app.get(["/api/wa-media/:mediaId/download", "/api/wa/media/:mediaId/download"], async (req, res) => {
    const authState = await resolveWhatsAppAccessToken(req.headers as Record<string, any>);
    const accessToken = authState.accessToken;
    const mediaId = String(req.params.mediaId || "").trim();

    if (!accessToken) {
      return res.status(401).json({ error: authState.error || "No WhatsApp access token provided for this workspace" });
    }

    if (!mediaId) {
      return res.status(400).json({ error: "Missing media ID" });
    }

    try {
      const metadataResponse = await axios.get(`https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`, {
        params: {
          access_token: accessToken,
        },
      });

      const mediaUrl = String(metadataResponse.data?.url || "");
      if (!mediaUrl) {
        return res.status(404).json({ error: "Media download URL not found" });
      }

      const mediaResponse = await axios.get(mediaUrl, {
        responseType: "stream",
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      const contentType = mediaResponse.headers["content-type"] || metadataResponse.data?.mime_type || "application/octet-stream";
      const contentLength = mediaResponse.headers["content-length"];

      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "private, max-age=300");
      if (contentLength) {
        res.setHeader("Content-Length", contentLength);
      }

      mediaResponse.data.pipe(res);
    } catch (error: any) {
      console.error("WhatsApp Media Download Error:", error.response?.data || error.message);
      return res.status(error.response?.status || 500).json(error.response?.data || { error: error.message });
    }
  });

  // Proxy for WhatsApp Cloud API
  app.all("/api/wa/*", async (req, res) => {
    let targetPath = req.params[0];
    // Remove leading slash if present to avoid double slashes in the final URL
    if (targetPath.startsWith('/')) {
      targetPath = targetPath.substring(1);
    }

    const authState = await resolveWhatsAppAccessToken(req.headers as Record<string, any>);
    const accessToken = authState.accessToken;
    
    console.log(`WhatsApp Proxy Request: ${req.method} ${targetPath}`);

    if (!accessToken) {
      console.warn(`WhatsApp Proxy: ${authState.error || "No workspace access token provided"}`);
      return res.status(401).json({ error: authState.error || "No WhatsApp access token provided for this workspace" });
    }

    try {
      const url = `https://graph.facebook.com/${GRAPH_VERSION}/${targetPath}`;
      const contentTypeHeader = typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : "";
      const isMultipartRequest = contentTypeHeader.includes("multipart/form-data");

      if (isMultipartRequest) {
        await new Promise<void>((resolve, reject) => {
          multipartUpload.any()(req, res, (error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });

        const formData = new FormData();
        const bodyFields = req.body || {};

        Object.entries(bodyFields).forEach(([key, value]) => {
          if (Array.isArray(value)) {
            value.forEach((entry) => formData.append(key, String(entry)));
            return;
          }
          if (value != null) {
            formData.append(key, String(value));
          }
        });

        const files = Array.isArray(req.files) ? req.files as Express.Multer.File[] : [];
        files.forEach((file) => {
          formData.append(
            file.fieldname,
            new Blob([file.buffer], { type: file.mimetype || "application/octet-stream" }),
            file.originalname
          );
        });

        const multipartResponse = await fetch(url, {
          method: req.method,
          headers: {
            Authorization: `Bearer ${accessToken}`
          },
          body: formData
        });

        const responseText = await multipartResponse.text();
        const responseData = responseText ? JSON.parse(responseText) : {};
        return res.status(multipartResponse.status).json(responseData);
      }

      const axiosConfig: any = {
        method: req.method,
        url,
        params: req.query,
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      };

      if (req.method !== 'GET' && req.method !== 'DELETE') {
        axiosConfig.data = req.body;
        axiosConfig.headers["Content-Type"] = "application/json";
      }

      const response = await axios(axiosConfig);
      res.status(response.status).json(response.data);
    } catch (error: any) {
      const errorData = error.response?.data || { error: error.message };
      console.error("WhatsApp Proxy Error:", JSON.stringify(errorData));
      res.status(error.response?.status || 500).json(errorData);
    }
  });

  // API routes
  app.get("/api/health", (req, res) => {
    res.json({
      status: "ok",
      app: "connektly-api-backend",
      appUrl: APP_URL,
      apiUrl: API_URL,
      firebaseAdmin: {
        configured: firebaseAdminContext.hasExplicitCredentials,
        credentialSource: firebaseAdminContext.credentialSource || "application-default"
      },
      whatsapp: {
        webhookRoutes,
        verifyTokenConfigured: Boolean(getWebhookVerifyToken()),
        embeddedSignupConfigured: Boolean(process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET)
      }
    });
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
