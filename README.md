# Conversation Archive

A private, personal Chrome extension for exporting your Instagram and WhatsApp conversations. No quotas, licensing checks, billing, analytics, or developer backend. Independently implemented from observed Instagram API behavior; no code or assets from IG DM Exporter are included.

## Install

Requires Chrome 120 or newer and Node.js 22 or newer to build.

```sh
npm ci
npm run build
```

1. Switch Chrome to the profile where you use Instagram or WhatsApp.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and choose this repository's `dist` folder.
4. Pin **Conversation Archive** in the extensions menu.
5. Open a conversation at `https://www.instagram.com/direct/t/.../` or `https://web.whatsapp.com/` and click the extension icon. Select a chat before opening the exporter.

After rebuilding, click Reload on the extension card and reopen the export tab. Load the `dist` folder from the checkout you built.

`npm run package` creates `artifacts/ig-dm-archive.zip`. Extract that ZIP and load its folder as unpacked to install without Node.js. This is not a Chrome Web Store package.

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

- `activeTab` and `scripting`: run the selected platform adapter in the conversation tab after you click the extension icon. There is no always-running content script. No new host permissions are needed for WhatsApp.
- `storage`: save export preferences only. Conversation history and tokens are not persisted in extension storage.
- Meta CDN host permissions: download attachments from `cdninstagram.com`, `fbcdn.net`, and `fbsbx.com`. Exact hostname boundaries are checked; redirects are refused.

Authentication tokens stay in the Instagram page context. Only conversation data and, for Instagram, your viewer ID return to the export tab. The extension makes no licensing, billing, analytics, or third-party transcription calls. Downloads go to the location configured in Chrome. Saved files contain private conversation data; the repository does not contain exports.

Chrome's execution model is documented in the [Scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting). The adapter uses the page's MAIN world to access the logged-in Instagram session.

## Implementation

- `src/platforms.js`: platform detection, capabilities, request functions, and response normalization.
- `src/whatsapp.js`: self-contained WhatsApp page adapter using the active chat and earlier-message loader.
- `src/instagram-model.js`: Instagram message normalization and attachment discovery.
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
npm run check     # tests and extension build
npm run dev       # synthetic browser fixture at http://127.0.0.1:4318
npm run package   # loadable extension ZIP
```

The optional workflow template in `ci/check.yml` runs tests/build and uploads the extension ZIP. To enable it, move it to `.github/workflows/check.yml` and push with an SSH identity or token that can update workflows. The fixture and development server are excluded from the extension package. `fflate` supplies ZIP generation under its MIT license, bundled in `THIRD-PARTY-LICENSE.txt`.

## Adding a platform

Add a self-contained page request function and register it in `src/platforms.js`. Declare URL matching and capabilities, then convert responses to `{ messages, hasMore, nextCursor }`. Messages use `{ id, timestamp, sender, senderId, isMe, text, type, reactions, attachments, raw }`, with millisecond timestamps. Pages must be newest first with stable IDs and cursors. The shared runner owns retries, filtering, deduplication, pause/resume, and exports.

JSON schema version 2 adds `platform`; file names and report headings include the source platform. Add any required media handling and permissions explicitly rather than treating encrypted WhatsApp CDN URLs as downloadable images.
