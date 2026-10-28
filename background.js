// Service worker: owns the per-tab header rules that let a peeked page load in an iframe,
// tracks the peek frame's URL, opens peeks as real tabs, and runs the toolbar button that
// turns Peek on or off for the current site.

importScripts('shared.js');

const { DEFAULT_SETTINGS, siteFromUrl } = PeekShared;
// Settings that earlier versions stored and that no longer exist.
const REMOVED_SETTINGS = ['shiftClick', 'pinnedExternal'];
const PEEK_RULE_PRIORITY = 1;
const TOP_FRAME_ID = 0;
const BADGE_COLOR = '#5b5bf0';

// Only the peek iframe of a tab gets these headers stripped, and only while the peek is open.
const FRAMING_HEADERS = ['x-frame-options', 'content-security-policy'];
// The cookie rule for the peeked page's own requests covers everything but documents.
const DOCUMENT_RESOURCE_TYPES = ['main_frame', 'sub_frame'];

const peekKey = (tabId) => `peek:${tabId}`;

async function getPeek(tabId) {
  const key = peekKey(tabId);
  const stored = await chrome.storage.session.get(key);
  return stored[key] ?? null;
}

function hostOf(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.hostname : null;
  } catch {
    return null;
  }
}

// webNavigation events arrive in bursts; serialise every read-modify-write of the peek state
// and of its header rules, so no rule can outlive the peek that owns it.
let peekUpdates = Promise.resolve();
function serialise(task) {
  const result = peekUpdates.then(task);
  peekUpdates = result.catch(() => {});
  return result;
}

function updatePeek(tabId, update) {
  return serialise(async () => {
    const peek = await getPeek(tabId);
    if (peek) {
      await chrome.storage.session.set({ [peekKey(tabId)]: update(peek) });
    }
  });
}

let ruleIdAllocations = Promise.resolve();
function allocateRuleIds(count) {
  const result = ruleIdAllocations.then(async () => {
    const { nextRuleId = 1 } = await chrome.storage.session.get('nextRuleId');
    await chrome.storage.session.set({ nextRuleId: nextRuleId + count });
    return Array.from({ length: count }, (_, offset) => nextRuleId + offset);
  });
  ruleIdAllocations = result.catch(() => {});
  return result;
}

// Login cookies (SameSite Lax or Strict) are never sent to a page embedded in another site, so
// a peeked page would show you as logged out. These rules attach the cookies of `url`'s host,
// as a normal visit would: to the peek frame's own load, and to the requests that page makes.
async function cookieRules(tabId, url, [frameRuleId, subresourceRuleId]) {
  const cookies = await chrome.cookies.getAll({ url });
  if (cookies.length === 0) {
    return [];
  }
  const action = {
    type: 'modifyHeaders',
    requestHeaders: [
      { header: 'cookie', operation: 'set', value: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ') },
    ],
  };
  const host = hostOf(url);
  return [
    {
      id: frameRuleId,
      priority: PEEK_RULE_PRIORITY,
      action,
      condition: { tabIds: [tabId], requestDomains: [host], resourceTypes: ['sub_frame'] },
    },
    {
      id: subresourceRuleId,
      priority: PEEK_RULE_PRIORITY,
      action,
      // Requests the host page itself makes to that site keep their normal (cookie-less) behaviour.
      condition: {
        tabIds: [tabId],
        requestDomains: [host],
        initiatorDomains: [siteFromUrl(url)],
        excludedResourceTypes: DOCUMENT_RESOURCE_TYPES,
      },
    },
  ];
}

// Resolves to true when cookies were found for a host the peek had none for yet.
async function addCookieRulesNow(tabId, url) {
  const peek = await getPeek(tabId);
  const host = hostOf(url);
  if (!peek || host === null || peek.cookieHosts.includes(host)) {
    return false;
  }
  const rules = await cookieRules(tabId, url, await allocateRuleIds(2));
  if (rules.length > 0) {
    await chrome.declarativeNetRequest.updateSessionRules({ addRules: rules });
  }
  await chrome.storage.session.set({
    [peekKey(tabId)]: {
      ...peek,
      cookieHosts: [...peek.cookieHosts, host],
      ruleIds: [...peek.ruleIds, ...rules.map((rule) => rule.id)],
    },
  });
  return rules.length > 0;
}

function addCookieRules(tabId, url) {
  return serialise(() => addCookieRulesNow(tabId, url));
}

async function endPeekNow(tabId) {
  const peek = await getPeek(tabId);
  if (!peek) {
    return;
  }
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: peek.ruleIds });
  await chrome.storage.session.remove(peekKey(tabId));
}

