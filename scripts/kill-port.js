#!/usr/bin/env node
"use strict";
/**
 * Libera el puerto indicado matando el proceso que lo ocupa.
 * Portable: usa `netstat` en Windows y `lsof` en Unix.
 * Uso: node scripts/kill-port.js <puerto>
 * Se invoca como `predev` antes de `npm run dev` para evitar EADDRINUSE
 * cuando `node --watch` reinicia y Windows aún no liberó el socket.
 */
const { execSync } = require("child_process");

const port = Number(process.argv[2] || process.env.PORT || 3002);
if (!port) {
  console.error("[kill-port] Indicá el puerto: node scripts/kill-port.js 3002");
  process.exit(1);
}

function getPidsWindows(p) {
  // Preferir PowerShell: el estado es el enum Listen (independiente del idioma de netstat).
  try {
    const ps =
      "powershell -NoProfile -Command " +
      `"Get-NetTCPConnection -LocalPort ${p} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique"`;
    const out = execSync(ps, { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      const n = parseInt(String(line).trim(), 10);
      if (n > 0) pids.add(n);
    }
    if (pids.size) return [...pids];
  } catch {
    /* seguir con netstat */
  }
  try {
    const out = execSync(`netstat -ano | findstr :${p}`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"]
    });
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      const u = line.toUpperCase();
      // netstat: LISTENING (EN) / ESCUCHANDO (ES). Si falla, PowerShell arriba ya resolvió.
      if (!u.includes("LISTENING") && !u.includes("ESCUCHANDO")) continue;
      const m = line.trim().match(/\s+(\d+)\s*$/);
      if (m) pids.add(Number(m[1]));
    }
    return [...pids];
  } catch {
    return [];
  }
}

function getPidsUnix(p) {
  try {
    const out = execSync(
      `lsof -ti tcp:${p}`,
      { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }
    );
    return out
      .split(/\s+/)
      .map(Number)
      .filter((n) => n > 0);
  } catch {
    return [];
  }
}

function killPid(pid) {
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
    } else {
      process.kill(pid, "SIGTERM");
    }
    return true;
  } catch {
    return false;
  }
}

const isWin = process.platform === "win32";
const pids = isWin ? getPidsWindows(port) : getPidsUnix(port);

if (!pids.length) {
  console.log(`[kill-port] Puerto ${port} libre — nada que matar.`);
  process.exit(0);
}

let killed = 0;
for (const pid of pids) {
  if (pid === process.pid) continue;
  const ok = killPid(pid);
  if (ok) {
    console.log(`[kill-port] Proceso ${pid} en :${port} terminado.`);
    killed++;
  } else {
    console.warn(`[kill-port] No se pudo terminar PID ${pid} (sin permisos?).`);
  }
}

if (killed > 0) {
  // Pequeña pausa para que Windows libere el socket
  const wait = 600;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
  console.log(`[kill-port] Listo (espera ${wait}ms post-kill).`);
}
process.exit(0);
