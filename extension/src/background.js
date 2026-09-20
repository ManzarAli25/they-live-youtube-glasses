import {
  callJev, DEFAULTS, indexTaxonomy, buildStage1, buildStage2, stateFor,
  parseStage1, parseStage2, passesGate, toDisplay
} from './jev.js';

const MAX_INFLIGHT = 6;
const CACHE_TTL_MS = 30 * 24 * 3600 * 1000;
const CACHE_MAX_ENTRIES = 4000;

let lastError = null;
let indexPromise = null;
const inflight = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getIndex() {
  indexPromise ||= fetch(chrome.runtime.getURL('taxonomy.json'))
    .then((r) => r.json())
    .then(indexTaxonomy);
  return indexPromise;
}

async function getSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
}

async function updateBadge() {
  const { enabled, apiKey } = await getSettings();
  let text = enabled ? 'ON' : 'OFF';
  let color = enabled ? '#1a7f37' : '#6e7781';
  if (enabled && (lastError || !apiKey)) {
    text = 'ERR';
    color = '#cf222e';
  }
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setTitle({
    title: !apiKey ? 'They Live glasses: add your Jev API key in Options' : lastError ? `They Live glasses: ${lastError}` : `They Live glasses: ${enabled ? 'ON' : 'OFF'} (click to toggle)`
  });
}

// Concurrency limiter: at most MAX_INFLIGHT Jev requests at once.
let active = 0;
const waiting = [];
function limited(fn) {
  return new Promise((resolve, reject) => {
    waiting.push({ fn, resolve, reject });
    pump();
  });
}
function pump() {
  while (active < MAX_INFLIGHT && waiting.length) {
    const job = waiting.shift();
    active++;
    job.fn().then(job.resolve, job.reject).finally(() => {
      active--;
      pump();
    });
  }
}

async function jev(settings, state, questions) {
  return limited(async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await callJev({ apiKey: settings.apiKey, model: settings.model, state, questions });
      } catch (e) {
        if (e.kind === 'rate' && attempt < 3) await sleep((e.retryAfter ?? 2 ** attempt) * 1000);
        else if ((e.kind === 'net' || e.kind === 'server') && attempt < 1) await sleep(800);
        else throw e;
      }
    }
  });
}

async function classifyUncached({ videoId, title, channel }) {
  const settings = await getSettings();
  if (!settings.apiKey) return { error: 'nokey' };
  const idx = await getIndex();
  const key = `c:${videoId}:${idx.version}:${settings.model}`;
  const state = stateFor({ title, channel });

  const stored = (await chrome.storage.local.get(key))[key];
  const entry = stored || { t: Date.now(), s1: null, s2: null };
  let dirty = false;

  if (!entry.s1) {
    entry.s1 = parseStage1(await jev(settings, state, buildStage1(idx)));
    dirty = true;
  }
  const s1 = entry.s1;
  const known = idx.families.has(s1.fam);
  const gated = known && passesGate(s1, settings);

  if (gated && !entry.s2) {
    try {
      entry.s2 = parseStage2(await jev(settings, state, buildStage2(idx, s1.fam)));
      dirty = true;
    } catch (e) {
      if (e.kind === 'auth' || e.kind === 'rate') throw e;
    }
  }
  if (dirty) await chrome.storage.local.set({ [key]: entry });

  if (lastError) {
    lastError = null;
    updateBadge();
  }
  return gated ? toDisplay(idx, s1, entry.s2, settings) : { show: false };
}

async function classify(req) {
  if (inflight.has(req.videoId)) return inflight.get(req.videoId);
  const p = classifyUncached(req)
    .catch((e) => {
      if (e.kind === 'auth') lastError = 'API key rejected';
      else if (e.kind === 'bad') lastError = 'Jev rejected a request';
      if (e.kind === 'auth' || e.kind === 'bad') updateBadge();
      return { error: e.kind || 'internal' };
    })
    .finally(() => inflight.delete(req.videoId));
  inflight.set(req.videoId, p);
  return p;
}

async function testKey(apiKey) {
  const idx = await getIndex();
  const settings = { ...(await getSettings()), apiKey };
  try {
    const parsed = parseStage1(await jev(settings, stateFor({ title: 'How to bake sourdough bread', channel: 'test' }), buildStage1(idx)));
    return { ok: true, fam: parsed.fam };
  } catch (e) {
    return { ok: false, kind: e.kind || 'internal', message: e.message };
  }
}

async function pruneCache() {
  const all = await chrome.storage.local.get(null);
  const entries = Object.entries(all).filter(([k]) => k.startsWith('c:'));
  const cutoff = Date.now() - CACHE_TTL_MS;
  const stale = entries.filter(([, v]) => !v.t || v.t < cutoff).map(([k]) => k);
  const fresh = entries.filter(([, v]) => v.t && v.t >= cutoff).sort((a, b) => a[1].t - b[1].t);
  const overflow = fresh.slice(0, Math.max(0, fresh.length - CACHE_MAX_ENTRIES)).map(([k]) => k);
  const drop = [...stale, ...overflow];
  if (drop.length) await chrome.storage.local.remove(drop);
}

async function clearCache() {
  const all = await chrome.storage.local.get(null);
  await chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith('c:')));
}

chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  if (msg.type === 'classify') {
    classify(msg).then(send);
    return true;
  }
  if (msg.type === 'test-key') {
    testKey(msg.apiKey).then((r) => {
      if (r.ok) {
        lastError = null;
        updateBadge();
      }
      send(r);
    });
    return true;
  }
  if (msg.type === 'clear-cache') {
    clearCache().then(() => send({ ok: true }));
    return true;
  }
  return false;
});

chrome.action.onClicked.addListener(async () => {
  const { enabled } = await getSettings();
  await chrome.storage.local.set({ enabled: !enabled });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if ('apiKey' in changes) lastError = null;
  if ('enabled' in changes || 'apiKey' in changes) updateBadge();
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') {
    const { apiKey } = await getSettings();
    if (!apiKey) chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onStartup.addListener(pruneCache);
updateBadge();
