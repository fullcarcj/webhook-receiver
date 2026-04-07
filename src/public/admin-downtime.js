/**
 * Incluir en el HTML del panel admin antes de </body>:
 *   <script src="/ruta/a/admin-downtime.js"></script>
 * (copiar este archivo al hosting estático o servirlo desde el mismo origen que el panel).
 */
(function() {
  const HEALTH_URL       = '/api/health';
  const CHECK_INTERVAL   = 60 * 1000;
  let isDown             = false;

  async function checkHealth() {
    try {
      const res  = await fetch(HEALTH_URL);
      const data = await res.json();
      if (data.status === 'DOWNTIME' && !isDown) {
        isDown = true;
        showBanner(data.retry_after_seconds);
      }
      if (data.status === 'OK' && isDown) {
        window.location.reload();
      }
    } catch {
      if (!isDown) { isDown = true; showBanner(null); }
    }
  }

  function showBanner(secondsLeft) {
    if (document.getElementById('ferrari-downtime-banner')) return;
    const mins   = secondsLeft ? Math.ceil(secondsLeft / 60) : '?';
    const banner = document.createElement('div');
    banner.id    = 'ferrari-downtime-banner';
    banner.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0',
      'background:#1a1a2e', 'color:#e8e8e8',
      'padding:12px 20px', 'text-align:center',
      'font-size:14px', 'z-index:9999',
      'border-bottom:2px solid #e24b4a',
    ].join(';');
    banner.textContent =
      'Sistema en mantenimiento — Vuelve a las 06:00 AM VET ' +
      '(~' + mins + ' min). La página se recargará automáticamente.';
    document.body.prepend(banner);
  }

  checkHealth();
  setInterval(checkHealth, CHECK_INTERVAL);
})();
