# Peek for Dia

Opens links in a floating card over the current page, like Peek in Arc.

## Install

1. Open Dia's extensions page (`chrome://extensions` in the address bar).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and pick this `dia-peek` folder.
4. Reload any tabs that were already open.

## Use

- Turn Peek on for a site (e.g. Slack) with the extension's **toolbar button**: it shows **On** on that site's tabs. Click it again to turn it off.
- On those sites, clicking a link to **another site** opens it in Peek. Links within the site, and clicks with Cmd, Shift, Option or Ctrl held down, behave normally.
- The full list of sites can be viewed and edited in the extension's options.
- Close with **Esc**, a click outside the card, or the × button.
- **Open as tab** turns the peeked page into a normal tab next to the current one.
- **Copy link** copies the address of the page shown in the card.
- The browser's Back/Forward shortcuts move inside the card while it is open.

## Known limits

- **Logins:** browsers don't send login cookies to a page embedded in another site. So while a card is open, the extension reads your cookies for the site shown in the card and attaches them to that page's requests, for that tab only. Logging in or out *inside* the card doesn't stick: do it in a normal tab. Following a link in the card to another site you're logged into reloads that page once to pick up its cookies.
- **Security headers:** to let a page show in the card, the extension removes its "don't embed me" headers (`X-Frame-Options`, `Content-Security-Policy`). This only applies to the card, and only while it is open.
- **Pinned tabs:** Dia doesn't tell extensions which tabs are pinned, which is why Peek works per site instead.
- **Sites are whole domains:** turning Peek on for `mail.google.com` turns it on for every `google.com` page, and links between `google.com` pages (Gmail to Docs, for example) count as the same site.
- **Browser pages:** Peek doesn't run on browser pages (`chrome://`, the extension store) or in links inside embedded frames.
