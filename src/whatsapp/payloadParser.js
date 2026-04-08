"use strict";

function normalizePhoneDigits(raw) {
  return String(raw || "").replace(/\D/g, "") || null;
}

function isMetaCloudPayload(body) {
  return (
    body &&
    (body.object === "whatsapp_business_account" ||
      body.object === "whatsapp_business_api" ||
      (Array.isArray(body.entry) && body.entry.length > 0))
  );
}

function baseNormalized() {
  return {
    eventType: "messages.received",
    provider: "meta_cloud",
    messageId: null,
    fromPhone: null,
    toPhone: null,
    timestamp: Math.floor(Date.now() / 1000),
    type: "text",
    content: {
      text: null,
      mediaUrl: null,
      mimeType: null,
      caption: null,
      reaction: null,
      callStatus: null,
      duration: null,
    },
    contactName: null,
    sentBy: null,
    sessionStatus: null,
    isEdited: false,
    isForwarded: false,
    rawPayload: null,
  };
}

function normalizeMetaMessage(msg, value) {
  const n = baseNormalized();
  n.provider = "meta_cloud";
  n.messageId = msg.id != null ? String(msg.id) : null;
  n.fromPhone = normalizePhoneDigits(msg.from);
  n.timestamp = msg.timestamp != null ? Number(msg.timestamp) : n.timestamp;
  n.type = msg.type != null ? String(msg.type) : "text";
  if (msg.text?.body) n.content.text = String(msg.text.body);
  if (msg.image?.id) {
    n.type = "image";
    n.content.mediaUrl = msg.image.link || null;
    n.content.caption = msg.image.caption || null;
  }
  const contact = (value.contacts || [])[0];
  n.contactName = contact?.profile?.name || null;
  n.rawPayload = msg;
  return n;
}

function normalizeMetaReaction(msg, value) {
  const n = baseNormalized();
  n.provider = "meta_cloud";
  n.eventType = "reactions.received";
  const r = msg.reaction || {};
  n.messageId = r.message_id != null ? String(r.message_id) : null;
  n.fromPhone = normalizePhoneDigits(msg.from);
  n.timestamp = msg.timestamp != null ? Number(msg.timestamp) : n.timestamp;
  n.type = "reaction";
  n.content.reaction = r.emoji != null ? String(r.emoji) : null;
  const contact = (value.contacts || [])[0];
  n.contactName = contact?.profile?.name || null;
  n.rawPayload = msg;
  return n;
}

function normalizeMetaStatus(st) {
  const n = baseNormalized();
  n.eventType = "message-receipt.update";
  n.provider = "meta_cloud";
  n.messageId = st.id != null ? String(st.id) : null;
  n.receiptStatus = st.status != null ? String(st.status) : null;
  n.fromPhone = normalizePhoneDigits(st.recipient_id);
  n.timestamp = st.timestamp != null ? Number(st.timestamp) : n.timestamp;
  n.rawPayload = st;
  return n;
}

/**
 * Wasender / Baileys: a veces el mensaje va en `data.messages` (objeto con `key` + `message`).
 * Contactos: `data.contacts[]`.
 */
function pickMessageOrContactBlock(data, ev) {
  if (ev.startsWith("contacts.") && Array.isArray(data.contacts) && data.contacts[0]) {
    const c = data.contacts[0];
    return {
      key: { remoteJid: c.id, fromMe: false },
      message: {},
      pushName: c.notify,
      messageTimestamp: data.timestamp,
    };
  }
  if (
    data.messages &&
    typeof data.messages === "object" &&
    !Array.isArray(data.messages) &&
    data.messages.key
  ) {
    return data.messages;
  }
  return data;
}

