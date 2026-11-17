// Hidden page used only to copy text on Chrome versions where the background
// worker cannot reach the clipboard.
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== "offscreen:copy") return false;
  const area = document.createElement("textarea");
  area.value = message.text;
  document.body.append(area);
  area.select();
  document.execCommand("copy");
  area.remove();
  respond(true);
  return false;
});
