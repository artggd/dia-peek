// Content script (top frame only): decides which link clicks open a peek and draws the peek card.

(() => {
  if (window.top !== window) {
    return;
  }

  const { DEFAULT_SETTINGS, PEEK_FRAME_ALLOW, siteOf } = PeekShared;
  const OPEN_DURATION_MS = 320;
  const CLOSE_DURATION_MS = 200;
  const EXPAND_DURATION_MS = 220;
  const BACKDROP_FADE_MS = 200;
  const COPIED_FEEDBACK_MS = 1200;
  const HISTORY_UNWIND_TIMEOUT_MS = 600;
  const ORIGIN_SCALE = 0.15;
  const EASE_OUT = 'cubic-bezier(0.2, 0.9, 0.25, 1)';
  const EASE_IN = 'cubic-bezier(0.4, 0, 1, 1)';
  const MAX_Z_INDEX = '2147483647';

  // The card embeds this extension page, which embeds the peeked page (see peek/frame.js).
  const PEEK_FRAME_PAGE = 'peek/frame.html';

  const ICON_PATHS = {
    copy: 'M9 9h10v10H9zM5 15V5h10',
    expand: 'M14 4h6v6M20 4l-8 8M10 20H4v-6M4 20l8-8',
    close: 'M6 6l12 12M18 6L6 18',
  };

  const STYLES = `
    :host { color-scheme: light dark; }
    .backdrop {
      position: fixed; inset: 0;
      background: rgba(12, 12, 18, 0.42);
    }
    .panel {
      position: fixed;
      top: 52px; bottom: max(16px, 3vh); left: max(24px, 4vw); right: max(24px, 4vw);
      display: flex; flex-direction: column;
      outline: none;
      transform-origin: center;
    }
    .toolbar {
      position: absolute; top: -40px; left: 0; right: 0; height: 32px;
      display: flex; align-items: center; gap: 6px;
    }
    .site {
      min-width: 0; max-width: 50%; margin-right: auto;
      height: 30px; padding: 0 12px; border-radius: 15px;
      font: 500 13px/30px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      background: rgba(255, 255, 255, 0.94); color: #1d1d22;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.22);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    button {
      all: unset;
      width: 30px; height: 30px; border-radius: 50%;
      display: grid; place-items: center;
      background: rgba(255, 255, 255, 0.94); color: #1d1d22;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.22);
      cursor: pointer;
      transition: transform 120ms ease, background 120ms ease;
    }
    button:hover { background: #fff; transform: scale(1.06); }
    button:active { transform: scale(0.96); }
    button:focus-visible { box-shadow: 0 0 0 2px #fff, 0 0 0 4px #5b5bf0; }
    button svg {
      width: 16px; height: 16px;
      fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round;
    }
    .card {
      position: relative; flex: 1;
      border-radius: 12px; overflow: hidden;
      background: #fff;
      box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.08), 0 24px 80px rgba(0, 0, 0, 0.38);
    }
    iframe {
      display: block; width: 100%; height: 100%; border: 0;
      background: #fff;
    }
    .progress {
      position: absolute; top: 0; left: 0; height: 2px; width: 35%;
      background: #5b5bf0;
      animation: progress 1.1s ease-in-out infinite;
    }
    .progress[hidden] { display: none; }
    @keyframes progress {
      from { transform: translateX(-100%); }
      to { transform: translateX(300%); }
    }
    @media (prefers-color-scheme: dark) {
      button, .site { background: rgba(44, 44, 52, 0.94); color: #f2f2f5; }
      button:hover { background: #3a3a44; }
      .card, iframe { background: #1c1c21; }
    }
  `;

  let settings = { ...DEFAULT_SETTINGS };
  let activePeek = null;

  chrome.storage.sync.get(DEFAULT_SETTINGS).then((stored) => {
    settings = stored;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') {
      return;
    }
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (key in DEFAULT_SETTINGS) {
        settings[key] = newValue ?? DEFAULT_SETTINGS[key];
      }
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    switch (message.type) {
      case 'peek:url':
        activePeek?.setUrl(message.url);
        break;
      case 'peek:close-request':
        activePeek?.close();
        break;
    }
  });

  window.addEventListener('click', onClick, true);

  function onClick(event) {
    const hasModifier = event.shiftKey || event.altKey || event.ctrlKey || event.metaKey;
    if (activePeek || event.button !== 0 || hasModifier) {
      return;
    }
    const anchor = findAnchor(event);
    if (!anchor) {
      return;
    }
    const url = peekableUrl(anchor);
    if (!url) {
      return;
    }

    // Only sites the user turned Peek on for, and only for links leaving that site.
    const pageSite = siteOf(location.hostname);
    if (!settings.peekSites.includes(pageSite) || siteOf(url.hostname) === pageSite) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    activePeek = createPeek(url.href, anchor);
  }

  function findAnchor(event) {
    return (
      event
        .composedPath()
        .find(
          (node) =>
            (node instanceof HTMLAnchorElement || node instanceof HTMLAreaElement) &&
            node.hasAttribute('href'),
        ) ?? null
    );
  }

  function peekableUrl(anchor) {
    if (anchor.hasAttribute('download')) {
      return null;
    }
    let url;
    try {
      url = new URL(anchor.href);
    } catch {
      return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    // In-page anchors (#section) keep their normal behaviour.
    const withoutHash = (value) => value.split('#')[0];
    if (url.hash && withoutHash(url.href) === withoutHash(location.href)) {
      return null;
    }
    return url;
  }

  function displayHost(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url;
    }
  }

  function prefersReducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function createElement(tag, attributes = {}) {
    const element = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) {
      element.setAttribute(name, value);
    }
    return element;
  }

  function createIconButton(icon, label) {
    const button = createElement('button', { type: 'button', title: label, 'aria-label': label });
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', ICON_PATHS[icon]);
    svg.append(path);
    button.append(svg);
    return button;
  }

  // Transform that places the panel over `rect` (the clicked link), used as the
  // start of the open animation and the end of the close animation.
  function transformFromRect(panel, rect) {
    const panelRect = panel.getBoundingClientRect();
    const isVisible =
      rect && rect.width > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
    if (!isVisible) {
      return `scale(${ORIGIN_SCALE * 4})`;
    }
    const dx = rect.left + rect.width / 2 - (panelRect.left + panelRect.width / 2);
    const dy = rect.top + rect.height / 2 - (panelRect.top + panelRect.height / 2);
    return `translate(${dx}px, ${dy}px) scale(${ORIGIN_SCALE})`;
  }

  async function copyText(text, fallbackRoot) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // The page may block the async clipboard API through Permissions-Policy.
      const textarea = createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      fallbackRoot.append(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }
  }

  function createPeek(initialUrl, anchor) {
    let currentUrl = initialUrl;
    let isClosing = false;
    let urlWaiters = [];
    const historyLengthAtOpen = history.length;

    const host = document.createElement('dia-peek');
    host.style.all = 'initial';
    host.style.position = 'fixed';
    host.style.inset = '0';
    host.style.zIndex = MAX_Z_INDEX;
    host.style.display = 'block';

    const shadow = host.attachShadow({ mode: 'closed' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(STYLES);
    shadow.adoptedStyleSheets = [sheet];

    const backdrop = createElement('div', { class: 'backdrop' });
    const panel = createElement('div', {
      class: 'panel',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': chrome.i18n.getMessage('peekDialogLabel'),
      tabindex: '-1',
    });
    const toolbar = createElement('div', { class: 'toolbar' });
    const site = createElement('div', { class: 'site' });
    site.textContent = displayHost(currentUrl);
    const copyLabel = chrome.i18n.getMessage('copyLink');
    const copyButton = createIconButton('copy', copyLabel);
    const expandButton = createIconButton('expand', chrome.i18n.getMessage('openInNewTab'));
    const closeButton = createIconButton('close', chrome.i18n.getMessage('closePeek'));
    toolbar.append(site, copyButton, expandButton, closeButton);

    const card = createElement('div', { class: 'card' });
    const progress = createElement('div', { class: 'progress' });
    const iframe = createElement('iframe', { allow: PEEK_FRAME_ALLOW });
    card.append(iframe, progress);
    panel.append(toolbar, card);
    shadow.append(backdrop, panel);

    const previousOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    document.documentElement.append(host);

    const reducedMotion = prefersReducedMotion();
    panel.animate(
      [
        { transform: reducedMotion ? 'none' : transformFromRect(panel, anchor.getBoundingClientRect()), opacity: 0 },
        { transform: 'none', opacity: 1 },
      ],
      { duration: OPEN_DURATION_MS, easing: EASE_OUT },
    );
    backdrop.animate([{ opacity: 0 }, { opacity: 1 }], { duration: BACKDROP_FADE_MS });
    panel.focus({ preventScroll: true });

    iframe.addEventListener('load', () => {
      if (iframe.src) {
        progress.hidden = true;
      }
    });

    // The background worker sets up the framing and cookie rules for this tab before the page
    // loads. The peeked page sits one frame deeper, so the worker spots it by its first navigation.
    chrome.runtime
      .sendMessage({ type: 'peek:open', frameId: null, url: initialUrl })
      .catch(() => {})
      .finally(() => {
        if (!isClosing) {
          iframe.src = `${chrome.runtime.getURL(PEEK_FRAME_PAGE)}?${new URLSearchParams({ url: initialUrl })}`;
        }
      });

    function onKeyDown(event) {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    }
    window.addEventListener('keydown', onKeyDown, true);

    backdrop.addEventListener('click', () => close());
    closeButton.addEventListener('click', () => close());
    copyButton.addEventListener('click', async () => {
      await copyText(currentUrl, shadow);
      copyButton.title = chrome.i18n.getMessage('linkCopied');
      setTimeout(() => {
        copyButton.title = copyLabel;
      }, COPIED_FEEDBACK_MS);
    });
    expandButton.addEventListener('click', () => expand());

    // Links followed inside the peek add entries to this tab's history; step back over them
    // so the Back button keeps working on the host page once the peek is gone.
    async function unwindHistory() {
      const response = await chrome.runtime.sendMessage({ type: 'peek:history-depth' }).catch(() => null);
      // Never step back further than the peek grew the history, so the host page can't be sent back.
      const steps = Math.min(response?.depth ?? 0, history.length - historyLengthAtOpen);
      if (steps <= 0) {
        return;
      }
      const traversed = new Promise((resolve) => urlWaiters.push(resolve));
      history.go(-steps);
      await Promise.race([traversed, new Promise((resolve) => setTimeout(resolve, HISTORY_UNWIND_TIMEOUT_MS))]);
    }

    function teardown() {
      window.removeEventListener('keydown', onKeyDown, true);
      host.remove();
      document.documentElement.style.overflow = previousOverflow;
      if (activePeek === peek) {
        activePeek = null;
      }
    }

    async function close() {
      if (isClosing) {
        return;
      }
      isClosing = true;
      const unwound = unwindHistory();
      const target = reducedMotion || !anchor.isConnected
        ? 'none'
        : transformFromRect(panel, anchor.getBoundingClientRect());
      backdrop.animate([{ opacity: 1 }, { opacity: 0 }], { duration: CLOSE_DURATION_MS, fill: 'forwards' });
      await panel
        .animate([{ transform: 'none', opacity: 1 }, { transform: target, opacity: 0 }], {
          duration: CLOSE_DURATION_MS,
          easing: EASE_IN,
          fill: 'forwards',
        })
        .finished.catch(() => {});
      await unwound;
      teardown();
      chrome.runtime.sendMessage({ type: 'peek:close' }).catch(() => {});
    }

    async function expand() {
      if (isClosing) {
        return;
      }
      isClosing = true;
      const urlToOpen = currentUrl;
      const unwound = unwindHistory();
      // Grow the card to fill the window, then hand the page over to a real tab.
      const rect = panel.getBoundingClientRect();
      const scaleX = window.innerWidth / rect.width;
      const scaleY = window.innerHeight / rect.height;
      const dy = window.innerHeight / 2 - (rect.top + rect.height / 2);
      toolbar.style.visibility = 'hidden';
      if (!reducedMotion) {
        await panel
          .animate(
            [{ transform: 'none' }, { transform: `translateY(${dy}px) scale(${scaleX}, ${scaleY})` }],
            { duration: EXPAND_DURATION_MS, easing: EASE_OUT, fill: 'forwards' },
          )
          .finished.catch(() => {});
      }
      await unwound;
      await chrome.runtime.sendMessage({ type: 'peek:expand', url: urlToOpen }).catch(() => {});
      teardown();
    }

    const peek = {
      setUrl(url) {
        if (url === 'about:blank') {
          return;
        }
        currentUrl = url;
        site.textContent = displayHost(url);
        const waiters = urlWaiters;
        urlWaiters = [];
        waiters.forEach((resolve) => resolve());
      },
      close,
    };
    return peek;
  }
})();