function normalizeBaileysEnvelope(body) {
  const ev = String(body.event || body.type || "messages.received");
  const dataTop = body.data != null ? body.data : body;

  /** Wasender API: confirmación de envío (`data.jid`, `data.msgId`) */
  if (ev === "message.sent" || ev === "messages.sent") {
    const d = dataTop && typeof dataTop === "object" ? dataTop : {};
    const n = baseNormalized();
    n.provider = "wasender";
    n.eventType = "messages.sent";
    n.rawPayload = body;
    const jid = d.jid || "";
    n.toPhone = normalizePhoneDigits(String(jid).split("@")[0]);
    n.messageId = d.msgId != null ? String(d.msgId) : `wasender-sent-${Date.now()}`;
    n.timestamp =
      d.timestamp != null
        ? Math.floor(Number(d.timestamp) / 1000)
        : Math.floor(Date.now() / 1000);
    n.sentBy = "wasender_api";
    return n;
  }

  const data = pickMessageOrContactBlock(dataTop, ev);
  const n = baseNormalized();
  n.provider = "baileys";
  n.eventType = ev;
  n.rawPayload = body;

  const key = data.key || {};
  const remote = key.remoteJid || "";
  let digits = normalizePhoneDigits(remote.split("@")[0]);
  const pn = key.cleanedSenderPn || key.senderPn;
  if (pn) {
    digits = normalizePhoneDigits(String(pn).split("@")[0]) || digits;
  }
  const fromMe = key.fromMe === true || key.fromMe === "true";

  if (fromMe) {
    n.toPhone = digits;
    n.sentBy = "self";
  } else {
    n.fromPhone = digits;
  }

  n.messageId = key.id != null ? String(key.id) : `baileys-${Date.now()}`;
  n.timestamp =
    data.messageTimestamp != null
      ? Number(data.messageTimestamp) > 1e12
        ? Math.floor(Number(data.messageTimestamp) / 1000)
        : Number(data.messageTimestamp)
      : data.timestamp != null
        ? Number(data.timestamp) > 1e12
          ? Math.floor(Number(data.timestamp) / 1000)
          : Number(data.timestamp)
        : Math.floor(Date.now() / 1000);
  n.contactName = data.pushName || data.notify || null;

  if (ev.startsWith("contacts.")) {
    const jid = data.id || data.remoteJid || remote;
    n.fromPhone = normalizePhoneDigits(String(jid).split("@")[0]);
    const pn2 = key.cleanedSenderPn || key.senderPn;
    if (pn2) {
      n.fromPhone = normalizePhoneDigits(String(pn2).split("@")[0]) || n.fromPhone;
    }
    n.contactName = data.name || data.notify || n.contactName;
  }

  if (ev.startsWith("calls.")) {
    const jid = data.from || data.chatId || remote;
    n.fromPhone = normalizePhoneDigits(String(jid).split("@")[0]);
    n.content.callStatus = data.status || data.callOutcome || null;
  }

  const m = data.message || {};
  if (m.reactionMessage) {
    n.type = "reaction";
    const rk = m.reactionMessage.key || {};
    n.messageId = rk.id != null ? String(rk.id) : n.messageId;
    n.content.reaction =
      m.reactionMessage.text || m.reactionMessage.reaction || m.reactionMessage.emoji || null;
  } else if (m.conversation) {
    n.content.text = m.conversation;
    n.type = "text";
  } else if (m.extendedTextMessage?.text) {
    n.content.text = m.extendedTextMessage.text;
    n.type = "text";
  } else if (m.imageMessage) {
    n.type = "image";
    n.content.caption = m.imageMessage.caption || null;
  } else if (m.audioMessage) {
    n.type = "audio";
  } else if (m.videoMessage) {
    n.type = "video";
  } else {
    n.type = "text";
  }

  if (ev === "session.status") {
    n.sessionStatus = data.status || data.state || data.connection || null;
  }

  return n;
}

/**
 * Convierte el body del webhook en una lista de trabajos { eventType, normalized }.
 */
function parseWebhookJobs(body) {
  const provider = process.env.WA_PROVIDER === "meta_cloud" || isMetaCloudPayload(body) ? "meta_cloud" : "baileys";

  if (provider === "meta_cloud" || isMetaCloudPayload(body)) {
    const jobs = [];
    const entries = body.entry || [];
    for (const ent of entries) {
      for (const ch of ent.changes || []) {
        const value = ch.value || {};
        for (const msg of value.messages || []) {
          const mtype = msg.type != null ? String(msg.type) : "";
          if (mtype === "reaction") {
            const norm = normalizeMetaReaction(msg, value);
            jobs.push({ eventType: "reactions.received", normalized: norm });
          } else {
            const norm = normalizeMetaMessage(msg, value);
            norm.eventType = "messages.received";
            jobs.push({ eventType: "messages.received", normalized: norm });
          }
        }
        for (const st of value.statuses || []) {
          jobs.push({ eventType: "message-receipt.update", normalized: normalizeMetaStatus(st) });
        }
      }
    }
    if (jobs.length === 0 && body.entry?.length) {
      jobs.push({
        eventType: "unknown",
        normalized: { ...baseNormalized(), provider: "meta_cloud", rawPayload: body },
      });
    }
    return jobs;
  }

  const ev = String(body.event || "messages.received");
  const norm = normalizeBaileysEnvelope(body);
  let evOut = ev;

  if (ev === "message.sent") {
    evOut = "messages.sent";
  } else if (ev === "messages.upsert") {
    evOut = norm.toPhone ? "messages.sent" : "messages.received";
  } else if (ev === "messages.received" || ev === "messages-personal.received") {
    evOut = "messages.received";
  }

  if (norm.type === "reaction") {
    evOut = "reactions.received";
  }
  norm.eventType = evOut;
  return [{ eventType: evOut, normalized: norm }];
}

module.exports = {
  parseWebhookJobs,
  normalizePhoneDigits,
  isMetaCloudPayload,
};
