# Scraper Extension

Local MCP tools for Claude desktop, Claude Code, ChatGPT desktop, and Codex. Requires Node.js 22+ and Google Chrome on macOS or Linux. Web-only chats cannot run this local bridge.

## Chrome setup

Run `node scripts/setup-bridge.mjs` from this plugin folder. In Chrome's extensions page, enable Developer mode and load this folder's `extension` directory. Enable websites and **Agent integration** in Options.

## Clients

- **ChatGPT desktop / Codex:** install from the repository's `.agents/plugins/marketplace.json` catalog. Start a new conversation after installation.
- **Claude Code:** add the repository URL with `/plugin marketplace add`, then `/plugin install scraper-extension@scraper-extension-public`. The Claude marketplace and plugin manifests are bundled alongside the OpenAI manifests.
- **Claude desktop:** run `node scripts/setup-claude-desktop.mjs`. Optionally append your Chrome profile name or directory. It copies the runtime to a stable user directory, backs up the existing Claude config, and preserves other MCP servers. Restart Claude desktop afterward. Run the copied Chrome setup script and load its extension directory if this is your first installation.

Use one installation method per client to avoid duplicate tools. All clients use the same Chrome extension and native host. Ask the agent to connect to your preferred Chrome profile, then name a service and source. Profile preferences belong in local MCP configuration using `SCRAPER_CHROME_PROFILE`, not in the shared package.

Results remain in browser memory until the extension restarts and are sent to the calling agent on request. Chrome login and optional site access are required. No browser credentials are copied to the MCP server.

Maps name discovery may require a saved-list URL. Website adapters have automated fixture coverage but still need live signed-in verification. This is a GitHub marketplace package; it is not listed in the reviewed OpenAI or Anthropic directories.
