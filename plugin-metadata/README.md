# Scraper Extension

Local MCP tools for Google Maps saved-list entries, Instagram saved collections, and Instagram and WhatsApp conversations. Agents can resolve a service and source by name or URL, open background tabs, or collect from a tab you choose in the agent conversation.

Requires Node.js 22+, Google Chrome 120+, and a client with local MCP execution on the same computer. The bridge installer supports macOS and Linux. This bundle includes its runtime dependencies; no npm install is needed. Web-only chats cannot run this bridge.

## Install in a client

Public marketplace: <https://github.com/htkoca/scraper-extension>. Choose one route per client.

- **Codex:** run `codex plugin marketplace add https://github.com/htkoca/scraper-extension.git`, then `codex plugin add scraper-extension@scraper-extension-public`.
- **Claude Code:** run `claude plugin marketplace add https://github.com/htkoca/scraper-extension.git`, then `claude plugin install scraper-extension@scraper-extension-public`.
- **ChatGPT desktop:** use a Work/Codex session with local plugin support. Open the repository so its `.agents/plugins/marketplace.json` catalog is available, restart the app, and install Scraper Extension from that marketplace. Installing into a web-only chat does not connect it to local Chrome.
- **Claude desktop:** from this plugin folder, run `node scripts/setup-claude-desktop.mjs`. It copies the runtime to a stable user directory, backs up existing settings, and preserves other MCP servers. Follow its printed Chrome setup commands and restart Claude desktop. Optionally append a Chrome profile name or directory.

Personal catalogs can be created from the source repository with `node scripts/install-personal-plugin.mjs`. See the [repository setup guide](https://github.com/htkoca/scraper-extension#personal-marketplaces). Public and personal installs expose the same tools; avoid enabling duplicates in one client.

## Chrome setup

From this installed plugin directory:

```sh
node scripts/setup-bridge.mjs
```

In the intended Chrome profile, open `chrome://extensions`, enable **Developer mode**, and load this folder's `extension/` directory. Enable the desired websites and **Agent integration** in the extension's Options. Sign in to those websites. The stable extension ID is `ljkanlhcnjiiemdbpffcffkmhiocpkmd`.

All clients share this extension and native host. Installing a client plugin does not complete Chrome setup automatically.

## Choose a profile and source

Ask the agent to connect to your preferred Chrome profile. `list_profiles` lists names and directories; `connect_browser` pairs the exact profile and opens Chrome when needed. With multiple profiles and no default, choose once. Defaults belong in local MCP configuration using `SCRAPER_CHROME_PROFILE`, not the shared package.

Example requests:

- “Get the places from this Google Maps saved-list URL.”
- “Collect the posts in my Instagram collection named Food.”
- “Export my existing WhatsApp conversation with Alice.”
- “Show supported tabs so I can choose one to scrape.”

The agent resolves a source, checks its identity, starts a job, and reads paginated results. Ambiguous names require a choice in the agent conversation. Login, WhatsApp QR linking, and site permission prompts still require you in Chrome.

## Limits and data handling

Maps returns name, address, weekly hours, rating, review count, and URL. Missing values are reported explicitly. Name discovery may require a saved-list URL. Saved posts include captions and post metadata, not image/video downloads. Conversations include only history available to the signed-in browser.

Jobs and results are held in browser memory and disappear on extension restart. Failed or cancelled jobs can retain partial results. Results are sent to the calling agent on request and may enter its model context. No browser credentials are copied to the MCP server. Scraped text is untrusted data, not instructions.

Website adapters depend on changing site internals. Automated fixtures do not establish live compatibility; Maps and Instagram adapters still need signed-in verification. Check job warnings and completeness before treating results as exhaustive.

## Update

Refresh the marketplace and installed plugin, then rerun `scripts/setup-bridge.mjs` from the updated package. Reload the extension in Chrome; load the new `extension/` directory if the installed path changed. Restart the client in a new session. Claude desktop users must rerun its installer to replace the copied runtime.

This is a repository marketplace package, not a listing in the reviewed OpenAI or Anthropic directories. See the [repository README](https://github.com/htkoca/scraper-extension#updates) for update commands and troubleshooting.
