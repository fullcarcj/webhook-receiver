"use strict";

/**
 * OrderGateway — Normalizador de órdenes para los 5 canales
 *
 * Responsabilidades:
 *  - Validar el payload según channel_id antes de tocar la BD
 *  - Verificar stock disponible (pre-check CH-04 / reserva atómica CH-03)
 *  - Delegar la creación a salesService.createOrder (CH-01/02/04/05)
 *  - Manejar el camino propio de ML con idempotencia (CH-03)
 *  - Registrar cada intento en ml_sync_log
 *  - Retornar { order_id, status, next_action } normalizado
 *
 * Canal → source mapping (salesService.js SOURCE_TO_CHANNEL):
 *   1 = mostrador    | 2 = social_media | 3 = mercadolibre
 *   4 = ecommerce    | 5 = fuerza_ventas
 */

const { pool } = require("../../db");
const salesService = require("./salesService");

const CHANNEL_SOURCE = {
  1: "mostrador",
  2: "social_media",
  3: "mercadolibre",
  4: "ecommerce",
  5: "fuerza_ventas",
};

const CHANNEL_FULFILLMENT_TYPE = {
  1: "retiro_tienda",
  2: "envio_propio",      // puede ser retiro_acordado — el operario lo ajusta post-creación
  3: "mercado_envios",
  4: "envio_propio",
  5: "entrega_vendedor",
};

// Umbral de aprobación para CH-05 (USD). Configurable vía env.
const FV_APPROVAL_THRESHOLD_USD = Number(
  process.env.FUERZA_VENTAS_APPROVAL_THRESHOLD_USD || "500"
);

class StockError extends Error {
  constructor(sku, available, requested) {
    super(`Stock insuficiente para SKU ${sku}: disponible ${available}, solicitado ${requested}`);
    this.code = "STOCK_INSUFFICIENT";
    this.sku = sku;
    this.available = available;
    this.requested = requested;
  }
}

class ValidationError extends Error {
  constructor(msg) {
    super(msg);
    this.code = "VALIDATION_ERROR";
  }
}

class DuplicateEventError extends Error {
  constructor(mlEventId) {
    super(`Evento ML ya procesado: ${mlEventId}`);
    this.code = "DUPLICATE_EVENT";
    this.mlEventId = mlEventId;
  }
}

class OrderGateway {
  /**
   * Punto de entrada unificado para los 5 canales.
   *
   * @param {object} payload  Datos de la orden (estructura según canal)
   * @param {number} channelId  1–5
   * @returns {Promise<{ order_id: number, status: string, next_action: string }>}
   */
  async createOrder(payload, channelId) {
    const ch = Number(channelId);
    if (![1, 2, 3, 4, 5].includes(ch)) {
      throw new ValidationError(`channel_id inválido: ${channelId}`);
    }

    // Validación por canal (sin tocar BD)
    this._validateByChannel(payload, ch);

    if (ch === 3) {
      return this._createOrderCh03(payload);
    }
    return this._createOrderManual(payload, ch);
  }

  // ─── CANAL 3 — MercadoLibre (camino propio con idempotencia) ─────────────────

