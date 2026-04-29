"use strict";

/**
 * Tolerancia Bs. para vínculo manual comprobante↔extracto y para `POST .../orders/:id/reconcile`.
 * `MANUAL_BANK_LINK_TOLERANCE_BS` o `INBOX_PAYMENT_HINT_TOLERANCE_BS`; default 100.
 */
function manualBankLinkToleranceBs() {
  const n = Number(process.env.MANUAL_BANK_LINK_TOLERANCE_BS);
  if (Number.isFinite(n) && n >= 1) return Math.min(Math.floor(n), 100000);
  const n2 = Number(process.env.INBOX_PAYMENT_HINT_TOLERANCE_BS);
  if (Number.isFinite(n2) && n2 >= 1) return Math.min(Math.floor(n2), 100000);
  return 100;
}

module.exports = { manualBankLinkToleranceBs };
