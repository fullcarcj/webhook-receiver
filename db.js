/**
 * Capa de datos: PostgreSQL si existe DATABASE_URL; si no, SQLite (p. ej. data/webhooks.db).
 * Render y entornos productivos usan Postgres. Para trabajar contra la misma BD que producción,
 * define DATABASE_URL en oauth-env.json (no versionado) o en el sistema.
 * Migraciones de esquema: implementar en db-postgres.js y replicar cambios en db-sqlite.js
 * para quien desarrolle sin Postgres.
 * Todas las funciones exportadas son async (await en los consumidores).
 */
const usePostgres = Boolean(process.env.DATABASE_URL && String(process.env.DATABASE_URL).trim());

if (usePostgres) {
  module.exports = require("./db-postgres");
} else {
  const sqlite = require("./db-sqlite");

  function wrap(fn) {
    return async (...args) => fn(...args);
  }

  module.exports = {
    insertWebhook: wrap(sqlite.insertWebhook),
    listWebhooks: wrap(sqlite.listWebhooks),
    deleteWebhooks: wrap(sqlite.deleteWebhooks),
    get dbPath() {
      return sqlite.dbPath;
    },
    upsertMlAccount: wrap(sqlite.upsertMlAccount),
    getMlAccount: wrap(sqlite.getMlAccount),
    listMlAccounts: wrap(sqlite.listMlAccounts),
    getMlAccountCookiesNetscape: wrap(sqlite.getMlAccountCookiesNetscape),
    setMlAccountCookiesNetscape: wrap(sqlite.setMlAccountCookiesNetscape),
    clearMlAccountCookiesNetscape: wrap(sqlite.clearMlAccountCookiesNetscape),
    deleteMlAccount: wrap(sqlite.deleteMlAccount),
    insertTopicFetch: wrap(sqlite.insertTopicFetch),
    updateTopicFetch: wrap(sqlite.updateTopicFetch),
    listTopicFetches: wrap(sqlite.listTopicFetches),
    FETCH_PROCESS_STATUS_PENDING: sqlite.FETCH_PROCESS_STATUS_PENDING,
    FETCH_PROCESS_STATUS_DONE: sqlite.FETCH_PROCESS_STATUS_DONE,
    FETCH_PROCESS_STATUS_POST_SALE_FAILED: sqlite.FETCH_PROCESS_STATUS_POST_SALE_FAILED,
    listDistinctFetchTopics: wrap(sqlite.listDistinctFetchTopics),
    deleteAllTopicFetches: wrap(sqlite.deleteAllTopicFetches),
    upsertMlBuyer: wrap(sqlite.upsertMlBuyer),
    countMlBuyers: wrap(sqlite.countMlBuyers),
    listMlBuyers: wrap(sqlite.listMlBuyers),
    getMlBuyer: wrap(sqlite.getMlBuyer),
    updateMlBuyerPhones: wrap(sqlite.updateMlBuyerPhones),
    getPostSaleMessage: wrap(sqlite.getPostSaleMessage),
    listPostSaleMessages: wrap(sqlite.listPostSaleMessages),
    insertPostSaleMessage: wrap(sqlite.insertPostSaleMessage),
    updatePostSaleMessage: wrap(sqlite.updatePostSaleMessage),
    deletePostSaleMessage: wrap(sqlite.deletePostSaleMessage),
    getFirstPostSaleMessageBody: wrap(sqlite.getFirstPostSaleMessageBody),
    wasPostSaleSent: wrap(sqlite.wasPostSaleSent),
    isPostSaleStepSent: wrap(sqlite.isPostSaleStepSent),
    markPostSaleStepSent: wrap(sqlite.markPostSaleStepSent),
    markPostSaleSent: wrap(sqlite.markPostSaleSent),
    deletePostSaleSent: wrap(sqlite.deletePostSaleSent),
    insertPostSaleAutoSendLog: wrap(sqlite.insertPostSaleAutoSendLog),
    listPostSaleAutoSendLog: wrap(sqlite.listPostSaleAutoSendLog),
    insertMlVentasDetalleWeb: wrap(sqlite.insertMlVentasDetalleWeb),
    listMlVentasDetalleWeb: wrap(sqlite.listMlVentasDetalleWeb),
    deleteAllMlVentasDetalleWeb: wrap(sqlite.deleteAllMlVentasDetalleWeb),
    upsertMlQuestionPending: wrap(sqlite.upsertMlQuestionPending),
    deleteMlQuestionPending: wrap(sqlite.deleteMlQuestionPending),
    upsertMlQuestionAnswered: wrap(sqlite.upsertMlQuestionAnswered),
    listMlQuestionsPending: wrap(sqlite.listMlQuestionsPending),
    listMlQuestionsAnswered: wrap(sqlite.listMlQuestionsAnswered),
  };
}
