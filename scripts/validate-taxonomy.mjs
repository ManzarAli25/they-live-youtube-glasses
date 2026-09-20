import { readFileSync } from 'node:fs';
import { slug, NEUTRAL_ID } from '../extension/src/jev.js';

const tax = JSON.parse(readFileSync(new URL('../extension/taxonomy.json', import.meta.url), 'utf8'));
const errors = [];
const seenNames = new Map();
const famIds = new Set();
let total = 0;

if (tax.families.length > 255) errors.push(`Too many families: ${tax.families.length} (max 255)`);
if (!tax.families.some((f) => f.id === NEUTRAL_ID)) errors.push(`Missing "${NEUTRAL_ID}" family`);

for (const f of tax.families) {
  if (famIds.has(f.id)) errors.push(`Duplicate family id: ${f.id}`);
  famIds.add(f.id);
  if (!f.name || !f.description) errors.push(`Family ${f.id} needs name and description`);
  if (f.labels.length === 0) errors.push(`Family ${f.id} has no labels`);
  if (f.labels.length > 255) errors.push(`Family ${f.id} has ${f.labels.length} labels (max 255)`);
  const slugs = new Set();
  for (const name of f.labels) {
    total++;
    const s = slug(name);
    if (!s) errors.push(`Label "${name}" in ${f.id} has an empty slug`);
    if (slugs.has(s)) errors.push(`Slug collision in ${f.id}: "${name}" -> ${s}`);
    slugs.add(s);
    if (seenNames.has(name)) errors.push(`Label "${name}" appears in both ${seenNames.get(name)} and ${f.id}`);
    seenNames.set(name, f.id);
  }
}

for (const key of Object.keys(tax.descriptions || {})) {
  if (!seenNames.has(key)) errors.push(`Description for unknown label: "${key}"`);
}
for (const name of tax.deferred.labels) {
  if (seenNames.has(name)) errors.push(`Deferred label is also active: "${name}" (in ${seenNames.get(name)})`);
}

const max = Math.max(...tax.families.map((f) => f.labels.length));
console.log(`families: ${tax.families.length}  labels: ${total}  largest family: ${max}  descriptions: ${Object.keys(tax.descriptions).length}  deferred: ${tax.deferred.labels.length}`);
if (errors.length) {
  console.error(errors.map((e) => `ERROR ${e}`).join('\n'));
  process.exit(1);
}
console.log('taxonomy OK');
