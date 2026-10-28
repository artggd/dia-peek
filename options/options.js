const { DEFAULT_SETTINGS, siteFromInput } = PeekShared;
const STATUS_VISIBLE_MS = 1200;

for (const element of document.querySelectorAll('[data-i18n]')) {
  element.textContent = chrome.i18n.getMessage(element.dataset.i18n);
}
for (const element of document.querySelectorAll('[data-i18n-placeholder]')) {
  element.placeholder = chrome.i18n.getMessage(element.dataset.i18nPlaceholder);
}

const form = document.querySelector('form');
const siteInput = form.elements.site;
const list = document.querySelector('ul');
const emptyMessage = document.querySelector('.empty');
const statusElement = document.querySelector('.status');
let statusTimer = null;

function showStatus(messageName) {
  statusElement.textContent = chrome.i18n.getMessage(messageName);
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    statusElement.textContent = '';
  }, STATUS_VISIBLE_MS);
}

async function getPeekSites() {
  const { peekSites } = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return peekSites;
}

async function savePeekSites(peekSites) {
  await chrome.storage.sync.set({ peekSites });
  showStatus('optionsSaved');
}

function render(peekSites) {
  list.replaceChildren(
    ...peekSites.map((site) => {
      const item = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = site;
      const removeButton = document.createElement('button');
      removeButton.type = 'button';
      removeButton.textContent = chrome.i18n.getMessage('optionsRemoveSite');
      removeButton.addEventListener('click', async () => {
        const current = await getPeekSites();
        await savePeekSites(current.filter((peekSite) => peekSite !== site));
      });
      item.append(name, removeButton);
      return item;
    }),
  );
  emptyMessage.hidden = peekSites.length > 0;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const site = siteFromInput(siteInput.value);
  if (site === null) {
    showStatus('optionsInvalidSite');
    return;
  }
  const current = await getPeekSites();
  if (!current.includes(site)) {
    await savePeekSites([...current, site].sort());
  }
  siteInput.value = '';
});

// Also picks up sites turned on or off with the toolbar button while this page is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.peekSites) {
    render(changes.peekSites.newValue ?? DEFAULT_SETTINGS.peekSites);
  }
});

getPeekSites().then(render);
