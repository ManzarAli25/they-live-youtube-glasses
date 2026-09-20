// Usage: node --env-file=.env scripts/eval-golden.mjs
import { readFileSync } from 'node:fs';
import {
  callJev, DEFAULTS, indexTaxonomy, buildStage1, buildStage2, stateFor, parseStage1, parseStage2, passesGate, toDisplay
} from '../extension/src/jev.js';

const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) {
  console.error('TYPESAFE_API_KEY is not set (use: node --env-file=.env scripts/eval-golden.mjs)');
  process.exit(1);
}
const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const idx = indexTaxonomy(read('../extension/taxonomy.json'));
const golden = read('./golden.json');
const cfg = { ...DEFAULTS };

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

const t0 = Date.now();
const rows = await pool(golden, 6, async (g) => {
  const state = stateFor(g);
  const t = Date.now();
  const r1 = await callJev({ apiKey, state, questions: buildStage1(idx) });
  const s1 = parseStage1(r1);
  const ms1 = Date.now() - t;
  let s2 = null;
  if (passesGate(s1, cfg)) s2 = parseStage2(await callJev({ apiKey, state, questions: buildStage2(idx, s1.fam) }));
  const top = Object.entries(r1.answers.family.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([k, v]) => `${k}:${v}`).join(' ');
  return { g, s1, s2, ms1, top, gated: passesGate(s1, cfg), display: passesGate(s1, cfg) ? toDisplay(idx, s1, s2, cfg) : null };
});

const wantNeutral = (g) => g.ok.length === 1 && g.ok[0] === 'neutral';
let famHit = 0, manipulative = 0, maskedManipulative = 0, neutral = 0, maskedNeutral = 0;
for (const r of rows) {
  const hit = r.g.ok.includes(r.s1.fam);
  if (hit) famHit++;
  if (wantNeutral(r.g)) {
    neutral++;
    if (r.gated) maskedNeutral++;
  } else {
    manipulative++;
    if (r.gated) maskedManipulative++;
  }
  console.log(
    `${hit ? 'OK  ' : 'MISS'} ${r.gated ? 'MASK' : '----'} fam=${r.s1.fam}(${r.s1.famConf}) manip=${r.s1.manip} int=${r.s1.intensity?.toFixed(2)} ` +
      `| want ${r.g.ok.join('/')} | ${r.g.title}\n       top3: ${r.top}${r.display ? `\n       -> ${r.display.big} / ${r.display.small}` : ''}`
  );
}
const lat = rows.map((r) => r.ms1).sort((a, b) => a - b);
console.log(
  `\nfamily accuracy: ${famHit}/${rows.length}` +
    `\nmanipulative titles masked: ${maskedManipulative}/${manipulative}` +
    `\nneutral titles wrongly masked: ${maskedNeutral}/${neutral}` +
    `\nstage-1 latency ms: median ${lat[Math.floor(lat.length / 2)]}, max ${lat[lat.length - 1]}  (wall ${Date.now() - t0} ms for ${rows.length} titles)`
);
