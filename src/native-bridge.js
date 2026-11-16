import { ScrapeService } from "./scrape-service.js";

export function installNativeBridge(browser) {
  let port;
  let service;
  let connecting = false;
  async function connect() {
    if (port || connecting) return;
    connecting = true;
    try {
      const { bridgeEnabled } =
        await browser.storage.local.get("bridgeEnabled");
      if (!bridgeEnabled) return;
      service ||= new ScrapeService(browser);
      port = browser.runtime.connectNative("org.scraper_extension.bridge");
      const current = port;
      port.onMessage.addListener((message) => {
        if (
          typeof message?.id !== "string" ||
          typeof message.method !== "string"
        )
          return;
        service.handle(message.method, message.params).then(
          (result) => {
            try {
              current.postMessage({ id: message.id, result });
            } catch {}
          },
          (error) => {
            try {
              current.postMessage({ id: message.id, error: error.message });
            } catch {}
          },
        );
      });
      port.onDisconnect.addListener(() => {
        // Reading lastError suppresses Chrome's unhandled native-host warning.
        const error = browser.runtime.lastError?.message;
        if (port === current) port = null;
        browser.storage.local.set({ bridgeStatus: error || "Disconnected" });
      });
      await browser.storage.local.set({
        bridgeStatus: "Connecting to local host",
      });
    } finally {
      connecting = false;
    }
  }
  browser.runtime.onStartup.addListener(connect);
  browser.runtime.onInstalled.addListener(connect);
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.bridgeEnabled) return;
    if (changes.bridgeEnabled.newValue) connect();
    else {
      for (const job of service?.jobs.values() || [])
        job.controller.abort(new Error("Integration disconnected"));
      port?.disconnect();
      port = null;
    }
  });
  browser.runtime.onMessage.addListener((message, sender, reply) => {
    if (
      sender.id !== browser.runtime.id ||
      sender.url !== browser.runtime.getURL("options.html")
    )
      return;
    if (message?.type === "reconnect-native") {
      port?.disconnect();
      port = null;
      connect().then(
        () => reply({ ok: true }),
        (error) => reply({ error: error.message }),
      );
      return true;
    }
  });
  connect();
}
