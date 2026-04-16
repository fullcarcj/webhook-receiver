"use strict";

/**
 * Menú ERP v4 — fuente de datos para GET /api/menu (sin BD).
 * apiPath es documentación / contrato con el front; no se valida en runtime.
 *
 * allowedRoles (opcional) en sección o ítem: aislamiento horizontal entre roles
 * (hasMinRole solo cubre jerarquía vertical). Ver menuApiHandler.
 */

const ACTIVE_MODULES = [
  "auth",
  "settings",
  "crm",
  "wms",
  "ventas",
  "fiscal",
  "compras",
  "integraciones",
];

const PENDING_MODULES = ["catalog", "reportes"];

const HIDDEN_MODULES = ["promociones", "hrm", "cms", "ui_kit"];

const CANAL_BY_ROLE = {
  SUPERUSER: "all",
  ADMIN: "all",
  SUPERVISOR: "all",
  VENDEDOR_MOSTRADOR: "mostrador",
  VENDEDOR_EXTERNO: "fuerza_ventas",
  OPERADOR_DIGITAL: "digital",
  OPERATOR: "all",
  ALMACENISTA: "all",
  CONTADOR: "all",
};

const MENU_SECTIONS = [
  {
    id: "dashboard",
    label: "Dashboard",
    icon: "LayoutGrid",
    group: "Comercial & Omnicanalidad",
    moduleKey: null,
    minRole: "SUPERVISOR",
    items: [
      { id: "dashboard.panel", label: "Panel Global", path: "/dashboard", apiPath: "GET /api/stats/overview", minRole: "SUPERVISOR" },
      { id: "dashboard.canales", label: "Monitor de Canales", path: "/dashboard/canales", apiPath: "GET /api/stats/realtime", minRole: "ADMIN" },
    ],
  },
  {
    id: "bandeja",
    label: "Bandeja",
    icon: "MessageSquare",
    group: "Comercial & Omnicanalidad",
    moduleKey: "crm",
    minRole: "OPERADOR_DIGITAL",
    // VENDEDOR_EXTERNO: incluido por defecto (omnicanal + WhatsApp / cartera).
    // Si el externo solo vende en ruta presencial sin inbox, quitar "VENDEDOR_EXTERNO" de esta lista.
    allowedRoles: [
      "SUPERUSER",
      "ADMIN",
      "SUPERVISOR",
      "OPERADOR_DIGITAL",
      "OPERATOR",
      "VENDEDOR_EXTERNO",
    ],
    canal: ["digital", "all"],
    items: [
      { id: "bandeja.todas", label: "Todas", path: "/bandeja", apiPath: "GET /api/inbox", minRole: "OPERADOR_DIGITAL" },
      { id: "bandeja.sinleer", label: "Sin Leer", path: "/bandeja/sin-leer", apiPath: "GET /api/inbox?filter=unread", minRole: "OPERADOR_DIGITAL" },
      {
        id: "bandeja.wa",
        label: "WhatsApp",
        path: "/bandeja/whatsapp",
        apiPath: "GET /api/inbox?src=wa",
        minRole: "OPERADOR_DIGITAL",
        canal: ["digital", "fuerza_ventas", "all"],
      },
      {
        id: "bandeja.redes",
        label: "Redes Sociales",
        path: "/bandeja/redes",
        apiPath: "GET /api/inbox",
        minRole: "OPERADOR_DIGITAL",
        canal: ["digital", "fuerza_ventas", "all"],
        future: true,
      },
      { id: "bandeja.ml", label: "→ ML Mensajes", path: "/mercadolibre/mensajes", apiPath: "redirect", minRole: "OPERADOR_DIGITAL" },
    ],
  },
  {
    id: "ventas",
    label: "Ventas Omnicanal",
    icon: "ShoppingCart",
    group: "Comercial & Omnicanalidad",
    moduleKey: "ventas",
    minRole: "OPERADOR_DIGITAL",
    allowedRoles: [
      "SUPERUSER",
      "ADMIN",
      "SUPERVISOR",
      "VENDEDOR_MOSTRADOR",
      "VENDEDOR_EXTERNO",
      "OPERADOR_DIGITAL",
      "OPERATOR",
    ],
    items: [
      { id: "ventas.nueva", label: "Nueva Venta / POS", path: "/ventas/nueva", apiPath: "POST /api/pos/sales", minRole: "OPERADOR_DIGITAL" },
      { id: "ventas.turno", label: "Mis Ventas del Turno", path: "/ventas/turno", apiPath: "GET /api/pos/sessions", minRole: "VENDEDOR_MOSTRADOR", canal: ["mostrador", "all"], future: true },
      { id: "ventas.cartera", label: "Mi Cartera", path: "/ventas/cartera", apiPath: "pendingMigration", minRole: "VENDEDOR_EXTERNO", canal: ["fuerza_ventas", "mostrador", "all"], pendingMigration: true },
      { id: "ventas.pedidos", label: "Todos los Pedidos", path: "/ventas/pedidos", apiPath: "GET /api/sales", minRole: "SUPERVISOR" },
      { id: "ventas.cotizaciones", label: "Cotizaciones", path: "/ventas/cotizaciones", apiPath: "GET /api/inbox/quotations", minRole: "VENDEDOR_MOSTRADOR" },
      { id: "ventas.aprobaciones", label: "Aprobaciones Pendientes", path: "/ventas/aprobaciones", apiPath: "GET /api/sales?status=pending_approval", minRole: "SUPERVISOR" },
      { id: "ventas.cobros", label: "Cobros y Conciliación", path: "/ventas/cobros", apiPath: "GET /api/cash/pending", minRole: "SUPERVISOR" },
      { id: "ventas.devoluciones", label: "Devoluciones y Garantías", path: "/ventas/devoluciones", apiPath: "GET /api/sales?type=devolucion", minRole: "SUPERVISOR" },
    ],
  },
  {
    id: "mercadolibre",
    label: "MercadoLibre",
    icon: "Store",
    group: "Comercial & Omnicanalidad",
    moduleKey: "integraciones",
    minRole: "OPERADOR_DIGITAL",
    // Mapeo/Precios: minRole ADMIN → SUPERVISOR no entra; el resto por jerarquía + allowedRoles de sección.
    allowedRoles: ["SUPERUSER", "ADMIN", "SUPERVISOR", "OPERADOR_DIGITAL", "OPERATOR"],
    canal: ["digital", "all"],
    items: [
      { id: "ml.central", label: "Central ML", path: "/mercadolibre", apiPath: "GET /api/stats/mercadolibre", minRole: "OPERADOR_DIGITAL" },
      { id: "ml.preguntas", label: "Preguntas Pre-venta", path: "/mercadolibre/preguntas", apiPath: "GET /api/inbox?src=ml_question", minRole: "OPERADOR_DIGITAL" },
      { id: "ml.mensajes", label: "Mensajería Post-venta", path: "/mercadolibre/mensajes", apiPath: "GET /api/inbox?src=ml_message", minRole: "OPERADOR_DIGITAL" },
      { id: "ml.mapeo", label: "Sincronizador / Mapeo SKUs", path: "/mercadolibre/mapeo", apiPath: "GET /api/ml/publications", minRole: "ADMIN" },
      { id: "ml.precios", label: "Precios ML", path: "/mercadolibre/precios", apiPath: "GET /api/price", minRole: "ADMIN" },
      { id: "ml.reputacion", label: "Monitor Reputación", path: "/mercadolibre/reputacion", apiPath: "GET /api/ml/reputation", minRole: "SUPERVISOR", future: true },
    ],
  },
  {
    id: "inventario",
    label: "Inventario",
    icon: "Package",
    group: "Cadena de Suministro",
    moduleKey: "wms",
    minRole: "ALMACENISTA",
    allowedRoles: ["SUPERUSER", "ADMIN", "SUPERVISOR", "ALMACENISTA"],
    items: [
      { id: "inv.productos", label: "Productos y Stock", path: "/inventario/productos", apiPath: "GET /api/inventory/products", minRole: "ALMACENISTA" },
      { id: "inv.skus", label: "SKUs y Equivalencias", path: "/inventario/skus", apiPath: "GET /api/v1/catalog/compat/equivalences", minRole: "ALMACENISTA" },
      { id: "inv.compat", label: "Marcas y Compatibilidades", path: "/inventario/compatibilidades", apiPath: "GET /api/v1/catalog/compat/search · GET /api/vehicle", minRole: "ALMACENISTA" },
      { id: "inv.alertas", label: "Stock Bajo / Alertas", path: "/inventario/alertas", apiPath: "GET /api/inventory/alerts", minRole: "ALMACENISTA" },
      { id: "inv.garantias", label: "Garantías", path: "/inventario/garantias", apiPath: "GET /api/inventory (filtro garantía — futuro)", minRole: "ALMACENISTA", future: true },
      { id: "inv.lotes", label: "Lotes y Vencimientos", path: "/inventario/lotes", apiPath: "GET /api/lots", minRole: "ALMACENISTA" },
      { id: "inv.movimientos", label: "Movimientos y Conteo", path: "/inventario/movimientos", apiPath: "GET /api/wms/movements · GET /api/count", minRole: "SUPERVISOR" },
    ],
  },
  {
    id: "logistica",
    label: "Logística",
    icon: "Truck",
    group: "Cadena de Suministro",
    moduleKey: "wms",
    minRole: "ALMACENISTA",
    allowedRoles: ["SUPERUSER", "ADMIN", "SUPERVISOR", "ALMACENISTA"],
    items: [
      { id: "log.picking", label: "Cola de Picking", path: "/logistica/picking", apiPath: "GET /api/wms/picking", minRole: "ALMACENISTA" },
      { id: "log.despachos", label: "Despachos del Día", path: "/logistica/despachos", apiPath: "GET /api/shipments · GET /api/delivery", minRole: "ALMACENISTA" },
      { id: "log.etiquetas", label: "Etiquetas y Guías ML", path: "/logistica/etiquetas", apiPath: "GET /api/shipments (etiquetas — futuro)", minRole: "ALMACENISTA", future: true },
      { id: "log.historial", label: "Historial de Entregas", path: "/logistica/historial", apiPath: "GET /api/shipments?status=CLOSED", minRole: "SUPERVISOR" },
    ],
  },
  {
    id: "compras",
    label: "Compras",
    icon: "ClipboardList",
    group: "Cadena de Suministro",
    moduleKey: "compras",
    minRole: "ALMACENISTA",
    allowedRoles: ["SUPERUSER", "ADMIN", "ALMACENISTA"],
    items: [
      { id: "comp.ordenes", label: "Órdenes de Compra", path: "/compras/ordenes", apiPath: "GET /api/inventory/purchase-orders", minRole: "ADMIN" },
      { id: "comp.recepcion", label: "Recepción de Mercancía", path: "/compras/recepcion", apiPath: "PATCH /api/inventory/purchase-orders/:id/status (received)", minRole: "ALMACENISTA" },
      { id: "comp.proveedores", label: "Proveedores", path: "/compras/proveedores", apiPath: "GET /api/inventory/suppliers", minRole: "ADMIN" },
      { id: "comp.costos", label: "Historial de Costos", path: "/compras/costos", apiPath: "GET /api/pos/purchases", minRole: "ADMIN" },
    ],
  },
  {
    id: "finanzas",
    label: "Finanzas",
    icon: "DollarSign",
    group: "Finanzas & Analítica",
    moduleKey: "fiscal",
    minRole: "VENDEDOR_MOSTRADOR",
    items: [
      { id: "fin.caja", label: "Caja y Cierres de Turno", path: "/finanzas/caja", apiPath: "GET /api/cash/my-pending", minRole: "VENDEDOR_MOSTRADOR" },
      { id: "fin.cxc", label: "Cuentas por Cobrar", path: "/finanzas/cxc", apiPath: "GET /api/sales?payment_status=pending", minRole: "SUPERVISOR" },
      { id: "fin.banesco", label: "Banesco / Conciliación", path: "/finanzas/banesco", apiPath: "GET /api/bank/banesco/status", minRole: "ADMIN" },
      { id: "fin.gastos", label: "Gastos y Comisiones", path: "/finanzas/gastos", apiPath: "GET /api/stats/expenses", minRole: "SUPERVISOR" },
      { id: "fin.tasas", label: "Tasas BCV / Monedas", path: "/finanzas/tasas", apiPath: "GET /api/currency", minRole: "ADMIN" },
      {
        id: "fin.igtf",
        label: "IGTF",
        path: "/finanzas/igtf",
        apiPath: "GET /api/igtf",
        minRole: "CONTADOR",
        allowedRoles: ["SUPERUSER", "ADMIN", "CONTADOR"],
      },
      {
        id: "fin.retenciones",
        label: "Retenciones IVA / ISLR",
        path: "/finanzas/retenciones",
        apiPath: "GET /api/tax-retentions",
        minRole: "CONTADOR",
        allowedRoles: ["SUPERUSER", "ADMIN", "CONTADOR"],
      },
      {
        id: "fin.documentos",
        label: "Documentos Fiscales",
        path: "/finanzas/documentos",
        apiPath: "GET /api/fiscal",
        minRole: "CONTADOR",
        allowedRoles: ["SUPERUSER", "ADMIN", "CONTADOR"],
      },
      { id: "fin.utilidad", label: "Utilidad Real", path: "/finanzas/utilidad", apiPath: "GET /api/stats/pnl", minRole: "ADMIN" },
    ],
  },
  {
    id: "reportes",
    label: "Reportes",
    icon: "BarChart2",
    group: "Finanzas & Analítica",
    moduleKey: "reportes",
    minRole: "CONTADOR",
    items: [
      { id: "rep.ventas", label: "Ventas por Canal", path: "/reportes/ventas", apiPath: "GET /api/stats/sales", minRole: "SUPERVISOR" },
      { id: "rep.inventario", label: "Inventario Valorizado", path: "/reportes/inventario", apiPath: "GET /api/stats/inventory-valued", minRole: "SUPERVISOR", future: true },
      { id: "rep.comisiones", label: "Comisiones FV", path: "/reportes/comisiones", apiPath: "GET /api/stats/commissions", minRole: "SUPERVISOR", future: true },
      { id: "rep.fiscal", label: "Fiscal y P&L", path: "/reportes/fiscal", apiPath: "GET /api/stats/pnl", minRole: "CONTADOR" },
      { id: "rep.conciliacion", label: "Conciliación Bancaria", path: "/reportes/conciliacion", apiPath: "GET /api/stats/reconciliation", minRole: "ADMIN" },
      { id: "rep.rentabilidad", label: "Rentabilidad por Canal", path: "/reportes/rentabilidad", apiPath: "GET /api/stats/channel-profitability", minRole: "ADMIN", future: true },
    ],
  },
  {
    id: "clientes",
    label: "Clientes",
    icon: "Users",
    group: "Datos Maestros & Sistema",
    moduleKey: "crm",
    minRole: "VENDEDOR_MOSTRADOR",
    allowedRoles: [
      "SUPERUSER",
      "ADMIN",
      "SUPERVISOR",
      "VENDEDOR_MOSTRADOR",
      "VENDEDOR_EXTERNO",
      "OPERADOR_DIGITAL",
      "OPERATOR",
    ],
    items: [
      { id: "cli.directorio", label: "Directorio Unificado", path: "/clientes/directorio", apiPath: "GET /api/customers", minRole: "VENDEDOR_MOSTRADOR" },
      { id: "cli.historial", label: "Historial por Cliente", path: "/clientes/historial", apiPath: "GET /api/customers/:id/history", minRole: "VENDEDOR_MOSTRADOR" },
      { id: "cli.cartera", label: "Cartera", path: "/clientes/cartera", apiPath: "pendingMigration", minRole: "VENDEDOR_EXTERNO", pendingMigration: true },
      { id: "cli.wallet", label: "Wallet / Fidelización", path: "/clientes/wallet", apiPath: "GET /api/wallet", minRole: "SUPERVISOR" },
    ],
  },
  {
    id: "config",
    label: "Configuración",
    icon: "Settings",
    group: "Datos Maestros & Sistema",
    moduleKey: "settings",
    minRole: "ADMIN",
    items: [
      { id: "cfg.empresa", label: "Empresa y Sucursales", path: "/config/empresa", apiPath: "GET /api/config/company · GET /api/config/branches", minRole: "ADMIN" },
      { id: "cfg.usuarios", label: "Usuarios y Roles", path: "/config/usuarios", apiPath: "GET /api/users", minRole: "SUPERUSER" },
      { id: "cfg.ml", label: "ML OAuth / API", path: "/config/integraciones/ml", apiPath: "GET /admin/oauth-exchange (HTML)", minRole: "ADMIN" },
      { id: "cfg.wa", label: "Wasender WhatsApp", path: "/config/integraciones/wa", apiPath: "GET /api/crm/system/wa-status", minRole: "ADMIN" },
      { id: "cfg.banesco", label: "Banesco API", path: "/config/integraciones/banesco", apiPath: "GET /api/bank/banesco/connection", minRole: "ADMIN" },
      { id: "cfg.canales", label: "Canales de Venta", path: "/config/canales", apiPath: "futuro", minRole: "ADMIN", future: true },
      { id: "cfg.fiscal", label: "Ajustes Fiscales", path: "/config/fiscal", apiPath: "GET /api/config/tax-rules", minRole: "ADMIN" },
      { id: "cfg.pos", label: "Impresoras y POS Config", path: "/config/pos", apiPath: "GET /api/config/pos-settings", minRole: "ADMIN", future: true },
    ],
  },
];

module.exports = {
  ACTIVE_MODULES,
  PENDING_MODULES,
  HIDDEN_MODULES,
  CANAL_BY_ROLE,
  MENU_SECTIONS,
};
