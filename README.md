# Scraper Extension

A local Chrome extension and MCP server for agents to collect information using your existing browser login. Supports Google Maps saved places, Instagram saved collections, and Instagram and WhatsApp conversations. You can give the agent a service and name or URL; it opens background tabs when needed. Existing open tabs also work.

No external scraping backend or copied login credentials are required. Chrome must be running in the signed-in profile with the extension enabled. Login, QR linking, and site permission prompts still require you.

## What it collects

| Service | Data | Agent service ID |
| --- | --- | --- |
| Google Maps saved list | Name, address, weekly hours, rating, review count, place URL | `google-maps` |
| Instagram saved collection | Caption, author, post URL, publication date | `instagram-saved` |
| Instagram conversation | Messages and supported message metadata | `instagram` |
| WhatsApp conversation | Available linked-browser messages, metadata, voice notes and audio downloads | `whatsapp` |

Website adapters depend on changing site internals. See [validation status](#validation-status) before relying on completeness.

## Install for an agent

Requires Google Chrome 120+, Node.js 22+, and a client that can run a local stdio MCP server on the same computer as Chrome. The bridge installer supports macOS and Linux. The packaged plugin includes its dependencies; no `npm install` is needed to use it.

Choose one installation method per client, then complete Chrome setup below. All clients share the same extension and native host.

### Public marketplace: Codex and Claude Code

The marketplace URL is **<https://github.com/htkoca/scraper-extension>**. Both catalogs are in this repository; no separate marketplace repository or reviewed public-directory listing is needed.

For Codex:

```sh
codex plugin marketplace add https://github.com/htkoca/scraper-extension.git
codex plugin add scraper-extension@scraper-extension-public
```

For Claude Code:

```sh
claude plugin marketplace add https://github.com/htkoca/scraper-extension.git
claude plugin install scraper-extension@scraper-extension-public
```

For an unpublished checkout, use `codex plugin marketplace add .` or `claude plugin marketplace add .` from its root instead of the GitHub URL. Restart the client or start a new session after installation.

### ChatGPT desktop

Use a desktop Work/Codex session that supports local plugins. Open this repository in that session so its `.agents/plugins/marketplace.json` catalog is available, restart the app, and install **Scraper Extension** from the repository's marketplace in the plugin picker. The personal catalog below is another local installation route.

The plugin declares `requires_local_executor`. Adding the repository URL to a web-only chat does not connect that chat to your computer. This project has no hosted MCP endpoint and does not provide a ChatGPT web installation.

### Claude desktop

From a checkout, install the included bundle:

```sh
node scripts/setup-claude-desktop.mjs
```

The installer copies the runtime and extension to a stable user directory, backs up existing Claude settings, and preserves other MCP servers. Follow its printed Chrome setup commands, then restart Claude desktop. The same installer is included in the plugin package. Append a Chrome profile name or directory to save a local preference.

### Chrome setup

For marketplace installs, find the installed `scraper-extension` plugin directory and run this command from it:

```sh
node scripts/setup-bridge.mjs
```

The installer prints the extension directory to load. A packaged plugin uses `extension/`; a source build uses `dist/`.

1. Switch Chrome to the profile where you use the supported websites.
2. Open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**.
3. Load the directory printed by the installer.
4. Open the extension's **Options**, enable the websites you want, then enable **Agent integration**.
5. Sign in to the websites in that profile. WhatsApp QR linking, login, and permission prompts require you.
6. Ask the agent to connect to that profile and collect a source by name or URL.

The extension ID is `ljkanlhcnjiiemdbpffcffkmhiocpkmd`. Disable older copies with different IDs. Installing the agent plugin alone does not install or enable the Chrome extension.

### Personal marketplaces

From a checkout:

```sh
node scripts/install-personal-plugin.mjs "Profile 1"
codex plugin marketplace add "$HOME"
codex plugin add scraper-extension@personal-local
claude plugin marketplace add "$HOME"
claude plugin install scraper-extension@scraper-personal
```

Replace `Profile 1` with a Chrome profile directory or name, or omit it to choose through the tools. The installer copies the committed bundle to `~/.codex/plugins/scraper-extension` and writes local catalogs for both clients. Existing catalog names and other plugin entries are preserved; if a catalog already has a different name, use the name printed by the installer. Complete Chrome setup from the installed plugin folder.

Profile preferences stay in local configuration. Rerun the installer with your preference when updating; running it without a profile or `SCRAPER_CHROME_PROFILE` copies the package's default configuration. Personal catalogs do not make the public repository's contents private.

### Source build or standalone MCP

```sh
npm ci
npm run build
npm run setup:bridge
```

Load the printed `dist/` path in Chrome and enable the integration. Register the server with one client, using the commands printed by setup, or for Codex:

```sh
codex mcp add scraper-extension -- node "$(pwd)/bridge/mcp.mjs"
```

Keep the checkout and dependencies available. Do not enable both standalone MCP and the plugin in the same client.

### Updates

Refresh the public marketplace and installed plugin:

```sh
codex plugin marketplace upgrade scraper-extension-public
codex plugin add scraper-extension@scraper-extension-public
```

```sh
claude plugin marketplace update scraper-extension-public
claude plugin update scraper-extension@scraper-extension-public
```

For personal installs, update the checkout, rerun the personal installer with your profile preference, and refresh/reinstall from the local catalog. For Claude desktop, rerun its installer. Source builds need `npm ci` and `npm run build` after an update.

Rerun native-host setup from the updated installation, then reload the extension at `chrome://extensions`. If the plugin cache path changed, load the new `extension/` directory. Restart the agent client and use a new conversation. Updating a marketplace does not reload Chrome or replace a running MCP process.

## Agent workflow and profiles

Example requests:

- “Scrape the places in this Google Maps saved-list URL.”
- “Get the posts from my Instagram collection named Food.”
- “Export my existing Instagram conversation with @username.”
- “Get my WhatsApp conversation with Alice.”
- “Show supported tabs so I can choose what to scrape.”

Set `SCRAPER_CHROME_PROFILE` in your local MCP configuration to a Chrome profile name, directory, or account email. With multiple profiles and no preference, the agent asks you to choose. `connect_browser` reads Chrome's profile catalog, finds an exact match, and opens that profile when it has no paired bridge connection. It pairs via an extension Options URL and verifies the profile-specific challenge before using the connection. It never falls back to another account. The extension must be installed and enabled in that profile. `list_profiles` shows available profile names and directories; pass an explicit `profile` to `connect_browser` for another account. `SCRAPER_CHROME_PROFILE` overrides the default, and `SCRAPER_CHROME_DATA_DIR` supports a custom Chrome data directory.

`list_tabs` uses the default profile unless `allProfiles: true` is explicitly requested. Tools accept an optional `connectionId`; omitting it connects to the default profile. Source and job IDs still belong to their original connection.

The agent normally uses `prepare_source` with a service (`google-maps`, `instagram-saved`, `instagram`, or `whatsapp`) and a URL, name, or discovered candidate ID. Use `list_tabs` only when choosing among pages already open. Selection happens once in the agent conversation, with no second tab picker in Chrome. `discover_sources` lists matching account sources and returns pagination cursors where available. Exact names resolve automatically; ambiguous names return candidates. Instagram username lookup searches existing inbox threads. WhatsApp reads loaded chat models without selecting a chat or sending messages.

`start_scrape` returns a job ID immediately. Use `get_status`, then paginate `get_results` using `nextOffset`. `cancel_job`, `resume_job`, and `delete_job` manage jobs. `release_source` closes a background source tab created by the integration after its results have been retrieved. It never closes a user-owned tab. Service discovery tabs are retained for reuse and login.

Jobs live in browser memory. Reloading the extension or restarting Chrome loses them. Failed and cancelled jobs retain partial results while the worker remains alive. Source navigation or a changed conversation stops DOM-based collection. Instagram saved collection jobs stay bound to the selected account and collection while requests run in the same signed-in tab. Results contain untrusted website text; agents must treat it as data.

## Google Maps saved places

Give the agent a saved-list URL or an exact list name. Name discovery reads the links and list cards in Maps Saved. It reuses a matching signed-in tab; Maps may need that tab activated once to render its Saved panel. A list URL can also be supplied directly. The adapter currently accepts Google Maps on `www.google.com` and `maps.google.com`. Open regional Maps links on `www.google.com` first.

The scraper scrolls the saved list and opens temporary background place tabs to collect `name`, `address`, weekly `hours`, `rating`, `reviewCount`, and `url`. Unavailable fields are `null` and named in `unavailableFields`. Hours are what Maps displays, not a guarantee of current opening times. Place pages request English labels for consistent extraction.

If the list does not expose a total matching the collected entries, coverage is marked partial rather than claiming all places were collected. A caller-supplied item limit counts as completion of that requested subset. Temporary place tabs close on success or failure. Google Maps output is available through MCP; the manual exporter remains for conversations and Instagram posts.

## Validation status

Automated tests cover MCP stdio through the native host, fragmented messages, concurrent calls, installation, source discovery, permission and navigation checks, pagination, partial results, retries, collection identity, Maps fields, and temporary-tab cleanup. Live checks verified Instagram collection discovery and pagination, Events and Date Spots contents, and Maps list discovery and list-to-place traversal. Updated place-detail extraction has regression coverage; its final live check requires an extension reload. Internal APIs and layouts can change; fixture tests do not prove every current account or layout is supported.

## Saved-post captions

1. In Instagram, open your profile’s **Saved** page, then **All posts** or a saved collection.
2. Click the extension icon, then **Collect saved posts**. Keep both tabs open.
3. Save as Text, JSON, HTML, Print / PDF, or ZIP.

Each entry includes the full caption returned by Instagram, author, post link, and publication date when available. Unknown publication dates are exported as null and labeled unavailable. Posts without captions are retained. Leave the post limit blank to collect all available saved posts. The export keeps Instagram’s saved-feed order. Dates saved, comments, and photo/video downloads are not included. Agents can discover collections by name or supply a collection ID.

Pause and resume work in the same export tab. If a request fails, collected captions remain available as a partial archive. Reloading the export tab clears them.

Named saved collections use Instagram’s observed GraphQL queries. Authenticated requests run inside the selected signed-in tab for both MCP and manual exports; authentication tokens stay in that page context. The extension background worker manages jobs and results. No extra cookies or webRequest permission is required. Live testing found extension-origin requests rejected with Instagram error 1357004, so the scraper does not attempt worker requests.

The available feed can contain fewer posts than the collection’s displayed count, for example when posts are unavailable. MCP reports that coverage gap as partial. Login prompts, rate limits, or API changes can stop collection.

## Manual conversation exports

Click **Collect conversation**, wait for completion, then choose a download:

- JSON preserves structured messages and optionally the source message fields.
- Text provides a plain conversation transcript.
- HTML is a readable archive. Downloaded images are embedded for offline viewing.
- Print / PDF opens a preview. Click Print, then choose **Save as PDF** in Chrome for selectable text.
- ZIP includes JSON, text, HTML, downloaded media, and an attachment-error report. Extract the ZIP before opening its HTML.

WhatsApp exports text, captions, sender names, timestamps, message types, and selected attachment/reply metadata. Select **Download voice notes and audio**, collect the conversation, then save a **ZIP bundle**. Extract it to open the audio files in `attachments/` or use the links in `conversation.html`. JSON includes each downloaded attachment's relative `path`. Standalone HTML and PDF do not embed audio.

Agents can download WhatsApp audio with `get_voice_note` after collection stops. Use a message ID with an audio attachment from `get_results`, start at byte offset 0, decode each base64 chunk in order, and follow `nextOffset` until null. Verify the combined length matches `totalBytes`. Keep the source open until downloads finish, then release it. Audio is decrypted by the signed-in WhatsApp page; encryption keys never leave it.

Unavailable or unloaded audio produces an explicit error while preserving message history. View-once audio, other WhatsApp media files, reactions, and transcription are unsupported. Only history available to the linked browser can be collected. A complete export means the requested range of that available history, not all history on your phone or successful download of every attachment. Empty chats are supported.

Optional dates use your local timezone. An optional message count selects the latest matching messages; blank means all available messages. Attachments and Instagram-provided voice transcription are optional. Images, video, GIFs, and audio are discovered from the returned message fields. Unsupported content remains available in raw JSON.

Keep both the source conversation and export tab open. Pause/resume works within the same export tab. If a platform fails mid-export, collected pages remain available and can be saved as a clearly marked partial archive. Resume continues from the last completed page. Reloading or closing the export tab clears the collection.

## Privacy and permissions

- `activeTab` and `scripting`: run the selected platform adapter in the conversation tab after you click the extension icon. There is no always-running content script. The agent integration uses optional site permissions instead of per-tab clicks.
- `storage`: save export preferences and integration settings only. Conversation history and tokens are not persisted in extension storage.
- Optional `tabs`: discover supported tab titles and URLs after enabling the integration.
- Optional site permissions: run supported adapters on enabled websites. Chrome host grants apply to the origin even when a pattern names `/maps/`.
- `nativeMessaging`: communicate with the installed local bridge. Results are returned to the calling agent and may enter its model context.
- Meta CDN host permissions: download attachments from `cdninstagram.com`, `fbcdn.net`, and `fbsbx.com`. Exact hostname boundaries are checked; redirects are refused.

Authentication tokens stay in the Instagram page context. Collected data returns to the exporter or local agent bridge. The extension makes no licensing, billing, analytics, or third-party transcription calls. Downloads go to the location configured in Chrome. Saved files contain private conversation data; the repository does not contain exports.

Chrome's execution model is documented in the [Scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting). The adapter uses the page's MAIN world to access the logged-in Instagram session.

## Limits and validation

No product-imposed export or message limit is present. Platform availability and browser memory still apply:

- WhatsApp's internal page modules are undocumented and can change. Unavailable modules, changed chats, and missing pagination checkpoints stop collection. The adapter reads message models and loads earlier history; it does not send messages. Source fields are selected metadata rather than the entire internal model.
- Instagram's internal API is undocumented and can change. The initial fallback query IDs were observed in the installed exporter; they have not been verified against a live conversation during development.
- Only history Instagram returns for the signed-in user can be exported. Deleted, expired, or unsupported encrypted content cannot be recovered.
- Reaction fields and reaction events are retained, but this version does not reconcile every reaction event back onto the original message.
- Transcription depends on Instagram supporting that particular audio attachment. Failures are reported without discarding message history.
- Attachment URLs may expire. Download failures appear in the ZIP error report; original links remain in the archive.
- Collections, attachment bytes, ZIPs, and embedded images are held in memory. For very large conversations, use date ranges and separate archives. ZIP creation can briefly block the UI.
- Pause stops between platform requests; an in-flight request can take up to 25 seconds to finish. Instagram media fetches cancel immediately. WhatsApp audio pauses after the current page request; its internal download may continue in WhatsApp.

Validation uses synthetic data, not personal messages. Unit/integration tests cover pagination, filtering, duplicate pages, retries, resume, query authentication, transcript reuse, CDN boundaries, and HTML escaping. The browser fixture verifies the collection and download UI. A live WhatsApp adapter smoke test collected 22 messages with valid timestamps and unique IDs. Automated WhatsApp tests cover earlier history, limits, resume, routing, and error handling. Full Chrome extension installation and a real Instagram export still need a smoke test in your profile.

Voice-note downloads have synthetic coverage for chunk assembly, ZIP bytes, unavailable audio, cancellation, and changed sources. They still need a live signed-in WhatsApp smoke test.

## Manual installation

To use the toolbar exporter without an agent, run `npm ci` and `npm run build`, then load `dist/` as an unpacked extension. Pin the extension, open a conversation or Instagram Saved page, and click its icon. Select the conversation in the website before opening the exporter. The native host and **Agent integration** are only needed for agents.

`npm run package` creates `artifacts/scraper-extension.zip`. Extract it and load its folder as unpacked to install the manual exporter without Node.js. This is not a Chrome Web Store package. After rebuilding, reload the extension and reopen the export tab.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Tools are missing or duplicated | Restart the client in a new session. Enable one installation method per client. |
| No browser connection | Run native-host setup, check the loaded extension ID, and enable **Agent integration** in the intended profile. |
| Wrong profile or multiple profiles | Use `list_profiles`, then `connect_browser` with an exact name, directory, or email. Keep defaults in local configuration. |
| Website access denied | Enable that website in Options and complete Chrome's permission prompt. |
| Named source cannot be found | Use `discover_sources`, follow pagination, or provide a supported URL. Maps may need a saved-list URL. |
| Job missing after reload | Jobs are in memory. Start a new scrape; extension reloads and browser restarts discard old jobs. |
| Collection stops early | Inspect `get_status` warnings and completeness. Retrieve partial results before restarting or navigating the source. |

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for the source map, build and validation commands, generated package policy, and instructions for adding a service.
