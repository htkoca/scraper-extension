# Scraper Extension

Requires Node.js 22+ and Google Chrome on macOS or Linux.

Run `node scripts/setup-bridge.mjs` from this plugin folder. In Chrome's extensions page, enable Developer mode and load this folder's `extension` directory. Enable website access and Codex integration in the extension's Options.

Restart ChatGPT desktop and start a new chat with this plugin. Ask it to connect to your preferred Chrome profile, then name the service and source to collect. Profile preferences belong in local MCP configuration using SCRAPER_CHROME_PROFILE.

Results remain in browser memory until the extension restarts and are sent to the calling agent on request. Chrome login and optional site access are required. No browser credentials are copied to the MCP server.

Maps name discovery may require a saved-list URL. New website adapters have automated fixture coverage but still need live signed-in verification. This package is distributed through a GitHub marketplace, not the reviewed OpenAI directory.
