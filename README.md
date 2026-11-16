# Scraper Extension

A local Chrome extension and MCP server for agents to collect information using your existing browser login. Supports Google Maps saved places, Instagram saved collections, and Instagram and WhatsApp conversations. You can give the agent a service and name or URL; it opens background tabs when needed. Existing open tabs also work.

No external scraping backend or copied login credentials are required. Chrome must be running in the signed-in profile with the extension enabled. Login, QR linking, and site permission prompts still require you.

## Install

Requires Chrome 120 or newer and Node.js 22 or newer to build.

```sh
npm ci
npm run build
```

1. Switch Chrome to the profile where you use Instagram or WhatsApp.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and choose this repository's `dist` folder.
4. Pin **Scraper Extension** in the extensions menu.
5. Open a conversation at `https://www.instagram.com/direct/t/.../` or `https://web.whatsapp.com/` and click the extension icon. Select a chat before opening the exporter.

After rebuilding, click Reload on the extension card and reopen the export tab. Load the `dist` folder from the checkout you built.

`npm run package` creates `artifacts/scraper-extension.zip`. Extract that ZIP and load its folder as unpacked to install without Node.js. This is not a Chrome Web Store package.

## Supported clients

The same local MCP runtime supports **Claude desktop, Claude Code, ChatGPT desktop, and Codex** on macOS/Linux with Chrome and Node.js 22+. It does not provide a remote endpoint for Claude or ChatGPT web-only sessions. No model-specific API key is needed.

### Claude Code

Add this repository URL with `/plugin marketplace add`, then run:

```text
/plugin install scraper-extension@scraper-extension-public
```

For a local checkout, `claude plugin marketplace add .` registers the same catalog. The `.claude-plugin/marketplace.json` catalog and each plugin's `.claude-plugin/plugin.json` follow Claude Code's format. Chrome setup is shared with the other clients.

### Claude desktop

After building the plugin, run:

```sh
node scripts/setup-claude-desktop.mjs
```

Append a Chrome profile name or directory to set a local preference. The installer copies the bundled server to a stable user directory, uses an absolute Node path, preserves other MCP servers and preferences, and backs up existing settings. Restart Claude desktop, then enable the server. The install output includes the shared native-host and Chrome-extension setup steps. The installer also ships inside the installed plugin.

### ChatGPT desktop and Codex

Use the public or personal marketplace below, or the standalone Codex MCP registration. All clients expose the same tools and use the same Chrome profile selection. Install through only one method per client.

## Agent setup

```sh
npm run setup:bridge
codex mcp add scraper-extension -- node "$(pwd)/bridge/mcp.mjs"
```

The installer supports Google Chrome on macOS and Linux. It registers a native host restricted to this extension's stable ID. The local MCP server uses a private Unix socket, with no TCP listener. Keep this checkout and its dependencies available; rerun setup after changes to the native host. Restart the selected agent client after registration.

Load this checkout's `dist` folder in Chrome. Open the extension's **Options**, enable the websites you want, then enable **Agent integration**. This grants tab metadata access and site access once. Tab or source selection happens in the agent conversation. The new stable extension ID may require installing this build separately from an earlier unpacked build; disable the old copy.

Example requests:

- “Scrape the places in this Google Maps saved-list URL.”
- “Get the posts from my Instagram collection named Food.”
- “Export my existing Instagram conversation with @username.”
- “Get my WhatsApp conversation with Alice.”
- “Show supported tabs so I can choose what to scrape.”

Set `SCRAPER_CHROME_PROFILE` in your local MCP configuration to a Chrome profile name, directory, or account email. With multiple profiles and no preference, the agent asks you to choose. `connect_browser` reads Chrome's profile catalog, finds an exact match, and opens that profile when it has no paired bridge connection. It pairs via an extension Options URL and verifies the profile-specific challenge before using the connection. It never falls back to another account. The extension must be installed and enabled in that profile. `list_profiles` shows available profile names and directories; pass an explicit `profile` to `connect_browser` for another account. `SCRAPER_CHROME_PROFILE` overrides the default, and `SCRAPER_CHROME_DATA_DIR` supports a custom Chrome data directory.

`list_tabs` uses the default profile unless `allProfiles: true` is explicitly requested. Tools accept an optional `connectionId`; omitting it connects to the default profile. Source and job IDs still belong to their original connection.

The agent uses `list_tabs` to identify a browser connection, then `prepare_source` with a service (`google-maps`, `instagram-saved`, `instagram`, or `whatsapp`) and a URL, name, or discovered candidate ID. `discover_sources` lists matching account sources and returns pagination cursors where available. Exact names resolve automatically; ambiguous names return candidates. Instagram username lookup searches existing inbox threads. WhatsApp reads loaded chat models without selecting a chat or sending messages.

