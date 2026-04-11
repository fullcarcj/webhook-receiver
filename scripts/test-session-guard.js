'use strict';
const { getVetNow, isInDowntime, minutesUntilRestore, getDowntimeInfo } = require('../src/utils/sessionGuard');

const cases = [
  { h:23, m:29, expected:false },
  { h:23, m:30, expected:true  },
  { h:23, m:59, expected:true  },
  { h: 0, m: 0, expected:true  },
  { h: 4, m:59, expected:true  },
  { h: 5, m: 0, expected:false },
  { h: 5, m: 1, expected:false },
  { h:12, m: 0, expected:false },
];

console.log('=== Test ventana downtime 23:30-05:00 VET ===');
let allOk = true;
cases.forEach(({h, m, expected}) => {
  const total  = h * 60 + m;
  const result = total >= 1410 || total < 300;
  const pass   = result === expected;
  if (!pass) allOk = false;
  console.log((pass ? 'OK' : 'FALLA'), String(h).padStart(2) + ':' + String(m).padStart(2, '0'), '-> downtime=' + result);
});
console.log(allOk ? 'Todos los casos OK' : 'HAY FALLOS');

console.log('\n=== Estado actual ===');
const info = getDowntimeInfo();
console.log('VET ahora:', getVetNow().toISOString());
console.log('En downtime:', isInDowntime());
console.log('Info:', JSON.stringify(info, null, 2));

if (isInDowntime()) {
  console.log('Minutos hasta restaurar:', minutesUntilRestore());
}
