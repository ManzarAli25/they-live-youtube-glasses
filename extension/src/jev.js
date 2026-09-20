// Pure ES module shared by the extension service worker and the Node scripts.
export const API_URL = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_MODEL = 'jev-1.13.0';
export const NEUTRAL_ID = 'neutral';

export const DEFAULTS = {
  enabled: true,
  apiKey: '',
  model: DEFAULT_MODEL,
  famConf: 0.35,
  manip: 0.5,
  labelConf: 0.3,
  primary: 'label'
};

export const INTENSITY_LEVELS = [
  'Straightforward, honest title that simply describes the content.',
  'Catchy or appealing, but not misleading and no obvious tactic.',
  'Noticeably uses a persuasion trick or emotional hook to earn the click.',
  'Heavily engineered for clicks, with exaggeration or emotional pressure.',
  'Pure bait: extreme exaggeration, manipulation or deception to force the click.'
];

export function slug(name) {
  return name
    .toLowerCase()
    .replace(/[“”"'’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function indexTaxonomy(tax) {
  const families = new Map();
  for (const f of tax.families) {
    const labels = new Map();
    for (const name of f.labels) labels.set(slug(name), name);
    families.set(f.id, { ...f, labelMap: labels });
  }
  return { families, descriptions: tax.descriptions || {}, version: tax.version };
}

export function stateFor({ title, channel }) {
  return `Title: ${title}\nChannel: ${channel || 'unknown'}`;
}

export function buildStage1(idx) {
  const familyCriteria = {};
  for (const f of idx.families.values()) familyCriteria[f.id] = `${f.name}: ${f.description}`;
  return {
    family: {
      type: 'choice',
      instructions:
        'Which persuasion or manipulation tactic family does this YouTube video title mainly use to earn a click? Judge the wording of the title only. Choose neutral if it simply describes the content.',
      criteria: familyCriteria
    },
    intensity: {
      type: 'score',
      instructions: 'How manipulative is the wording of this YouTube video title?',
      criteria: INTENSITY_LEVELS
    },
    manipulative: {
      type: 'noul',
      instructions: 'Does this YouTube video title use a persuasion or manipulation tactic to earn the click?'
    }
  };
}

export function buildStage2(idx, familyId) {
  const f = idx.families.get(familyId);
  if (!f) throw new Error(`Unknown family: ${familyId}`);
  const criteria = {};
  for (const [key, name] of f.labelMap) criteria[key] = idx.descriptions[name] || name;
  return {
    label: {
      type: 'choice',
      instructions: `This YouTube video title uses a tactic from the "${f.name}" family. Which specific tactic best describes it?`,
      criteria
    }
  };
}

export class JevError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.kind = kind; // auth | rate | bad | server | net
    Object.assign(this, extra);
  }
}

export function authHeaders(apiKey, scheme = 'bearer') {
  return scheme === 'x-api-key' ? { 'x-api-key': apiKey } : { Authorization: `Bearer ${apiKey}` };
}

export async function callJev({ apiKey, model = DEFAULT_MODEL, state, questions, scheme = 'bearer', fetchImpl = fetch }) {
  let res;
  try {
    res = await fetchImpl(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(apiKey, scheme) },
      body: JSON.stringify({ model, state, questions }),
      signal: AbortSignal.timeout(20000)
    });
  } catch (e) {
    throw new JevError('net', `Network error: ${e.message}`);
  }
  if (res.ok) return res.json();
  const body = await res.text().catch(() => '');
  if (res.status === 401 || res.status === 403) throw new JevError('auth', `Auth failed (${res.status}) ${body}`, { status: res.status });
  if (res.status === 429) {
    const ra = Number(res.headers.get('retry-after'));
    throw new JevError('rate', 'Rate limited', { status: 429, retryAfter: Number.isFinite(ra) && ra > 0 ? ra : null });
  }
  if (res.status >= 500) throw new JevError('server', `Server error ${res.status}`, { status: res.status });
  throw new JevError('bad', `Request rejected (${res.status}) ${body}`, { status: res.status });
}

function readChoice(a) {
  if (!a || typeof a.choice !== 'string') return null;
  return { choice: a.choice, confidence: typeof a.confidence === 'number' ? a.confidence : 0, probabilities: a.probabilities || {} };
}

// Noul shape is not documented precisely; accept the plausible variants.
function readNoul(a) {
  if (typeof a === 'number') return a;
  if (!a || typeof a !== 'object') return null;
  for (const k of ['noul', 'probability', 'p', 'yes']) if (typeof a[k] === 'number') return a[k];
  return null;
}

// Normalised 0..1 position from the level probabilities (independent of 0- or 1-based numbering).
function readIntensity(a) {
  if (!a) return null;
  let probs = a.probabilities;
  if (probs && !Array.isArray(probs)) {
    probs = Object.entries(probs)
      .sort((x, y) => Number(x[0]) - Number(y[0]))
      .map(([, v]) => v);
  }
  if (Array.isArray(probs) && probs.length > 1) {
    const total = probs.reduce((s, p) => s + p, 0) || 1;
    const mean = probs.reduce((s, p, i) => s + i * p, 0) / total;
    return mean / (probs.length - 1);
  }
  return null;
}

export function parseStage1(resp) {
  const ans = resp && resp.answers;
  const family = readChoice(ans && ans.family);
  if (!family) throw new JevError('bad', 'Unexpected response shape (family)');
  return {
    fam: family.choice,
    famConf: family.confidence,
    manip: readNoul(ans.manipulative),
    intensity: readIntensity(ans.intensity)
  };
}

export function parseStage2(resp) {
  const c = readChoice(resp && resp.answers && resp.answers.label);
  if (!c) throw new JevError('bad', 'Unexpected response shape (label)');
  return { label: c.choice, labelConf: c.confidence };
}

export function passesGate(s1, cfg) {
  if (!s1) return false;
  if (s1.famConf < cfg.famConf) return false;
  // Neutral titles are by definition not manipulative, so the manipulation threshold doesn't apply to them.
  if (s1.fam !== NEUTRAL_ID && s1.manip != null && s1.manip < cfg.manip) return false;
  return true;
}

export function toDisplay(idx, s1, s2, cfg) {
  const fam = idx.families.get(s1.fam);
  const slogan = fam.slogan || fam.name;
  const intensity = s1.intensity == null ? 0.5 : Math.min(1, Math.max(0, s1.intensity));
  const labelName = s2 && s2.labelConf >= cfg.labelConf ? fam.labelMap.get(s2.label) : null;
  if (s1.fam === NEUTRAL_ID) {
    return { show: true, neutral: true, big: labelName || fam.name, small: labelName ? fam.name : null, intensity };
  }
  if (!labelName) return { show: true, big: slogan, small: fam.name, intensity };
  return cfg.primary === 'slogan'
    ? { show: true, big: slogan, small: labelName, intensity }
    : { show: true, big: labelName, small: slogan, intensity };
}