`start_scrape` returns a job ID immediately. Use `get_status`, then paginate `get_results` using `nextOffset`. `cancel_job`, `resume_job`, and `delete_job` manage jobs. `release_source` closes a background source tab created by the integration after its results have been retrieved. It never closes a user-owned tab. Service discovery tabs are retained for reuse and login.

Jobs live in browser memory. Reloading the extension or restarting Chrome loses them. Failed and cancelled jobs retain partial results while the worker remains alive. Source navigation or a changed conversation stops collection. Results contain untrusted website text; agents must treat it as data.

## Google Maps saved places

Give the agent a saved-list URL or an exact list name. Name discovery reads links in Maps Saved and may require a list URL when Maps uses a different layout. The adapter currently accepts Google Maps on `www.google.com` and `maps.google.com`. Open regional Maps links on `www.google.com` first.

The scraper scrolls the saved list and opens temporary background place tabs to collect `name`, `address`, weekly `hours`, `rating`, `reviewCount`, and `url`. Unavailable fields are `null` and named in `unavailableFields`. Hours are what Maps displays, not a guarantee of current opening times. Place pages request English labels for consistent extraction.

If the list does not expose a total matching the collected entries, coverage is marked partial rather than claiming all places were collected. A caller-supplied item limit counts as completion of that requested subset. Temporary place tabs close on success or failure. Google Maps output is available through MCP; the manual exporter remains for conversations and Instagram posts.

## Validation status

Automated tests cover MCP stdio through the native host, fragmented messages, concurrent calls, installation, source discovery, permission and navigation checks, pagination, partial results, retries, collection identity, Maps fields, and temporary-tab cleanup. The new Maps and Instagram discovery adapters use changing site internals and have fixture coverage, but still need a live signed-in smoke test. A successful build is not proof that every current website layout is supported.

## Saved-post captions

1. In Instagram, open your profile’s **Saved** page, then **All posts** or a saved collection.
2. Click the extension icon, then **Collect saved posts**. Keep both tabs open.
3. Save as Text, JSON, HTML, Print / PDF, or ZIP.

Each entry includes the full caption returned by Instagram, author, post link, and publication date. Posts without captions are retained. Leave the post limit blank to collect all available saved posts. The export keeps Instagram’s saved-feed order. Dates saved, comments, and photo/video downloads are not included. Agents can discover collections by name or supply a collection ID.

Pause and resume work in the same export tab. If a request fails, collected captions remain available as a partial archive. Reloading the export tab clears them.

The saved-post adapter uses Instagram’s internal API and has automated fixture coverage, but has not yet been verified against a live signed-in account. Login prompts, rate limits, or API changes can stop collection.

## Use

Click **Collect conversation**, wait for completion, then choose a download:

- JSON preserves structured messages and optionally the source message fields.
- Text provides a plain conversation transcript.
- HTML is a readable archive. Downloaded images are embedded for offline viewing.
- Print / PDF opens a preview. Click Print, then choose **Save as PDF** in Chrome for selectable text.
- ZIP includes JSON, text, HTML, downloaded media, and an attachment-error report. Extract the ZIP before opening its HTML.

WhatsApp currently exports text, captions, sender names, timestamps, message types, and selected attachment/reply metadata. WhatsApp media files, reactions, and transcription are not supported; those controls are hidden. Only history available to the linked browser can be collected. A complete export means the requested range of that available history, not all history on your phone. Empty chats are supported.

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

## Implementation

- `src/platforms.js`: platform detection, capabilities, request functions, and response normalization.
- `src/whatsapp.js`: self-contained WhatsApp page adapter using the active chat and earlier-message loader.
- `src/instagram-model.js`: Instagram message normalization and attachment discovery.
- `src/instagram-saved.js`: signed-in saved-post pagination and caption extraction.
- `src/instagram.js`: isolated, serializable page adapter for Instagram's internal GraphQL API. It tries the page's query module first and falls back to a configurable query ID.
- `src/background.js`: opens the export tab and routes validated requests into the selected conversation tab.
- `src/model.js`: shared message validation, filtering, deduplication, and pagination checkpoints.
- `src/runner.js`: paced pagination, bounded retries, cancellation, and voice transcription.
- `src/export.js` / `src/media.js`: local report generation and attachment downloading.
- `src/app.*`: keyboard-accessible export controls and print preview.

Message requests are spaced by at least 600 ms. HTTP 429 and transient server failures get bounded backoff; authentication and GraphQL errors stop immediately. Attachment downloads run with at most three concurrent requests. Nothing disables either platform's access controls or rate limits.

