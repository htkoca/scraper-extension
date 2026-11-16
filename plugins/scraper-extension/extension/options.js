// src/sources.js
var siteOrigins = {
  instagram: ["https://www.instagram.com/*"],
  whatsapp: ["https://web.whatsapp.com/*"],
  "google-maps": ["https://www.google.com/maps/*", "https://maps.google.com/*"]
};

// src/options.js
var status = document.getElementById("status");
var enabled = document.getElementById("enabled");
var report = (error) => {
  status.textContent = error.message || String(error);
};
for (const checkbox of document.querySelectorAll("[data-site]")) {
  const origins = siteOrigins[checkbox.dataset.site];
  checkbox.checked = await chrome.permissions.contains({ origins });
  checkbox.addEventListener("change", async () => {
    try {
      if (checkbox.checked)
        checkbox.checked = await chrome.permissions.request({ origins });
      else await chrome.permissions.remove({ origins });
      status.textContent = checkbox.checked ? "Website enabled. Select tabs in your agent." : "Website disabled.";
    } catch (error) {
      checkbox.checked = false;
      report(error);
    }
  });
}
enabled.checked = Boolean(
  (await chrome.storage.local.get("bridgeEnabled")).bridgeEnabled
);
enabled.addEventListener("change", async () => {
  try {
    if (enabled.checked)
      enabled.checked = await chrome.permissions.request({
        permissions: ["tabs"]
      });
    await chrome.storage.local.set({ bridgeEnabled: enabled.checked });
    if (!enabled.checked)
      await chrome.permissions.remove({ permissions: ["tabs"] });
    status.textContent = enabled.checked ? "Integration enabled." : "Integration disabled.";
  } catch (error) {
    enabled.checked = false;
    report(error);
  }
});
document.getElementById("reconnect").addEventListener("click", async () => {
  try {
    const result = await chrome.runtime.sendMessage({
      type: "reconnect-native"
    });
    if (result?.error) throw new Error(result.error);
    status.textContent = "Reconnecting. Use list_tabs in your agent to check the connection.";
  } catch (error) {
    report(error);
  }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.bridgeStatus)
    status.textContent = changes.bridgeStatus.newValue;
});
var pairing = new URLSearchParams(location.hash.slice(1));
if (/^(Default|Profile \d+)$/.test(pairing.get("profile") || "") && /^[a-f0-9-]{36}$/.test(pairing.get("nonce") || "")) {
  await chrome.storage.local.set({
    bridgeProfile: {
      directory: pairing.get("profile"),
      nonce: pairing.get("nonce")
    }
  });
  history.replaceState(null, "", location.pathname);
  if (enabled.checked)
    await chrome.runtime.sendMessage({ type: "reconnect-native" });
}
