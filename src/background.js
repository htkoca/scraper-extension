import { platformForUrl } from "./platforms.js";

chrome.action.onClicked.addListener(async (tab) => {
  await chrome.tabs.create({
    url: chrome.runtime.getURL("app.html") + "?tab=" + tab.id,
  });
});

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (
    sender.id !== chrome.runtime.id ||
    !sender.url?.startsWith(chrome.runtime.getURL("app.html")) ||
    sender.tab?.url?.startsWith("https://")
  )
    return;
  if (message.type !== "platform" || !Number.isInteger(message.tabId)) return;
  (async () => {
    const tab = await chrome.tabs.get(message.tabId);
    const platform = platformForUrl(tab.url);
    if (!platform)
      throw new Error(
        "Open an Instagram or WhatsApp conversation and click the extension icon again.",
      );
    if (message.platform && platform.id !== message.platform)
      throw new Error(
        "The source tab changed platforms. Reconnect before collecting.",
      );
    if (
      !["context", "messages", "transcription"].includes(message.request?.kind)
    )
      throw new Error("Unknown request.");
    if (
      message.request.kind === "transcription" &&
      !platform.capabilities.transcribe
    )
      throw new Error("Transcription is unavailable for this platform.");
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: message.tabId },
      world: "MAIN",
      func: platform.request,
      args: [message.request],
    });
    if (!result?.result)
      return { ok: false, error: `${platform.label} did not respond.` };
    return { ...result.result, platform: platform.id };
  })().then(reply, (error) => reply({ ok: false, error: error.message }));
  return true;
});