## Limits and validation

No product-imposed export or message limit is present. Platform availability and browser memory still apply:

- WhatsApp's internal page modules are undocumented and can change. Unavailable modules, changed chats, and missing pagination checkpoints stop collection. The adapter reads message models and loads earlier history; it does not send messages. Source fields are selected metadata rather than the entire internal model.
- Instagram's internal API is undocumented and can change. The initial fallback query IDs were observed in the installed exporter; they have not been verified against a live conversation during development.
- Only history Instagram returns for the signed-in user can be exported. Deleted, expired, or unsupported encrypted content cannot be recovered.
- Reaction fields and reaction events are retained, but this version does not reconcile every reaction event back onto the original message.
- Transcription depends on Instagram supporting that particular audio attachment. Failures are reported without discarding message history.
- Attachment URLs may expire. Download failures appear in the ZIP error report; original links remain in the archive.
- Collections, attachment bytes, ZIPs, and embedded images are held in memory. For very large conversations, use date ranges and separate archives. ZIP creation can briefly block the UI.
- Pause stops between platform requests; an in-flight request can take up to 25 seconds to finish. Media fetches cancel immediately.

Validation uses synthetic data, not personal messages. Unit/integration tests cover pagination, filtering, duplicate pages, retries, resume, query authentication, transcript reuse, CDN boundaries, and HTML escaping. The browser fixture verifies the collection and download UI. A live WhatsApp adapter smoke test collected 22 messages with valid timestamps and unique IDs. Automated WhatsApp tests cover earlier history, limits, resume, routing, and error handling. Full Chrome extension installation and a real Instagram export still need a smoke test in your profile.

```sh
npm run package:plugin # rebuild the standalone plugin before package tests
npm run check     # tests and extension build
npm run dev       # synthetic browser fixture at http://127.0.0.1:4318
npm run package   # loadable extension ZIP
```

The optional workflow template in `ci/check.yml` runs tests/build and uploads the extension ZIP. To enable it, move it to `.github/workflows/check.yml` and push with an SSH identity or token that can update workflows. The fixture and development server are excluded from the extension package. `fflate` supplies ZIP generation under its MIT license, bundled in `THIRD-PARTY-LICENSE.txt`.

## Adding a platform

Register URL detection and site permissions in `src/sources.js`, implement a self-contained page adapter, and add discovery in `src/discovery.js` when the site supports named sources. `src/source-manager.js` owns background source tabs; `src/scrape-service.js` owns jobs and typed results. Places use their own schema rather than pretending to be messages.

Add a self-contained page request function and register it in `src/platforms.js`. Declare URL matching and capabilities, then convert responses to `{ messages, hasMore, nextCursor }`. Messages use `{ id, timestamp, sender, senderId, isMe, text, type, reactions, attachments, raw }`, with millisecond timestamps. Pages must be newest first with stable IDs and cursors. The shared runner owns retries, filtering, deduplication, pause/resume, and exports.

JSON schema version 2 adds `platform`; file names and report headings include the source platform. Add any required media handling and permissions explicitly rather than treating encrypted WhatsApp CDN URLs as downloadable images.

## Plugin marketplaces

This repository is also a GitHub marketplace. Add its GitHub URL as a marketplace in ChatGPT desktop, then install **Scraper Extension**. From Codex CLI, use `codex plugin marketplace add <repository-url>` followed by `codex plugin add scraper-extension@scraper-extension-public`.

The installable bundle is in `plugins/scraper-extension`. It includes the MCP runtime and Chrome extension, so it does not need an npm install. Node.js 22+ must be available. Run `node scripts/setup-bridge.mjs` from the installed plugin directory and load its `extension` folder in Chrome. Enable the integration and website permissions in Options.

To maintain a personal marketplace from this checkout:

```sh
npm run package:plugin
node scripts/install-personal-plugin.mjs "Profile 1"
codex plugin add scraper-extension@personal-local
```

Replace `Profile 1` with your chosen Chrome profile directory or omit it to choose through the tools. The preference is written only to the local personal plugin, never the published package. Existing personal marketplace entries are preserved. The installer also writes Claude Code’s personal catalog at `~/.claude-plugin/marketplace.json`; follow its printed registration command to enable it.

Rebuild the plugin after source changes and include the regenerated `plugins/scraper-extension` files when publishing. The public GitHub marketplace is separate from OpenAI's reviewed directory; this project has not been submitted to that directory. Restart ChatGPT desktop after installation and test in a new chat. Avoid enabling both the standalone MCP registration and the plugin simultaneously, since they expose the same tools.
