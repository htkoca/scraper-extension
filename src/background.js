import { instagramRequest } from "./instagram.js";

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
  if (message.type !== "instagram" || !Number.isInteger(message.tabId)) return;
  (async () => {
    const tab = await chrome.tabs.get(message.tabId);
    if (!tab.url?.startsWith("https://www.instagram.com/direct/t/"))
      throw new Error(
        "Return to the Instagram conversation and click the extension icon again.",
      );
    if (
      !["context", "messages", "transcription"].includes(message.request?.kind)
    )
      throw new Error("Unknown request.");
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: message.tabId },
      world: "MAIN",
      func: instagramRequest,
      args: [message.request],
    });
    return result?.result || { ok: false, error: "Instagram did not respond." };
  })().then(reply, (error) => reply({ ok: false, error: error.message }));
  return true;
});
