"use strict";

const SLA_MS = 120000;

const STATUS = Object.freeze({
  UNASSIGNED: "UNASSIGNED",
  PENDING_RESPONSE: "PENDING_RESPONSE",
  ATTENDED: "ATTENDED",
  RE_OPENED: "RE_OPENED",
});

const EVENTS = Object.freeze({
  TAKE: "TAKE",
  OUTBOUND_SENT: "OUTBOUND_SENT",
  INBOUND_RECEIVED: "INBOUND_RECEIVED",
  SLA_EXPIRED: "SLA_EXPIRED",
  RELEASE: "RELEASE",
});

/**
 * @param {{ status: string, assigned_to?: number|null, sla_deadline_at?: Date|string|null }} chat
 * @param {string} event
 * @param {{ userId?: number, now?: Date }} [ctx]
 * @returns {{ nextStatus: string, assignedTo: number|null, slaDeadlineAt: Date|null }}
 */
function transition(chat, event, ctx) {
  const now = ctx && ctx.now instanceof Date ? ctx.now : new Date();
  const userId = ctx && ctx.userId != null ? Number(ctx.userId) : null;
  const st = chat && chat.status;

  if (event === EVENTS.TAKE) {
    if (userId == null || !Number.isFinite(userId)) {
      throw new Error("INVALID_TRANSITION");
    }
    // ATTENDED se acepta como origen válido (D2 · ADR-009): un humano puede retomar
    // un chat que el bot ya respondió sin necesidad de un inbound nuevo.
    if (st === STATUS.UNASSIGNED || st === STATUS.RE_OPENED || st === STATUS.ATTENDED) {
      return {
        nextStatus: STATUS.PENDING_RESPONSE,
        assignedTo: userId,
        slaDeadlineAt: new Date(now.getTime() + SLA_MS),
      };
    }
    throw new Error("INVALID_TRANSITION");
  }

  if (event === EVENTS.OUTBOUND_SENT) {
    if (st === STATUS.PENDING_RESPONSE) {
      return {
        nextStatus: STATUS.ATTENDED,
        assignedTo: chat.assigned_to != null ? Number(chat.assigned_to) : null,
        slaDeadlineAt: null,
      };
    }
    throw new Error("INVALID_TRANSITION");
  }

  if (event === EVENTS.SLA_EXPIRED) {
    if (st === STATUS.PENDING_RESPONSE) {
      return {
        nextStatus: STATUS.UNASSIGNED,
        assignedTo: null,
        slaDeadlineAt: null,
      };
    }
    throw new Error("INVALID_TRANSITION");
  }

  if (event === EVENTS.RELEASE) {
    if (userId == null || !Number.isFinite(userId)) {
      throw new Error("INVALID_TRANSITION");
    }
    if (st === STATUS.PENDING_RESPONSE) {
      const assigned = chat.assigned_to != null ? Number(chat.assigned_to) : null;
      if (assigned !== userId) {
        throw new Error("FORBIDDEN");
      }
      return {
        nextStatus: STATUS.UNASSIGNED,
        assignedTo: null,
        slaDeadlineAt: null,
      };
    }
    throw new Error("INVALID_TRANSITION");
  }

  if (event === EVENTS.INBOUND_RECEIVED) {
    if (st === STATUS.ATTENDED) {
      return {
        nextStatus: STATUS.RE_OPENED,
        assignedTo: chat.assigned_to != null ? Number(chat.assigned_to) : null,
        slaDeadlineAt: null,
      };
    }
    if (st === STATUS.RE_OPENED) {
      return {
        nextStatus: STATUS.RE_OPENED,
        assignedTo: chat.assigned_to != null ? Number(chat.assigned_to) : null,
        slaDeadlineAt: null,
      };
    }
    throw new Error("INVALID_TRANSITION");
  }

  throw new Error("INVALID_TRANSITION");
}

module.exports = {
  transition,
  STATUS,
  EVENTS,
  SLA_MS,
};
