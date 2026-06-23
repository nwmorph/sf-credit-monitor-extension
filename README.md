# SF Credit Monitor — Chrome Extension

A Chrome extension for monitoring Salesforce Agentforce and Data Cloud consumption credits directly from your production org — overview cards, daily timeline, and drill-down by feature, user, and operation type.

---

## Key Features

- **Consumption Cards** — mirrors the Digital Wallet UI: progress bar, consumed vs. remaining vs. total, contract period, and health indicators (green / amber / red) per credit type
- **Timeline** — daily consumption chart sourced from the Data Cloud `TenantDailyEntitlementConsumption` DLO, with 30 / 60 / 90-day window
- **Breakdown** — grouped by Feature, User, or Operation Type from `TenantEnrichedUsageEvent`; sortable table with totals
- **Multi-org** — detects all open Salesforce tabs; org switcher appears when more than one org is active
- **Read-only** — the extension only reads data. It never writes, modifies, or publishes anything to your org

---

## How authentication works

The extension uses a two-step authentication flow — no connected app, no OAuth client ID, no external server required.

**Step 1 — Salesforce session cookie**
The extension reads the `sid` session cookie that Chrome already holds when you are logged into a Salesforce org. This is the same approach used by [Salesforce Inspector Reloaded](https://github.com/tprouvot/Salesforce-Inspector-reloaded) and is the correct pattern for a browser extension operating inside an existing session.

**Step 2 — Data Cloud token exchange**
To query the Data Cloud APIs (`TenantDailyEntitlementConsumption`, `TenantEnrichedUsageEvent`), the extension exchanges the Salesforce session token for a Data Cloud access token using the documented OAuth token exchange endpoint:

```
POST {orgUrl}/services/a360/token
grant_type=urn:salesforce:grant-type:external:cdp
subject_token={sid}
subject_token_type=urn:ietf:params:oauth:token-type:access_token
```

The response returns an `access_token` and an `instance_url` (the tenant-specific Data Cloud endpoint). This token is cached in the service worker's memory for its lifetime and is never written to disk.

All API calls go directly from your browser to your org — no third-party servers are involved.

**Manifest permissions explained:**

| Permission | Why it is needed |
|---|---|
| `cookies` | Read the `sid` session cookie to authenticate API calls |
| `tabs` | Detect which Salesforce org the active tab is pointed at |
| `storage` | Remember the org URL between tab opens (session storage only) |
| `activeTab` | Trigger org detection when you click the toolbar icon |
| `host_permissions` (`*.salesforce.com`, `*.360a.salesforce.com`) | Allow the service worker to make fetch requests to your org and Data Cloud APIs |

---

## Requirements

| Item | Detail |
|---|---|
| Chrome | 114+ (Manifest V3 + storage.session API) |
| Salesforce | Production org with Digital Wallet access |
| User permission | Access to Digital Wallet and Data Cloud APIs |

The extension is designed for production orgs — that is where Digital Wallet and consumption credit data live.

---

## Installation

This extension is not on the Chrome Web Store — it is installed directly from source. This is standard practice for internal developer tools and is called *sideloading*.

1. Download and unzip the [latest release](https://github.com/nwmorph/sf-credit-monitor-extension/releases/latest), **or** clone the repo:
   ```bash
   git clone https://github.com/nwmorph/sf-credit-monitor-extension.git
   ```
2. Open Chrome and navigate to `chrome://extensions`
3. Enable **Developer mode** (toggle in the top-right corner)
4. Click **Load unpacked** and select the `sf-credit-monitor-extension` folder
5. The SF Credit Monitor icon appears in your Chrome toolbar

> Chrome may show a one-time banner saying *"You have extensions running in developer mode"* — this is expected for sideloaded extensions and is not a security concern for a tool you have installed yourself from source.

To update, pull the latest changes and click **↺** on the extension card in `chrome://extensions`.

---

## Usage

1. Log into your Salesforce production org in any Chrome tab
2. Click the **SF Credit Monitor** icon in the toolbar → a new tab opens
3. Click **↺ Refresh** — the Digital Wallet cards load automatically
4. Use the sidebar to navigate between **Overview**, **Timeline**, and **Breakdown**
5. Adjust the date range for timeline and breakdown data

---

## Project Structure

```
manifest.json      # Chrome extension manifest (MV3)
background.js      # Service worker — auth, token exchange, API calls (read-only)
content.js         # Injected into Salesforce pages — org URL detection only
newtab/
├── index.html     # Full-page UI
├── app.js         # State, org detection, navigation, Chrome API glue
├── main.js        # Rendering engine — cards, charts, breakdown table
└── styles.css     # Styles with light/dark mode support
icons/             # Extension icons
```

---

## Releasing

Bump `version` in `package.json`, commit, tag, and push:

```bash
git tag v1.0.1
git push origin v1.0.1
```

---

## Credits

Created by **Niklas Waller**; source code written with [Claude](https://claude.ai) (Anthropic) acting as a coding agent under Niklas's direction.

**License:** MIT