  async _createOrderCh03(payload) {
    const { ml_order_id, ml_buyer_id, ml_user_id, items, notes } = payload;
    const eventId = `order:${ml_order_id}`;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // 1. Idempotencia: verificar si ya existe en ml_webhooks_logs
      const dedupRes = await client.query(
        `SELECT id, status FROM ml_webhooks_logs WHERE ml_event_id = $1 FOR UPDATE`,
        [eventId]
      );
      if (dedupRes.rows.length > 0) {
        await client.query("ROLLBACK");
        const existing = dedupRes.rows[0];
        if (existing.status === "done") {
          throw new DuplicateEventError(eventId);
        }
        // Si está en otro estado (failed/dead_letter), permitir reintento
      }

      // 2. Registrar/actualizar en ml_webhooks_logs
      await client.query(
        `INSERT INTO ml_webhooks_logs
           (ml_user_id, ml_event_id, topic, resource_id, raw_payload, status)
         VALUES ($1, $2, 'orders', $3, $4, 'processing')
         ON CONFLICT (ml_event_id)
           DO UPDATE SET status = 'processing',
                         retry_count = ml_webhooks_logs.retry_count + 1,
                         processed_at = NULL`,
        [
          ml_user_id ?? null,
          eventId,
          String(ml_order_id),
          JSON.stringify(payload),
        ]
      );

      // 3. Stock check atómico + reserva
      await this.checkAndReserveStock(items, client);

      // 4. INSERT en sales_orders (CH-03 no pasa por MANUAL_SOURCES de salesService)
      // Misma clave que importSalesOrderFromMlOrder: "{ml_user_id}-{order_id}" cuando hay cuenta;
      // evita external_order_id solo numérico (rompe joins/listados alineados a ml_orders).
      const nOid = Number(ml_order_id);
      const nUid =
        ml_user_id != null && String(ml_user_id).trim() !== ""
          ? Number(ml_user_id)
          : NaN;
      const extOrderKey =
        Number.isFinite(nUid) &&
        nUid > 0 &&
        Number.isFinite(nOid) &&
        nOid > 0
          ? `${nUid}-${nOid}`
          : String(ml_order_id);

      const totalUsd = items.reduce(
        (sum, it) => sum + Number(it.unit_price_usd || 0) * Number(it.qty),
        0
      );
      const orderRes = await client.query(
        `INSERT INTO sales_orders
           (source, channel_id, external_order_id, customer_id, notes,
            total_amount_usd, payment_status, fulfillment_status, fulfillment_type)
         VALUES ('mercadolibre', 3, $1, NULL, $2, $3,
                 'pending', 'pending', 'mercado_envios')
         RETURNING id, payment_status, fulfillment_status`,
        [
          extOrderKey,
          notes ?? null,
          totalUsd,
        ]
      );
      const order = orderRes.rows[0];

      // 5. Insertar líneas
      for (const item of items) {
        await client.query(
          `INSERT INTO sales_order_items
             (sales_order_id, sku, quantity, unit_price_usd, line_total_usd)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            order.id,
            item.master_sku,
            Number(item.qty),
            Number(item.unit_price_usd || 0),
            Number(item.unit_price_usd || 0) * Number(item.qty),
          ]
        );
      }

      // 6. Marcar webhook como done
      await client.query(
        `UPDATE ml_webhooks_logs
           SET status = 'done', processed_at = now()
         WHERE ml_event_id = $1`,
        [eventId]
      );

      await client.query("COMMIT");

      await this._logSync("order", String(ml_order_id), "import", "ok", ml_user_id ?? null);

      try {
        const sseBroker = require("../realtime/sseBroker");
        const nUid =
          ml_user_id != null && String(ml_user_id).trim() !== ""
            ? Number(ml_user_id)
            : null;
        sseBroker.broadcast("new_sale", {
          sales_order_id: order.id,
          ml_user_id: Number.isFinite(nUid) && nUid > 0 ? nUid : null,
          order_id: Number(ml_order_id),
          external_order_id: extOrderKey,
          source: "order_gateway_ch03",
        });
      } catch (_sse) {
        /* no crítico */
      }

      return {
        order_id: order.id,
        status: "pending",
        next_action: "await_payment_webhook",
      };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});

      if (err.code !== "DUPLICATE_EVENT") {
        await client
          .query(
            `UPDATE ml_webhooks_logs
               SET status = CASE WHEN retry_count >= 5 THEN 'dead_letter' ELSE 'failed' END,
                   error_message = $1
             WHERE ml_event_id = $2`,
            [err.message, eventId]
          )
          .catch(() => {});
        await this._logSync("order", String(ml_order_id), "import", "error", null, err.message);
      }
      throw err;
    } finally {
      client.release();
    }
  }

  // ─── CANALES 1, 2, 4, 5 — Fuentes manuales (delega a salesService) ───────────

  async _createOrderManual(payload, ch) {
    const {
      items,
      notes,
      customerId,
      sellerId,
      conversationId,
      paymentMethod,
      externalOrderId,
      soldBy,
      companyId,
    } = payload;

    // CH-04 e-commerce: pre-check stock ANTES de crear la orden
    // (responde 409 si no hay stock, sin transaction abierta)
    if (ch === 4) {
      await this._checkStockReadOnly(items);
    }

    const source = CHANNEL_SOURCE[ch];

    // salesService.createOrder maneja transacción, stock check y decremento
    const order = await salesService.createOrder({
      source,
      channelId: ch,
      sellerId: sellerId ?? null,
      customerId: customerId ?? null,
      items: items.map((it) => ({
        sku: it.master_sku,
        qty: Number(it.qty),
        unit_price_usd: Number(it.unit_price_usd || 0),
      })),
      notes: notes ?? null,
      soldBy: soldBy ?? null,
      paymentMethod: paymentMethod ?? null,
      externalOrderId: externalOrderId ?? null,
      companyId: companyId ?? null,
      id_type: payload.id_type ?? undefined,
      id_number: payload.id_number ?? undefined,
      phone: payload.phone ?? undefined,
      consumidor_final: payload.consumidor_final,
    });

    // Post-creación: vincular conversation_id y fulfillment_type
    // (salesService aún no maneja estos campos)
    if (conversationId || CHANNEL_FULFILLMENT_TYPE[ch]) {
      const updates = [];
      const params = [];
      let idx = 1;

      if (CHANNEL_FULFILLMENT_TYPE[ch]) {
        updates.push(`fulfillment_type = $${idx++}`);
        params.push(CHANNEL_FULFILLMENT_TYPE[ch]);
      }
      if (conversationId) {
        updates.push(`conversation_id = $${idx++}`);
        params.push(Number(conversationId));
      }

      if (updates.length > 0) {
        params.push(order.id ?? order.order_id);
        await pool.query(
          `UPDATE sales_orders SET ${updates.join(", ")} WHERE id = $${idx}`,
          params
        );
      }
    }

    // CH-05: si el monto supera el umbral, marcar como pending_approval
    if (ch === 5) {
      const totalUsd = Number(order.total_amount_usd ?? 0);
      if (totalUsd > FV_APPROVAL_THRESHOLD_USD) {
        await pool.query(
          `UPDATE sales_orders SET approval_status = 'pending_approval' WHERE id = $1`,
          [order.id ?? order.order_id]
        );
        await this._logSync(
          "order", String(order.id ?? order.order_id), "create_ch05", "pending_approval", null
        );
        return {
          order_id: order.id ?? order.order_id,
          status: "pending_approval",
          next_action: "await_supervisor_approval",
        };
      }
    }

    await this._logSync("order", String(order.id ?? order.order_id), "create", "ok", null);

    const nextActions = {
      1: "print_ticket",
      2: "await_payment_confirmation",
      4: "await_payment_gateway",
      5: "assign_fulfillment",
    };

    return {
      order_id: order.id ?? order.order_id,
      status: order.status ?? "pending",
      next_action: nextActions[ch] ?? "none",
    };
  }

  // ─── Stock check atómico (dentro de transacción activa — CH-03) ──────────────

  /**
   * Verifica disponibilidad Y descuenta stock en la misma transacción.
   * Usar solo cuando el client ya tiene BEGIN activo.
   *
   * @param {Array<{master_sku: string, qty: number}>} items
   * @param {import('pg').PoolClient} trx  Cliente pg con transacción abierta
   */
  async checkAndReserveStock(items, trx) {
    for (const item of items) {
      const { master_sku, qty } = item;
      const requested = Number(qty);

      // SELECT FOR UPDATE — bloquea la fila hasta COMMIT/ROLLBACK
      const res = await trx.query(
        `SELECT id, stock FROM productos WHERE sku = $1 FOR UPDATE`,
        [master_sku]
      );

      if (res.rows.length === 0) {
        throw new ValidationError(`SKU no encontrado: ${master_sku}`);
      }

      const available = Number(res.rows[0].stock);
      if (available < requested) {
        throw new StockError(master_sku, available, requested);
      }

      await trx.query(
        `UPDATE productos SET stock = stock - $1 WHERE sku = $2`,
        [requested, master_sku]
      );
    }
  }

  // ─── Stock pre-check sin lock (CH-04 early rejection) ────────────────────────

  async _checkStockReadOnly(items) {
    const skus = items.map((it) => it.master_sku);
    const res = await pool.query(
      `SELECT sku, stock FROM productos WHERE sku = ANY($1)`,
      [skus]
    );
    const stockMap = Object.fromEntries(res.rows.map((r) => [r.sku, Number(r.stock)]));

    for (const item of items) {
      const available = stockMap[item.master_sku] ?? 0;
      const requested = Number(item.qty);
      if (available < requested) {
        throw new StockError(item.master_sku, available, requested);
      }
    }
  }

  // ─── Validadores por canal ────────────────────────────────────────────────────

  _validateByChannel(payload, ch) {
    switch (ch) {
      case 1: return this.validateChannel01(payload);
      case 2: return this.validateChannel02(payload);
      case 3: return this.validateChannel03(payload);
      case 4: return this.validateChannel04(payload);
      case 5: return this.validateChannel05(payload);
    }
  }

  validateChannel01(p) {
    // CH-01 MOSTRADOR: cliente opcional; items obligatorios con master_sku y qty
    this._requireItems(p);
  }

  validateChannel02(p) {
    // CH-02 WHATSAPP/REDES: teléfono o customer_id obligatorio; items obligatorios
    if (!p.wa_phone && !p.customerId) {
      throw new ValidationError("CH-02: wa_phone o customer_id obligatorio");
    }
    this._requireItems(p);
  }

  validateChannel03(p) {
    // CH-03 ML: ml_order_id y ml_buyer_id obligatorios
    if (!p.ml_order_id) throw new ValidationError("CH-03: ml_order_id obligatorio");
    if (!p.ml_buyer_id) throw new ValidationError("CH-03: ml_buyer_id obligatorio");
    this._requireItems(p);
  }

  validateChannel04(p) {
    // CH-04 ECOMMERCE: customer_id obligatorio (usuario registrado)
    if (!p.customerId) throw new ValidationError("CH-04: customer_id obligatorio");
    this._requireItems(p);
  }

  validateChannel05(p) {
    // CH-05 FUERZA VENTAS: seller_id y customer_id obligatorios
    if (!p.sellerId)   throw new ValidationError("CH-05: seller_id obligatorio");
    if (!p.customerId) throw new ValidationError("CH-05: customer_id obligatorio");
    this._requireItems(p);
  }

  _requireItems(p) {
    if (!Array.isArray(p.items) || p.items.length === 0) {
      throw new ValidationError("items es obligatorio y no puede estar vacío");
    }
    for (const it of p.items) {
      if (!it.master_sku) throw new ValidationError("Cada item debe tener master_sku");
      if (!it.qty || Number(it.qty) <= 0) {
        throw new ValidationError(`qty inválido para SKU ${it.master_sku}`);
      }
    }
  }

  // ─── Log de sincronización ────────────────────────────────────────────────────

  async _logSync(entityType, entityId, action, status, mlUserId = null, error = null) {
    try {
      await pool.query(
        `INSERT INTO ml_sync_log
           (entity_type, entity_id, action, status, ml_user_id, error)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [entityType, entityId, action, status, mlUserId, error ?? null]
      );
    } catch {
      // No bloquear el flujo principal si el log falla
    }
  }
}

module.exports = { OrderGateway, StockError, ValidationError, DuplicateEventError };
