// Hosts the peeked page inside the card. The card embeds this extension page rather than the
// peeked page itself: the host page's Content-Security-Policy may forbid embedding other sites
// (GitHub's does), and pages served by the extension are exempt from it.

// Lets the peeked page run scripts and use its own storage, but never navigate the host tab
// (frame-busting scripts would otherwise replace the host page).
const PEEK_SANDBOX = [
  'allow-scripts',
  'allow-same-origin',
  'allow-forms',
  'allow-popups',
  'allow-popups-to-escape-sandbox',
  'allow-modals',
  'allow-downloads',
  'allow-presentation',
  'allow-storage-access-by-user-activation',
].join(' ');

const url = new URLSearchParams(location.search).get('url') ?? '';

// Only web pages: this page must never be turned into a way to run javascript: URLs.
if (PeekShared.siteFromUrl(url) !== null) {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', PEEK_SANDBOX);
  iframe.setAttribute('allow', PeekShared.PEEK_FRAME_ALLOW);
  iframe.src = url;
  document.body.append(iframe);
}
