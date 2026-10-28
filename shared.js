// Shared by the service worker, the content script and the options page.

(() => {
  // `peekSites`: sites (e.g. "slack.com") where clicking a link to another site opens it in Peek.
  const DEFAULT_SETTINGS = { peekSites: [] };

  // Browser features the peeked page may use, granted through both frames around it.
  const PEEK_FRAME_ALLOW = 'fullscreen; autoplay; clipboard-write; encrypted-media; picture-in-picture';

  // Two-label public suffixes common enough to matter when comparing sites.
  const MULTI_LABEL_SUFFIXES = new Set([
    'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp',
    'co.kr', 'co.in', 'co.za', 'com.br', 'com.cn', 'com.mx', 'com.tr', 'com.sg', 'github.io',
  ]);

  // Registrable domain of a hostname, approximated: "app.slack.com" -> "slack.com".
  function siteOf(hostname) {
    const labels = hostname.toLowerCase().replace(/\.$/, '').split('.');
    const isIpAddress = /^\d+$/.test(labels[labels.length - 1]) || hostname.includes(':');
    if (labels.length <= 2 || isIpAddress) {
      return hostname.toLowerCase();
    }
    const lastTwo = labels.slice(-2).join('.');
    return labels.slice(MULTI_LABEL_SUFFIXES.has(lastTwo) ? -3 : -2).join('.');
  }

  // Site of an http(s) URL, or null for anything Peek can't run on (browser pages, files…).
  function siteFromUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? siteOf(parsed.hostname) : null;
    } catch {
      return null;
    }
  }

  // Accepts what people type in the settings: "slack.com", "app.slack.com/client", a full URL…
  function siteFromInput(input) {
    const trimmed = input.trim();
    if (!trimmed) {
      return null;
    }
    const site = siteFromUrl(/^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return site && site.includes('.') ? site : null;
  }

  globalThis.PeekShared = { DEFAULT_SETTINGS, PEEK_FRAME_ALLOW, siteOf, siteFromUrl, siteFromInput };
})();
