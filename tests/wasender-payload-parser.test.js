#!/usr/bin/env node
/**
 * node tests/wasender-payload-parser.test.js
 * Formato típico Wasender: data.messages[] con key + message.
 */
"use strict";

const assert = require("assert");
const { parseWebhookJobs } = require("../src/whatsapp/payloadParser");

const body = {
  event: "messages.received",
  data: {
    pushName: "María Test",
    messages: [
      {
        key: {
          remoteJid: "584121234567@s.whatsapp.net",
          fromMe: false,
          id: "ABC123",
        },
        message: { conversation: "Hola" },
        messageTimestamp: 1710000000,
      },
    ],
  },
};

const jobs = parseWebhookJobs(body);
assert.strictEqual(jobs.length, 1);
const n = jobs[0].normalized;
assert.strictEqual(jobs[0].eventType, "messages.received");
assert.strictEqual(n.fromPhone, "584121234567");
assert.strictEqual(n.messageId, "ABC123");
assert.strictEqual(n.contactName, "María Test");
assert.strictEqual(n.content.text, "Hola");

const bodySingular = { ...body, event: "message.received" };
const jobsSingular = parseWebhookJobs(bodySingular);
assert.strictEqual(jobsSingular[0].eventType, "messages.received");

console.log("wasender-payload-parser: OK");
