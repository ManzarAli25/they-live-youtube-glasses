// Usage: node --env-file=.env scripts/smoke-test.mjs
import { readFileSync } from 'node:fs';
import {
  callJev, JevError, DEFAULT_MODEL, indexTaxonomy, buildStage1, buildStage2, stateFor,
  parseStage1, parseStage2, passesGate, toDisplay
} from '../extension/src/jev.js';

const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) {
  console.error('TYPESAFE_API_KEY is not set. Put it in .env as TYPESAFE_API_KEY=... and run:\n  node --env-file=.env scripts/smoke-test.mjs');
  process.exit(1);
}

const idx = indexTaxonomy(JSON.parse(readFileSync(new URL('../extension/taxonomy.json', import.meta.url), 'utf8')));
const cfg = { famConf: 0.35, manip: 0.5, labelConf: 0.3, primary: 'label' };
const samples = [
  { title: "DOCTORS DON'T WANT YOU TO KNOW This 1 Trick Melts Belly Fat Overnight", channel: 'HealthHacks' },
  { title: 'How I built a 3D printer from scratch (full build log)', channel: 'Maker Notes' },
  { title: 'The END of Apple? What just happened will SHOCK you', channel: 'TechDaily' }
];

let scheme = 'bearer';
async function run(state, questions) {
  try {
    return await callJev({ apiKey, model: DEFAULT_MODEL, state, questions, scheme });
  } catch (e) {
    if (e instanceof JevError && e.kind === 'auth' && scheme === 'bearer') {
      console.log('Bearer auth rejected, retrying with x-api-key ...');
      scheme = 'x-api-key';
      return callJev({ apiKey, model: DEFAULT_MODEL, state, questions, scheme });
    }
    throw e;
  }
}

try {
  for (const [i, s] of samples.entries()) {
    const state = stateFor(s);
    const r1 = await run(state, buildStage1(idx));
    if (i === 0) console.log(`auth scheme: ${scheme}\nraw stage-1 response (check the noul and score shapes):\n${JSON.stringify(r1, null, 2)}\n`);
    const s1 = parseStage1(r1);
    let s2 = null;
    if (passesGate(s1, cfg)) s2 = parseStage2(await run(state, buildStage2(idx, s1.fam)));
    const shown = passesGate(s1, cfg) ? JSON.stringify(toDisplay(idx, s1, s2, cfg)) : 'no mask (gated out)';
    console.log(`"${s.title}"\n  stage1: ${JSON.stringify(s1)}\n  stage2: ${JSON.stringify(s2)}\n  display: ${shown}\n`);
  }
  console.log('smoke test OK');
} catch (e) {
  console.error(`smoke test FAILED [${e.kind || 'error'}]: ${e.message}`);
  process.exit(1);
}
