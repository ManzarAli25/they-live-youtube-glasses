(() => {
  // Home feed cards, search result rows and watch-page sidebar cards (classic and lockup layouts), and Shorts tiles.
  const CARD = 'ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, yt-lockup-view-model, ytm-shorts-lockup-view-model, ytd-reel-item-renderer';
  // Cards nest (e.g. a Shorts tile inside a rich item); only the outermost one is processed.
  const cards = () => [...document.querySelectorAll(CARD)].filter((c) => !c.parentElement.closest(CARD));
  // Structure/attribute based: YouTube's generated class names change, element names and hrefs are stabler.
  const TITLE_SEL = 'yt-lockup-metadata-view-model h3, #video-title';
  const CHANNEL_SEL = 'yt-content-metadata-view-model a[href^="/@"], yt-content-metadata-view-model a[href^="/channel/"], ytd-channel-name a, ytd-channel-name yt-formatted-string, yt-content-metadata-view-model .yt-content-metadata-view-model__metadata-text';
  const THUMB_SEL = 'yt-thumbnail-view-model, ytd-thumbnail';

  let enabled = true;
  const FEED_PATHS = ['/', '/results', '/watch'];
  const isFeed = () => FEED_PATHS.includes(location.pathname);
  const active = () => enabled && isFeed();

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const st = e.target.__tl;
        if (!st) continue;
        st.visible = e.isIntersecting;
        if (e.isIntersecting) process(e.target);
      }
    },
    { rootMargin: '300px' }
  );

  function readCard(card) {
    const link = card.querySelector('a[href*="/watch?v="], a[href^="/shorts/"]');
    if (!link) return null;
    const m = link.href.match(/[?&]v=([\w-]{11})|\/shorts\/([\w-]{11})/);
    if (!m) return null;
    const titleEl = card.querySelector(TITLE_SEL) || card.querySelector('h3');
    // Shorts cards: aria-label reads "<title>, 1.3 million views - play Short".
    const aria = (link.getAttribute('aria-label') || '').replace(/,[^,]*(views?|play short)[^,]*$/i, '');
    const title = ((titleEl && (titleEl.getAttribute('title') || titleEl.textContent)) || link.getAttribute('title') || aria).trim();
    const thumb = card.querySelector(THUMB_SEL);
    if (!title || !thumb) return null;
    const channelEl = card.querySelector(CHANNEL_SEL);
    return { videoId: m[1] || m[2], title, channel: ((channelEl && channelEl.textContent) || '').trim(), thumb };
  }

  function clearMask(card) {
    card.querySelectorAll('.tl-mask').forEach((n) => n.remove());
  }

  function renderMask(thumb, res) {
    thumb.querySelectorAll('.tl-mask').forEach((n) => n.remove());
    thumb.classList.add('tl-host');
    const mask = document.createElement('div');
    mask.className = res.neutral ? 'tl-mask tl-neutral' : 'tl-mask';
    mask.style.setProperty('--tl-a', String(0.55 + 0.4 * res.intensity));
    const big = document.createElement('div');
    big.className = 'tl-big';
    big.textContent = res.big;
    mask.append(big);
    if (res.small) {
      const small = document.createElement('div');
      small.className = 'tl-small';
      small.textContent = res.small;
      mask.append(small);
    }
    thumb.append(mask);
  }

  async function process(card, attempt = 0) {
    if (!active()) return;
    const st = card.__tl;
    const info = readCard(card);
    if (!info) {
      if (attempt < 5) setTimeout(() => card.__tl && card.__tl.visible && process(card, attempt + 1), 600);
      return;
    }
    if (st.vid === info.videoId) return;
    clearMask(card);
    st.vid = info.videoId;
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'classify', videoId: info.videoId, title: info.title, channel: info.channel });
    } catch {
      return;
    }
    if (!res || !res.show || !active() || st.vid !== info.videoId) return;
    const fresh = readCard(card);
    if (fresh && fresh.videoId === info.videoId) renderMask(fresh.thumb, res);
  }

  function scan() {
    if (!active()) return;
    for (const card of cards()) {
      if (!card.__tl) {
        card.__tl = { vid: null, visible: false };
        io.observe(card);
      } else if (card.__tl.visible) {
        process(card);
      }
    }
  }

  let timer = 0;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(scan, 300);
  };

  function applyState() {
    document.documentElement.classList.toggle('tl-glasses', active());
    if (active()) schedule();
  }

  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('yt-navigate-finish', applyState);
  window.addEventListener('popstate', applyState);

  chrome.storage.local.get('enabled').then((s) => {
    enabled = s.enabled !== false;
    applyState();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.enabled) {
      enabled = changes.enabled.newValue !== false;
      applyState();
    }
  });
})();