function endPeek(tabId) {
  return serialise(() => endPeekNow(tabId));
}

function startPeek(tabId, frameId, url) {
  return serialise(async () => {
    await endPeekNow(tabId);
    const [framingRuleId] = await allocateRuleIds(1);
    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [
        {
          id: framingRuleId,
          priority: PEEK_RULE_PRIORITY,
          action: {
            type: 'modifyHeaders',
            responseHeaders: FRAMING_HEADERS.map((header) => ({ header, operation: 'remove' })),
          },
          condition: { tabIds: [tabId], resourceTypes: ['sub_frame'] },
        },
      ],
    });
    // `entries` mirrors the history entries the peek frame added to the tab, so closing the
    // peek can step back over them instead of leaving dead entries behind the Back button.
    await chrome.storage.session.set({
      [peekKey(tabId)]: { frameId, url, entries: [url], index: 0, ruleIds: [framingRuleId], cookieHosts: [] },
    });
    await addCookieRulesNow(tabId, url);
  });
}

// Chromium reports a navigation that adds a history entry in a subframe as `manual_subframe`;
// replacements, reloads and back/forward traversals are `auto_subframe`.
function trackHistoryEntry(peek, url, transitionType) {
  const { entries, index } = peek;
  if (transitionType === 'manual_subframe') {
    return { ...peek, entries: [...entries.slice(0, index + 1), url], index: index + 1 };
  }
  if (index > 0 && entries[index - 1] === url) {
    return { ...peek, index: index - 1 };
  }
  if (entries[index + 1] === url) {
    return { ...peek, index: index + 1 };
  }
  return { ...peek, entries: entries.map((entry, i) => (i === index ? url : entry)) };
}

function sendToTopFrame(tabId, message) {
  // The tab may have navigated away or have no content script (e.g. browser pages).
  chrome.tabs.sendMessage(tabId, message, { frameId: TOP_FRAME_ID }).catch(() => {});
}

// Runs inside the peeked page so Esc closes the peek even when the page has focus.
function installEscapeBridge() {
  if (globalThis.__diaPeekEscapeBridge) {
    return;
  }
  globalThis.__diaPeekEscapeBridge = true;
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !event.defaultPrevented) {
      chrome.runtime.sendMessage({ type: 'peek:escape' });
    }
  });
}

async function getPeekSites() {
  const { peekSites } = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return peekSites;
}

// Badge and tooltip of the toolbar button for one tab: "On" when its site is in the list.
async function refreshAction(tab, peekSites) {
  const site = siteFromUrl(tab.url ?? '');
  const isOn = site !== null && peekSites.includes(site);
  let title = chrome.i18n.getMessage('actionTitleUnavailable');
  if (site !== null) {
    title = chrome.i18n.getMessage(isOn ? 'actionTitleOn' : 'actionTitleOff', [site]);
  }
  await Promise.all([
    chrome.action.setBadgeText({ tabId: tab.id, text: isOn ? chrome.i18n.getMessage('badgeOn') : '' }),
    chrome.action.setTitle({ tabId: tab.id, title }),
  ]).catch(() => {});
}

async function refreshAllActions() {
  const [tabs, peekSites] = await Promise.all([chrome.tabs.query({}), getPeekSites()]);
  await Promise.all(tabs.map((tab) => refreshAction(tab, peekSites)));
}

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  await chrome.storage.sync.set(current);
  await chrome.storage.sync.remove(REMOVED_SETTINGS);
  // Rules left by a previous version would no longer belong to any peek.
  const staleRules = await chrome.declarativeNetRequest.getSessionRules();
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: staleRules.map((rule) => rule.id) });
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
  await refreshAllActions();
});

chrome.runtime.onStartup.addListener(refreshAllActions);

