'use strict';

/**
 * Cola de llamadas a la API de ML.
 * Limita la concurrencia a MAX_CONCURRENT para no saturar el rate limit de ML.
 * Agrega un delay mínimo de DELAY_MS entre el fin de una llamada y el inicio de la siguiente.
 *
 * Usa p-limit si está disponible (ya en package.json ^6.2.0);
 * si no se puede cargar, cae en implementación manual equivalente.
 */

const MAX_CONCURRENT = 2;
const DELAY_MS = 400;

let _limit = null;

function buildLimitFn() {
  if (_limit) return _limit;
  try {
    const mod = require('p-limit');
    // p-limit v4+ es ESM: el export default viene en mod.default en CJS interop
    const pLimit = typeof mod === 'function' ? mod : mod.default;
    if (typeof pLimit !== 'function') throw new Error('p-limit no es función');
    _limit = pLimit(MAX_CONCURRENT);
  } catch (_) {
    // Fallback manual: cola simple con delay entre llamadas
    _limit = buildManualLimit();
  }
  return _limit;
}

function buildManualLimit() {
  const queue = [];
  let running = 0;

  function processQueue() {
    if (running >= MAX_CONCURRENT || queue.length === 0) return;
    running++;
    const { fn, resolve, reject } = queue.shift();
    fn()
      .then(resolve)
      .catch(reject)
      .finally(() => {
        running--;
        setTimeout(processQueue, DELAY_MS);
      });
  }

  return function manualLimit(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      processQueue();
    });
  };
}

/**
 * Encola una llamada a ML con concurrencia limitada.
 * @param {() => Promise<any>} fn  Función async a ejecutar.
 * @returns {Promise<any>}
 */
function mlQueuedCall(fn) {
  return buildLimitFn()(fn);
}

module.exports = { mlQueuedCall };
