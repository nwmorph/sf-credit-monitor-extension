// Detect the Salesforce org URL and store it for the extension
(function () {
  const origin = window.location.origin;
  if (!origin || origin === 'null') return;
  chrome.storage.session.set({ orgUrl: origin }, () => {
    chrome.runtime.sendMessage({ type: 'orgDetected', orgUrl: origin }).catch(() => {});
  });
})();

// Allow the background service worker to make credentialed fetches via this
// content script, which runs inside the Salesforce tab and carries the full
// SSO session. The service worker cannot do this itself — its fetch context
// is separate from the browser's cookie jar.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'credentialedFetch') return false;
  fetch(message.url, {
    method: message.method || 'POST',
    credentials: 'include',
    headers: message.headers || {},
    body: message.body || undefined
  })
    .then(async res => {
      const body = await res.text();
      sendResponse({ ok: res.ok, status: res.status, body });
    })
    .catch(err => sendResponse({ ok: false, status: 0, body: err.message }));
  return true;
});
