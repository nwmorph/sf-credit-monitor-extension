// Detect the Salesforce org URL and store it for the extension
(function () {
  const origin = window.location.origin;
  if (!origin || origin === 'null') return;
  chrome.storage.session.set({ orgUrl: origin }, () => {
    chrome.runtime.sendMessage({ type: 'orgDetected', orgUrl: origin }).catch(() => {});
  });
})();
