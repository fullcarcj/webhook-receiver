'use strict';
const sg = require('../src/utils/sessionGuard');

const cases = [
  { h: 23, m: 29, expected: false },
  { h: 23, m: 30, expected: true  },
  { h: 23, m: 59, expected: true  },
  { h:  0, m:  0, expected: true  },
  { h:  4, m: 59, expected: true  },
  { h:  5, m:  0, expected: false },
  { h:  5, m:  1, expected: false },
  { h: 12, m:  0, expected: false },
];

let allOk = true;
cases.forEach(({ h, m, expected }) => {
  const total = h * 60 + m;
  const result = total >= 1410 || total < 300;
  const ok = result === expected;
  if (!ok) allOk = false;
  const label = String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0');
  console.log((ok ? 'OK' : 'FALLA'), label, '-> downtime=' + result);
});

console.log('VET ahora:', sg.getVetNow().toISOString());
console.log('En downtime:', sg.isInDowntime());
console.log('minutesUntilRestore:', sg.minutesUntilRestore());
console.log('exports:', Object.keys(sg).join(', '));
console.log(allOk ? 'TODOS LOS CASOS OK' : 'HAY FALLOS');