async function togglePeekSite(tab) {
  const site = siteFromUrl(tab.url ?? '');
  if (site === null) {
    return;
  }
  const peekSites = await getPeekSites();
  const updated = peekSites.includes(site)
    ? peekSites.filter((peekSite) => peekSite !== site)
    : [...peekSites, site].sort();
  // Every tab's badge is refreshed by the storage listener below.
  await chrome.storage.sync.set({ peekSites: updated });
}

chrome.action.onClicked.addListener(togglePeekSite);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.peekSites) {
    refreshAllActions();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tab = sender.tab;
  if (!tab) {
    return false;
  }

  switch (message.type) {
    case 'peek:open':
      startPeek(tab.id, message.frameId, message.url).then(
        () => sendResponse({ ok: true }),
        (error) => sendResponse({ ok: false, error: error.message }),
      );
      return true;

    case 'peek:history-depth':
      peekUpdates
        .then(() => getPeek(tab.id))
        .then((peek) => sendResponse({ depth: peek?.index ?? 0 }));
      return true;

    case 'peek:close':
      endPeek(tab.id).then(() => sendResponse({ ok: true }));
      return true;

    case 'peek:expand':
      chrome.tabs
        .create({
          url: message.url,
          windowId: tab.windowId,
          index: tab.index + 1,
          openerTabId: tab.id,
          active: true,
        })
        .then(() => endPeek(tab.id))
        .then(() => sendResponse({ ok: true }));
      return true;

    case 'peek:escape':
      sendToTopFrame(tab.id, { type: 'peek:close-request' });
      return false;

    default:
      return false;
  }
});

// Navigating resets a tab's badge, so set it again once the tab has its new URL.
chrome.tabs.onUpdated.addListener(async (_tabId, changeInfo, tab) => {
  if (changeInfo.url !== undefined || changeInfo.status !== undefined) {
    await refreshAction(tab, await getPeekSites());
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  endPeek(tabId);
});

async function onFrameUrlChanged(details) {
  const peek = await getPeek(details.tabId);
  if (!peek || details.frameId !== peek.frameId || details.url === 'about:blank') {
    return;
  }
  await updatePeek(details.tabId, (current) => trackHistoryEntry(current, details.url, details.transitionType));
  sendToTopFrame(details.tabId, { type: 'peek:url', url: details.url });
}

// Following a link inside the peek to a host it had no cookies for: the page has already been
// requested without them, so add them and load it once more (a reload adds no history entry).
async function reloadWithCookiesIfNeeded(details) {
  const peek = await getPeek(details.tabId);
  if (!peek || details.frameId !== peek.frameId) {
    return;
  }
  if (await addCookieRules(details.tabId, details.url)) {
    chrome.scripting
      .executeScript({
        target: { tabId: details.tabId, frameIds: [details.frameId] },
        func: () => location.reload(),
      })
      .catch(() => {});
  }
}

// The peek frame is the subframe whose first navigation goes to the peeked URL (it sits inside
// the extension's peek/frame.html, so its id isn't known when the peek opens).
chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId === TOP_FRAME_ID) {
    return;
  }
  await updatePeek(details.tabId, (peek) =>
    peek.frameId === null && details.url === peek.url ? { ...peek, frameId: details.frameId } : peek,
  );
});

chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== TOP_FRAME_ID) {
    await onFrameUrlChanged(details);
    await reloadWithCookiesIfNeeded(details);
    return;
  }
  // The host page itself navigated: its content script and the peek are gone.
  if (await getPeek(details.tabId)) {
    await endPeek(details.tabId);
  }
});
chrome.webNavigation.onHistoryStateUpdated.addListener(onFrameUrlChanged);
chrome.webNavigation.onReferenceFragmentUpdated.addListener(onFrameUrlChanged);

chrome.webNavigation.onDOMContentLoaded.addListener(async (details) => {
  const peek = await getPeek(details.tabId);
  if (!peek || details.frameId !== peek.frameId) {
    return;
  }
  chrome.scripting
    .executeScript({
      target: { tabId: details.tabId, frameIds: [details.frameId] },
      func: installEscapeBridge,
    })
    .catch(() => {});
});
