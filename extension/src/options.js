import { DEFAULTS } from './jev.js';

const $ = (id) => document.getElementById(id);
const sliders = ['famConf', 'manip', 'labelConf'];
const status = (msg) => {
  $('status').textContent = msg;
};

async function load() {
  const s = { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
  $('apiKey').value = s.apiKey;
  $('model').value = s.model;
  $('primary').value = s.primary;
  for (const k of sliders) {
    $(k).value = s[k];
    $(`${k}V`).textContent = Number(s[k]).toFixed(2);
  }
}

for (const k of sliders) {
  $(k).addEventListener('input', () => {
    $(`${k}V`).textContent = Number($(k).value).toFixed(2);
  });
}

$('save').addEventListener('click', async () => {
  const next = {
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim() || DEFAULTS.model,
    primary: $('primary').value
  };
  for (const k of sliders) next[k] = Number($(k).value);
  await chrome.storage.local.set(next);
  status('Saved. Reload YouTube to apply.');
});

$('test').addEventListener('click', async () => {
  const apiKey = $('apiKey').value.trim();
  if (!apiKey) return status('Paste a key first.');
  status('Testing...');
  const r = await chrome.runtime.sendMessage({ type: 'test-key', apiKey });
  status(r.ok ? 'Key works.' : `Failed (${r.kind}): ${r.message}`);
});

$('clear').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'clear-cache' });
  status('Cache cleared.');
});

load();
