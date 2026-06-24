const KEYS = ['consumerKey', 'username', 'privateKey', 'loginUrl'];

async function load() {
  const data = await chrome.storage.local.get(KEYS);
  if (data.consumerKey) document.getElementById('consumerKey').value = data.consumerKey;
  if (data.username)    document.getElementById('username').value    = data.username;
  if (data.privateKey)  document.getElementById('privateKey').value  = data.privateKey;
  if (data.loginUrl) {
    const sel = document.getElementById('loginUrl');
    sel.value = data.loginUrl;
  }
}

function showStatus(msg, type) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = type;
  el.style.display = '';
}

document.getElementById('btn-save').addEventListener('click', async () => {
  const values = {
    consumerKey: document.getElementById('consumerKey').value.trim(),
    username:    document.getElementById('username').value.trim(),
    privateKey:  document.getElementById('privateKey').value.trim(),
    loginUrl:    document.getElementById('loginUrl').value,
  };
  if (!values.consumerKey || !values.username || !values.privateKey) {
    showStatus('Please fill in all fields.', 'err');
    return;
  }
  await chrome.storage.local.set(values);
  showStatus('Settings saved.', 'ok');
});

document.getElementById('btn-test').addEventListener('click', async () => {
  showStatus('Testing connection…', 'ok');

  // Save first so background has the latest values
  await chrome.storage.local.set({
    consumerKey: document.getElementById('consumerKey').value.trim(),
    username:    document.getElementById('username').value.trim(),
    privateKey:  document.getElementById('privateKey').value.trim(),
    loginUrl:    document.getElementById('loginUrl').value,
  });

  // Find an open Salesforce tab for the orgUrl context
  const tabs = await chrome.tabs.query({});
  const sfTab = tabs.find(t => t.url && /salesforce\.com|force\.com/.test(new URL(t.url || 'about:blank').hostname));
  const orgUrl = sfTab ? new URL(sfTab.url).origin : 'https://login.salesforce.com';

  chrome.runtime.sendMessage({ type: 'testAuth', orgUrl }, resp => {
    if (chrome.runtime.lastError) {
      showStatus(`Error: ${chrome.runtime.lastError.message}`, 'err');
      return;
    }
    if (resp.ok) {
      showStatus(`Connected. Data Cloud endpoint: ${resp.data.tse}`, 'ok');
    } else {
      showStatus(`Failed: ${resp.error}`, 'err');
    }
  });
});

load();
