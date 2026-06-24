# SF Credit Monitor — Chrome Extension

> **⚠ Work in progress — not yet verified as working end-to-end.**
> The auth approach has been rewritten to use the correct OAuth 2.0 JWT Bearer Flow but has not yet been tested against a live org. The setup steps below are correct in theory but the full flow (JWT signing → token exchange → Data Cloud queries) has not been validated. Use at your own risk and expect rough edges.

A Chrome extension for monitoring Salesforce Agentforce and Data Cloud consumption credits directly from your production org — overview cards, daily timeline, and drill-down by feature, user, and operation type.

---

## Key Features

- **Consumption Cards** — mirrors the Digital Wallet UI: progress bar, consumed vs. remaining vs. total, contract period, and health indicators (green / amber / red) per credit type
- **Timeline** — daily consumption chart sourced from the Data Cloud `TenantDailyEntitlementConsumption` DLO, with 30 / 60 / 90-day window
- **Breakdown** — grouped by Feature, User, or Operation Type from `TenantEnrichedUsageEvent`; sortable table with totals
- **Multi-org** — detects all open Salesforce tabs; org switcher appears when more than one org is active
- **Read-only** — the extension only reads data. It never writes, modifies, or publishes anything to your org

---

## Setup

One-time admin setup required before the extension will work.

### Step 1 — Generate a key pair

```bash
# Generate private key and self-signed certificate
openssl req -x509 -newkey rsa:2048 -keyout Data360_privatekey.pem -out Data360_publickey.cer \
  -days 3650 -nodes -subj "/CN=SF Credit Monitor"
```

### Step 2 — Create an External Client App in Salesforce

1. Setup → **External Client App Manager** → New External Client App
2. Settings tab → Edit → Enable OAuth → Callback URL: `http://localhost`
3. Enable **JWT Bearer Flow** → upload `Data360_publickey.cer`
4. Add OAuth scopes: `api`, `cdp_query_api`, `cdp_ingest_api`, `cdp_profile_api`, `refresh_token`
5. Save → Policies tab → Permitted Users: **Admin approved users are pre-authorized**
6. Assign the Data Cloud integration user's profile or permission set
7. Note the **Consumer Key** from the OAuth Settings tab

### Step 3 — Configure the extension

Right-click the extension icon → **Options**, then enter:
- **Login URL**: Production or Sandbox
- **Consumer Key**: from Step 2
- **Username**: the Data Cloud integration user's username
- **Private Key**: contents of `Data360_privatekey.pem`

Click **Test connection** to verify.

---

## How authentication works

The extension uses the **OAuth 2.0 JWT Bearer Flow** — the standard server-to-server auth pattern for Data Cloud. It bypasses SSO entirely and requires no user login prompt.

**Step 1 — JWT → Salesforce access token**
The extension signs a short-lived JWT with your private key and posts it to `/services/oauth2/token`. Salesforce validates the JWT against the certificate in your External Client App and returns an access token.

**Step 2 — Salesforce token → Data Cloud token**
The access token is exchanged via `/services/a360/token` for a Data Cloud tenant-specific token and TSE endpoint. All Data Cloud queries use this token against `{TSE}/api/v2/query`.

Both tokens are cached in the service worker's memory only — nothing is written to disk. All calls go directly from your browser to Salesforce — no third-party servers.

**Manifest permissions explained:**

| Permission | Why it is needed |
|---|---|
| `tabs` | Detect which Salesforce org the active tab is pointed at |
| `storage` | Store credentials (local) and org URL (session) |
| `activeTab` | Trigger org detection when you click the toolbar icon |
| `host_permissions` (`*.salesforce.com`, `*.360a.salesforce.com`) | Allow the service worker to call Salesforce and Data Cloud APIs |

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
