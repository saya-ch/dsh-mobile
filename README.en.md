<p align="center">
  <img src="https://raw.githubusercontent.com/saya-ch/dsh-mobile/main/assets/brand/repository-hero.png?v=0bfc8f909993" alt="Use DeepSeek Harness from a phone" width="100%">
</p>

<h1 align="center">DSH Mobile</h1>

<p align="center">Secure, live access to DeepSeek Harness from a phone.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-mobile"><img src="https://img.shields.io/npm/v/dsh-mobile?label=npm&amp;color=CB3837" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/dsh-mobile"><img src="https://img.shields.io/npm/dt/dsh-mobile?label=downloads&amp;color=2563EB" alt="total npm downloads"></a>
  <a href="https://github.com/saya-ch/dsh-mobile/actions/workflows/ci.yml"><img src="https://github.com/saya-ch/dsh-mobile/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/saya-ch/dsh-mobile/releases"><img src="https://img.shields.io/badge/Android-10%2B-3DDC84?logo=android&amp;logoColor=white" alt="Android 10+"></a>
  <a href="#iphone-and-ipad-home-screen-web-app-pwa"><img src="https://img.shields.io/badge/iOS%20%2F%20iPadOS-PWA-111111?logo=apple&amp;logoColor=white" alt="iOS / iPadOS Home Screen web app (PWA)"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-0F172A" alt="Apache-2.0"></a>
  <a href="https://github.com/awesome-dsh-plugin/awesome-dsh-plugin"><img src="https://awesome-dsh-plugin.com/badge.svg" alt="Awesome DSH Plugin"></a>
</p>

<p align="center">
  <a href="#what-it-does">What it does</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#iphone-and-ipad-home-screen-web-app-pwa">iPhone / iPad</a> ·
  <a href="#connection-guide">Connection guide</a> ·
  <a href="#extend-and-customize">Extend and customize</a> ·
  <a href="#device-management">Device management</a> ·
  <a href="#third-party-plugin-compatibility">Third-party plugins</a> ·
  <a href="#security">Security</a> ·
  <a href="#compatibility">Compatibility</a> ·
  <a href="docs/README.md">Documentation</a> ·
  <a href="#contributors">Contributors</a> ·
  <a href="https://github.com/saya-ch/dsh-mobile/releases/tag/v0.8.0">Release notes</a> ·
  <a href="README.md">简体中文</a>
</p>

> DSH Mobile is a DeepSeek Harness community plugin; the native app supports Android only.
>
> **Using an iPhone or iPad?** Use Safari or [add DSH Mobile to your Home Screen as a web app (PWA)](<#iphone-and-ipad-home-screen-web-app-pwa>)—no native iOS download needed.
>
> **Current stable release: 0.8.0**. Add **iPhone / iPad Home Screen setup and Web Push notifications**, with six categories for questions, plans, approvals, responses, goals and failures. Also improve sidebar position retention, attachment actions and slow-link transfers. [Plugin release notes and downloads](https://github.com/saya-ch/dsh-mobile/releases/tag/v0.8.0) · [Full changelog](CHANGELOG.md).
>
> **Version policy**: since plugin **0.6.2**, the Android app and plugin use independent version numbers and releases. Their numbers do not need to match, and a plugin update does not imply an app update. [Compatibility notes](#compatibility).

<p align="center">
  <a href="https://github.com/saya-ch/dsh-mobile/releases/download/android-v0.7.1/dsh-mobile-android-v0.7.1.apk"><img src="https://raw.githubusercontent.com/saya-ch/dsh-mobile/main/assets/brand/app-icon-rounded.svg" alt="DSH Mobile Android app icon" width="72" height="72"></a><br>
  <a href="https://github.com/saya-ch/dsh-mobile/releases/download/android-v0.7.1/dsh-mobile-android-v0.7.1.apk"><strong>Download Android app 0.7.1 (compatibility)</strong></a><br>
  <sub><a href="https://github.com/saya-ch/dsh-mobile/releases/download/android-v0.7.1/dsh-mobile-android-v0.7.1-iroh.apk">64-bit full APK (experimental iroh)</a> · <a href="https://github.com/saya-ch/dsh-mobile/releases/tag/android-v0.7.1">Release notes and checksums</a></sub>
</p>

DSH Mobile is a DeepSeek Harness plugin that lets a mobile browser or the Android app connect over a protected LAN or an optional Tailscale Funnel, cpolar, cloudflared, self-hosted FRP, or own reverse-proxy remote path. The full Android App also supports experimental iroh encrypted direct connections with relay fallback. The phone reaches the computer's sessions, Workspaces, messages and tools. The computer manages LAN and remote switches and pairing authorizations separately; the Android app lists paired computers together. The plugin does not modify DeepSeek Harness source.

Mobile access uses a dedicated HTTPS origin and device pairing. The Android app pins the private LAN CA; public remote paths use platform-trusted certificates. The self-signed FRP entry additionally requires the 0.4.6 app to pin a remote CA during pairing.

It also lets you customize the phone from a DSH conversation: `/mobile <what you want>`.

## What it does

- **Continue DSH work from a phone**: the same sessions, Workspaces, messages, and tools, in real time.
- **Customize the phone UI by talking to DSH**: request layout, interaction, or feature changes in a conversation; changed customization resources are usually picked up automatically.
- **A dedicated touch layout**: session drawer, tool details, settings, question cards, and composer reorganized for phones. The sidebar remembers its list position within the page instead of jumping to the top after a session switch. The app follows the system locale (Chinese/English/Italian), plugin UI follows DSH's locale.
- **Several remote options**: Tailscale, cpolar, cloudflared quick/named tunnels, self-hosted FRP, your own reverse proxy, and experimental iroh without a domain or public port; Windows/Linux x64 can also let the plugin manage Caddy HTTPS and certificates.
- **Pairing and multi-device**: pair once via QR code, link, or key; Wi-Fi, hotspot, or IP changes normally recover automatically; the app lists LAN and remote paired computers together, checks their reachability periodically, and lets you switch, re-pair, or delete a local record.
- **One-click diagnostics and approval**: check versions, gateway, network interface, firewall, and the remote path with a redacted report; approve blocked third-party plugin connections per exact path.
- **iPhone / iPad Web Push**: add the page to your Home Screen and explicitly enable notifications in DSH General settings. Choose from six categories and receive alerts while the page is closed or the screen is locked, without conversation text on the lock screen. [Requirements and setup](docs/WEB_PUSH.en.md).
- **Android task notifications**: enable completion and pending-input alerts in DSH General settings inside the app, using its separate native notification channel with redacted lock-screen text.
- **Defense in depth**: a private CA pinned for LAN, trusted HTTPS for public remote paths, and a remote CA pinned by the 0.4.6 app for the self-signed FRP entry. Credentials are Keystore-backed, device tokens go only to their exact Origin, and third-party WebSockets are blocked by default.

A paired device can operate DSH on the computer and must be treated as fully trusted. Enable LAN access only on trusted networks, and use a reliable HTTPS channel for remote access. Revoke a lost phone from the computer immediately.

## Quick start

Install the plugin on the computer, then pair the Android app or a mobile browser. Choose the installation path for your DSH host.

### Official DSH Desktop

Install and enable `dsh-mobile` from the app's **Plugins** page, then open **Mobile Access** to configure LAN or a remote channel. The app manages its Desktop profile; the `--profile web` commands below do not apply to it.

After installing or updating, quit Desktop from the application menu and reopen it without clearing sessions or pairing data. If it still reports `dsh-mobile-question-fixes: failed to import`, check the installation log; a component-resolution failure may not be fixed by restarting alone.

### DSH Web

With an installed `dsh` command, run:

```powershell
dsh plugin --profile web add dsh-mobile@latest
dsh plugin --profile web exec dsh-mobile setup
dsh --profile web
```

<details>
<summary>DeepSeek Harness source checkout or community plugin market</summary>

From the DeepSeek Harness source directory, run:

```powershell
pnpm install
pnpm dsh plugin --profile web add dsh-mobile@latest
pnpm dsh plugin --profile web exec dsh-mobile setup
pnpm dsh --profile web
```

Or via the plugin market (optional):

```powershell
dsh plugin --profile web add dshmarket
```

Restart DSH, then search for **dsh-mobile** under **Settings → Plugin Market** and install it. On first opening Mobile access, the Local network page lists this computer's current networks; confirm one to create private certificates and LAN configuration, then restart DSH once as prompted. No terminal `setup` command is required for this path.

</details>

`setup` automatically selects and remembers the current LAN; Wi-Fi, hotspot, and IP changes normally recover without re-pairing. Use `--address 192.168.x.x` only when automatic selection fails. Settings, certificates, devices, and customization files live under `$DSH_HOME/mobile-access/`.

### Install the Android app

Download the official Android APK using the link above. Then choose LAN or remote access in the [connection guide](#connection-guide); the phone needs no separate tunnel client. For browser access, including iOS, follow the steps below.

Registry-installed plugins check for updates when the desktop UI loads and show “Update plugin” beside the access-panel title when a newer release is available. Restart DSH after installation. The app download entry shows the latest version; local development packages are not overwritten, and Android does not check for or push app-version updates.

### iPhone and iPad: Home Screen web app (PWA)

The plugin runs on the **computer**; Safari loads its mobile interface. There is no native iOS app to install.

1. Install and enable the plugin on the computer as above. In **Mobile Access**, configure your [connection](<#connection-guide>); prefer a stable, trusted HTTPS address for a lasting Home Screen installation.
2. Stay in that connection's panel: use **Copy pairing link** for LAN, or **Generate remote pairing QR code** then **Copy remote pairing link** for Remote. Open the resulting browser link in **Safari** and complete pairing. Use the dedicated Mobile Access link, not the computer's ordinary DSH page; Android `dsh1.`/`dsh2.` keys are not browser pairing codes.
3. From the paired page, open Safari's **Share** menu → **Add to Home Screen**. Turn on **Open as Web App** if offered, then tap **Add**. Menu layout varies; see [Apple's iPhone instructions](<https://support.apple.com/guide/iphone/bookmark-a-website-iph42ab2f3a7/ios>).
4. Launch the new Home Screen icon to continue the same DSH sessions and Workspaces. If it shows a **Pairing code** form, follow the [fresh-code recovery steps](<docs/WEB_PUSH.en.md#if-the-home-screen-app-shows-a-pairing-form>); Safari's first code is single-use. A normal reconnect page uses saved pairing instead. Keep existing installations and pairing/site data when troubleshooting.

You can also keep using Safari without installing an icon. The computer, DSH and Mobile Gateway must stay running and reachable; adding the web app does **not** provide offline DSH. A changing tunnel hostname does not automatically transfer pairing or push consent.

**Enable Web Push:** launch the Home Screen icon, open **DSH Settings → General → Web push notifications**, select **Enable**, allow notifications and choose your categories. This targets capable iOS/iPadOS **18.4+** Home Screen apps on trusted HTTPS; ordinary Safari tabs and the Android app do not show this entry. Notifications are optional and are not required for ordinary access. [Full guide and troubleshooting](docs/WEB_PUSH.en.md).

## Connection guide

LAN and remote access are independent connections. Prefer LAN while the phone is near the computer for the lowest latency, and enable remote access only when leaving that network. The computer manages their switches and pairing authorizations separately; the Android app shows all paired computers together in its device list.

### Local network

Use this when the phone and computer share Wi-Fi, Ethernet, or a phone hotspot. It is the default and simplest path.

<p align="center">
  <img src="https://raw.githubusercontent.com/saya-ch/dsh-mobile/main/assets/screenshots/lan-access-en.png" width="82%" alt="DSH Mobile LAN access, pairing QR code, and device management">
</p>

1. Connect the phone and computer to the same local network, then open **Mobile Access → Local network** in the lower-left corner of DeepSeek Harness.
2. If needed, select **Enable local access**, then select **Generate pairing QR code**. The panel displays a pairing QR code.
3. In the Android app, open **Local network**, scan for computers, select the device, then scan the QR code or paste the pairing key.
4. Pairing creates persistent device trust. Later app launches discover and connect automatically; Wi-Fi, hotspot, and DHCP address changes normally do not require pairing again.

LAN and HTTPS remote pairing codes show their expiry time. Generate a new code after expiry; doing so invalidates the previous code. **Copy pairing link** reuses the current valid code instead of invalidating the displayed QR. The computer-side **Device** entry lists and revokes LAN and remote authorizations in separate tabs; it does not manage the saved computer list in the App.

When other plugin entries share the sidebar footer, **Mobile access** becomes a phone-icon button. Hover to read its name; clicking opens the same panel. Its text label returns when the entry is alone.

Port note: `dsh web --port` changes the DSH Web upstream port (3080 by default), which the plugin follows automatically. `dsh-mobile setup --port` changes the Mobile HTTPS listener (3443 by default), and the pairing QR code includes the selected port. When DSH Desktop starts with `--port 0`, the gateway follows the **actual port in use**; `upstreamOrigin` in `mobile-access/setup.json` is only the snapshot from the first setup, and the plugin refreshes it at startup — do not read it as the upstream the gateway uses.

<details>
<summary>Headless hosts, private proxies and additional source networks</summary>

Headless Linux hosts, and browsers that open DSH Web through a LAN IP or reverse proxy, can use the same **Mobile access** control in the lower-left corner. The admin API still requires a loopback TCP peer (for example a local `socat` or reverse proxy to `127.0.0.1`) so the plugin itself is not LAN-exposed. The browser Host may be `localhost`, RFC1918, or an IPv4 link-local address; public IPs and arbitrary DNS names still return 403. The reverse proxy must be limited to trusted local or LAN callers and must not publicly forward `/api/mobile-access`. The dedicated Mobile HTTPS listener (3443 by default) remains the phone surface and does not become the desktop admin panel.

For a routed network such as WireGuard, 0.6.0 offers [additional trusted networks](docs/TRUSTED_NETWORKS.en.md). It adds explicit source CIDRs only, without creating a VPN or routes or changing Windows firewall rules.

</details>

The app is optional: select **Copy pairing link** and open it in a mobile browser. LAN uses a private certificate, which the browser may warn about on first visit; continue only after confirming that this is your DSH gateway. A public-certificate remote origin should not show a certificate warning. If it does, check the channel and certificate instead of bypassing the warning.

Browser pairing and reauthentication pages support Simplified Chinese, English and Italian. Since plugin 0.6.16, they prefer the DSH display language remembered for that gateway hostname, falling back to the browser's `Accept-Language` when no usable preference exists; clearing site data or changing hostname can reset it. Native Android screens follow the system language, while the DSH plugin control panel follows DSH's current language.

For manual browser pairing, enter the 43-character pairing code shown on the computer. Keys starting with `dsh1.` or `dsh2.` belong in the Android app, not the browser field. Prefer the pairing link copied from the computer, which fills the code automatically; generate a new link when it expires.

### Remote access

Use this after the phone leaves the computer's network. Remote access is disabled by default, and the phone needs no separate Tailscale, cpolar, cloudflared, or FRP app.

**Without a domain or public inbound access, you can also try iroh (experimental).** Install the pinned computer component and the **full Android App 0.7.0** to connect through encrypted direct links with relay fallback. Computer support is currently Windows/Linux x64; the compatibility APK and mobile browsers cannot use iroh. This is not a guaranteed connectivity or acceleration service: VPNs, proxies and both networks can affect it. See [iroh setup and troubleshooting](docs/IROH.en.md).

Remote providers may impose bandwidth and connection limits: the [cpolar Free plan](https://svip.cpolar.com/pricing) currently lists 1 Mbps, while [Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel#requirements-and-limitations) has non-configurable bandwidth limits, and a cloudflared quick tunnel is a free Cloudflare address with randomized hostnames and rate limiting. DSH Mobile uses gzip for static assets, persistent WebSockets, and load-on-scroll history to improve loading; DSH controls the Session history window and page sizes, and the plugin cannot raise provider quotas.

If the page opens but stays on “Reconnecting,” distinguish WebSocket upgrade failures, slow synchronization, and heartbeat deadlines using the [slow-link and reconnection guide](docs/SLOW_CONNECTIONS.en.md). Version 0.5.4 also offers opt-in WebSocket compression per exact path, disabled by default; for long Sessions or metered links, follow the guide and compare actual transfer volume.

The usage notes below reflect the maintainer's long-term experience on a personal mainland-China network, not a universal comparison. Performance depends on the carrier, network and plan; verify the route on your own phone's network.

| Channel | Prerequisites | Address and limitation | Maintainer's usage notes |
| --- | --- | --- | --- |
| iroh (experimental) | Windows/Linux x64 computer component and full Android App 0.7.0 | No domain, port forwarding or tunnel account; encrypted direct links with relay fallback; [setup and VPN troubleshooting](docs/IROH.en.md) | An option without public ingress, not a stability ranking; verify on both actual networks. Mobile browsers are unsupported |
| cpolar | Account and Authtoken | Free temporary URLs may change | The free plan's bandwidth limit noticeably slows everyday loading and synchronization |
| cloudflared quick tunnel | No account or domain | Random temporary URL; no SSE, with [notification limits](docs/CLOUDFLARE_TUNNEL.en.md#quick-tunnel-feature-limits); [officially intended only for development and testing](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) | Frequent disconnections in long-term use, with the cause still unconfirmed; a temporary or testing choice |
| cloudflared named tunnel | Cloudflare account and domain | Fixed hostname; [setup guide](docs/CLOUDFLARE_TUNNEL.en.md) | The most stable of the channels used long-term; worth trying first if you have an account and domain |
| Tailscale Funnel | Sign-in and Funnel authorization | Availability depends on the network | This personal network often needs proxy assistance and may still fail to connect; not every user needs a proxy |
| Self-hosted FRP | VPS and domain or real public IPv4 | Server maintenance required; [deploy](docs/SELF_HOSTED_FRP.en.md) or [attach to existing frps](docs/ATTACH_EXISTING_FRPS.en.md) | More control over deployment and resources; long-term stability depends on the VPS route, configuration and maintenance |
| Own reverse proxy | Existing public HTTPS proxy | The plugin provides only its private authenticated backend; [guide](docs/SELF_HOSTED_ORIGIN.en.md) | Reuses your proxy infrastructure; stability depends on the proxy, network route and maintenance |
| Managed Caddy | Tencent Cloud DNSPod-managed domain and reachable public ingress | Plugin-managed HTTPS and certificates on Windows/Linux x64; [guide](docs/CADDY_MANAGED.en.md) | Does not traverse NAT; check inbound ports and forwarding. Existing Cloudflared users do not need to migrate |

<p align="center">
  <img src="https://raw.githubusercontent.com/saya-ch/dsh-mobile/main/assets/screenshots/remote-access-en.png" width="82%" alt="DSH Mobile remote access and provider selection">
</p>

The following steps cover HTTPS remote channels. **iroh uses its own “Generate iroh pairing QR code” action and the full App, as described below.** Do not open its descriptor as an ordinary browser URL.

1. Open **Mobile Access** in the lower-left corner of DeepSeek Harness, choose an HTTPS channel and complete its sign-in or configuration.
2. Once ready, select **Generate pairing QR code**. External proxy mode's **Backend listening** does not establish public readiness; verify public HTTPS and WebSocket access as well.
3. Select **Remote access** in the Android app and scan the current QR code. A publicly trusted certificate also permits pairing from a mobile browser.
4. Later launches reconnect using the saved address and credential. If a temporary address changes, scan the current computer QR code to verify it. Do not clear app data; the stored device token never goes to a new Origin.

<details>
<summary>Installation and sign-in for each channel</summary>

After selecting the channel in the panel:
   - **iroh (experimental)**: select iroh, choose **Install official component**, then enable remote access after installation and verification. Once ready, choose **Generate iroh pairing QR code** and scan it through the full Android App's iroh flow, or copy the pairing link. Main actions stay hidden before installation; afterwards all three share one row, with Copy disabled until valid pairing data exists. After stopping the channel, component details let you remove the downloaded program without deleting identity or pairings. See the [iroh guide](docs/IROH.en.md) for the full procedure and limits.
   - **Tailscale Funnel**: select **Enable remote access**, complete the one-time Tailscale sign-in on the official page, follow the panel prompt to allow Funnel, then return to DSH and wait until the connection is ready.
   - **cpolar**: select **Install official component**, sign in to the cpolar dashboard and obtain an Authtoken, paste it, then select **Save and connect**. The component is downloaded into the plugin's private directory only after confirmation; free temporary addresses may change after DSH or cpolar restarts.
   - **Self-hosted FRP (advanced)**: if you have a VPS, select **Self-hosted FRP** under **Mobile access** and enter its frps details and a public HTTPS domain or real public IPv4 address. Apply the restricted frps + Caddy template manually, or deploy with an SSH key on Ubuntu/Debian with systemd. Password login is unsupported. Use manual deployment and merge the import as described in the guide when custom Caddy sites already exist. Verify the VPS host keys against its console before deployment or cleanup. The local `frpc` is downloaded and verified on demand; VPS cleanup is separate. Android app 0.3.3 or later is required. The [self-hosted FRP guide](docs/SELF_HOSTED_FRP.en.md) covers certificates, ports, and the complete procedure.
   - **Own reverse proxy**: open **Mobile access → Own reverse proxy**, enter the public HTTPS origin (custom ports supported), private listen IP (IPv4 or IPv6 loopback/ULA), separate HTTP backend port (default 3444), and allowed direct proxy source CIDRs, then select **Save and start backend**. This uses your existing Lucky/Nginx/Caddy without a tunnel component and requires Android app 0.4.0 or later. See the [own reverse proxy guide](docs/SELF_HOSTED_ORIGIN.en.md).
   - **Managed Caddy**: under **Mobile access → Own reverse proxy**, select **Managed Caddy**, choose **Install managed Caddy**, and confirm the download. Enter the public HTTPS origin, Tencent Cloud DNSPod credentials and local HTTPS listen port, then choose **Save and start Caddy**. A domain and reachable public ingress are required; this does not bypass CGNAT. See the [managed Caddy guide](docs/CADDY_MANAGED.en.md) for forwarding and complete steps.
   - **cloudflared quick tunnel**: select **Install official component**. After you confirm, the plugin downloads a pinned build from the official release page into its private directory and requests a temporary public address (a quick tunnel) with **no sign-up or sign-in**. Choose this when you would rather not create an account. The quick-tunnel hostname changes on every reconnect, and Cloudflare positions quick tunnels for testing: they are rate-limited and carry no uptime guarantee, so do not rely on one for production access that must stay reachable; it suits temporary or verification use.
   - **cloudflared named tunnel**: with a Cloudflare account and domain, switch **Tunnel type** to **Named**, then supply a connector token, a public hostname and a local forward port to get an address that survives restarts. The token is stored only in the private directory and reaches cloudflared through the environment rather than the command line; see [Cloudflare named tunnel](docs/CLOUDFLARE_TUNNEL.en.md).

</details>

<details>
<summary>Remote notifications, server maintenance and security limits</summary>

> **Remote notifications**: Android task reminders use the page/SSE path and need the app's WebView to remain alive. [iPhone/iPad Web Push](docs/WEB_PUSH.en.md) is explicitly enabled from a capable Safari Home Screen app and does not need an open page. Both require DSH to keep running on the computer; networks, Focus settings and platform scheduling can delay delivery, so neither is a guaranteed alarm service. Independently configured channels such as dsh-ping remain unchanged.

The Funnel runtime ties the public listener to the parent process and a bounded control channel; parent exit, channel closure, or an explicit stop ends the current generation and cleans up its resources. An unregistered domain on a mainland-China VPS may be intercepted by the cloud provider; public IPv4 mode avoids that dependency. The plugin validates pinned on-demand components; locally managed configuration and binaries live under `$DSH_HOME/mobile-access/` and can be cleaned up from the panel. VPS files require separate cleanup through the self-hosted connection guide.

Managed self-hosted FRP uses an HTTP vhost to the DSH loopback gateway. Its plaintext VPS listener must be loopback-only, with Caddy providing public HTTPS. Version 0.4.6 adds existing-frps attachment without installing or changing the server: its public-CA mode still needs a restricted HTTP vhost and Caddy, while its self-signed mode forwards raw TCP to a computer-side HTTPS gateway whose CA the 0.4.6 Android app pins during pairing. The self-signed mode currently uses public IPv4 and is unavailable to older apps. Neither mode exposes arbitrary FRP configuration. Because frps `proxyBindAddr` governs proxy listeners globally, do not change it for the new TCP entry without checking existing plaintext vhosts. See the [attachment guide](docs/ATTACH_EXISTING_FRPS.en.md).

The own-proxy HTTP backend must remain on a trusted private network: **never port-forward it publicly or bypass it by proxying to DSH or the existing LAN 3443 gateway**. CIDRs match the proxy's direct TCP peer, not forwarded headers. Preserve the external Host (including port), Origin, cookies and WebSocket. Clearing proxy settings keeps paired remote devices.

See [Compatibility](#compatibility) for the supported components and platforms. Locally managed programs, credentials and settings can be removed from the panel; VPS files require separate cleanup through the corresponding guide.

</details>

### Experimental iroh connection

Since plugin 0.7.0, the experimental transport from [dsh-mobile-iroh](https://github.com/saya-ch/dsh-mobile-iroh) is integrated into this repository. Its computer component, native Android transport and full APK are maintained here. The standalone repository retains the design and prototype records; normal installation uses this project's plugin and App, without maintaining two Apps. See the [iroh guide](docs/IROH.en.md) for setup, platform limits and troubleshooting.

## Extend and customize

Type `/mobile <what you want>` in a DSH conversation to hand the request to the current agent. Changed customization resources are usually picked up within a few seconds. For example:

```text
/mobile turn the phone UI into an old CRT terminal, with messages scrolling like terminal output
```

It can also drive computer capabilities the phone can use, like reading the machine's live state:

```text
/mobile give the phone a cyberpunk-style computer monitor panel that shows live CPU, memory, and disk usage
```

Two kinds of changes are supported: the phone UI itself (theme, layout, buttons), and computer capabilities the phone can use (browsing computer files, running programs on the computer). `/mobile` hands the request to the DSH agent, which edits files under the local DSH configuration directory (`$DSH_HOME/mobile-access/`); paired mobile pages automatically check and apply them. UI changes live in `mobile.css`/`mobile.js`. Computer capabilities come from extensions under `extensions/`, whose `host.mjs` runs with the local user's privileges on the computer. DeepSeek Harness source is not modified.

Open customizations through the **Mobile Access pairing entry**. Opening an ordinary DSH page or selecting a phone-sized browser viewport is not mobile pairing, and a file's presence does not establish that the current page loaded it. If extension requests return `401`, check the entry and pairing state; do not enable anonymous access or share Cookies or Tokens.

An old `mobile.css` patch can override a newer built-in fix. Back up that file and compare the same session, orientation and font settings with and without its styles before adding more rules. Scope CSS Modules selectors to an inspected ancestor, such as `[data-dsh-mobile-header] [class*="_titleRow"]`, rather than matching bare class suffixes/substrings across the page. Hiding an action area with `display: none` removes access to its controls; it is not a collapsible presentation. Thanks for the controlled comparison in [#219](https://github.com/saya-ch/dsh-mobile/issues/219).

Extension manifests, scripts, styles, and assets are revisioned. When the plugin observes a `/mobile` or extension-file change, it notifies authenticated phones to refresh immediately; 45-second visible and 5-minute hidden checks remain only as recovery fallbacks. A failed Host staging pass keeps the current version; if the Host has changed but the new phone UI cannot activate, that extension closes and retries instead of mixing generations.

An extension action's `input` may use a callable Schemastery schema such as `api.schema.object(...)` or an adapter with `parse(value)`; mobile `api.host.invoke()` sends JSON explicitly, and the input is validated and normalized before the computer-side action runs.

Prefer DSH's built-in file upload for attachments. If an extension must simulate a drop, its `dataTransfer` needs iterable `items` (file items) as well as `files`; a `files` array alone is insufficient. Some WebViews have incomplete native drag-and-drop constructors; see the [plugin's file-delivery implementation](https://github.com/saya-ch/dsh-mobile/blob/main/src/native-mobile.ts) for compatibility handling. An accepted `dragover` or successfully dispatched event does not confirm attachment delivery: check the composer's attachments and previews.

The 0.6.3 release adds optional [Worker execution](docs/EXTENSION_WORKERS.en.md) for trusted local JavaScript hosts. It is disabled by default, selectable by extension, and recovers explicitly without replaying interrupted actions. It is not a permission sandbox and does not require a matching App version.

<sub>You can even use an extension to connect to SillyTavern running on the same computer, give it a lightweight mobile frontend, and open it from the same app.</sub>

> `host.mjs` has the same privileges as a local program. Create and run only computer-side extensions that you understand and trust.

The examples above, applied:

<p align="center">
  <img src="https://raw.githubusercontent.com/saya-ch/dsh-mobile/main/assets/screenshots/crt-terminal-2.png" width="22%" alt="Mobile UI customized into an old CRT terminal">
  <img src="https://raw.githubusercontent.com/saya-ch/dsh-mobile/main/assets/screenshots/crt-terminal-1.png" width="22%" alt="Mobile UI customized into an old CRT terminal">
  <img src="https://raw.githubusercontent.com/saya-ch/dsh-mobile/main/assets/screenshots/cyberpunk-monitor-2.png" width="22%" style="margin-left:10px" alt="Mobile UI customized into a cyberpunk computer monitor">
  <img src="https://raw.githubusercontent.com/saya-ch/dsh-mobile/main/assets/screenshots/cyberpunk-monitor-1.png" width="22%" style="margin-left:8px" alt="Mobile UI customized into a cyberpunk computer monitor">
</p>

## Device management

The Android app lists computers and their LAN/remote records under **Paired computers**. The two authorization types remain separate, so one computer can have two rows. Upgrades migrate old credentials without re-pairing; after a changed address is verified, matching identities merge and keep their names. Self-signed FRP uses a separate CA fingerprint and may create another row. Android Keystore encrypts tokens and pinned CAs. A pairing QR code contains temporary pairing information, never a long-lived device token or CA private key.

Unless an identifier is configured manually, new pairings through a public-certificate remote entry use a random identifier saved on the computer, preventing identical installation paths from overwriting another computer's row. Working connections need no re-pairing or Android App update; LAN and self-signed FRP still use their respective CAs. Quit DSH normally and restart after updating; read the [state-backup precautions](SECURITY.md#installation-identity-and-device-state-upgrades) before downgrading.

Each row shows its custom name, transport, Origin, periodically refreshed reachability, and last connection time. A green dot means **Reachable**; a gray dot means **Checking**, **Temporarily unreachable**, **Pairing expired**, or **Removed on computer**. The check validates the DSH Gateway over HTTPS instead of using ICMP, so a temporary network outage is not mistaken for computer-side revocation.

- **Startup behavior → Open DSH directly** (default): one device connects directly; with multiple devices, the app tries the last-used device first, then the still-valid device with the most recent connection. A bounded connection budget returns to the list instead of spinning forever.
- **Startup behavior → Show device list**: choose a computer on every launch, which is useful when switching between several machines. Open the list's top-right **Settings → Startup behavior**; changes are saved immediately.
- Tap a row to connect. The overflow button and long press open the same action sheet for rename, check now, pair again, or delete the local record. Deletion has a second confirmation and a short undo window; undo restores only the local row and never restores a computer-side revocation.
- Open DSH **Settings → General → Switch computer** in the WebView to return to the list. An online computer-side revocation keeps the row as **Removed on computer**, stops reconnection and offers re-pairing or local deletion.
- **Added in 0.6.0**: fixed order, new computers appended, and migration of the previously visible order. **Move up / Move to top** save the arrangement independently from startup selection. Inside the app, hold the top-left drawer toggle to return to the list; a normal tap still toggles the drawer. Browsers have no such native action.

With App 0.6.7 and plugin 0.6.16, open the list's **Settings → Automatic same-computer connection** to choose **Manual** (default), **Detect and ask**, or **Automatic switch and notify**. Pair the computer's LAN and remote entries separately. Automatic mode transfers only eligible plain-text drafts in the current Session, not full page state; attachments, references or pending operations require confirmation. See the [App switching guide](apps/mobile/README.md#automatic-same-computer-connection).

Revoking a device permanently deletes its durable record and token digest instead of retaining a `revokedAt` tombstone. Startup also removes legacy revoked rows. A deleted token receives `401 authentication_failed`, just like an unknown token. Existing apps checking a device that was revoked while offline may therefore show **Pairing expired** and require pairing again; online Sessions still receive the revocation notification and disconnect immediately.

<table>
  <tr>
    <td align="center" valign="top" width="50%">
      <img src="https://raw.githubusercontent.com/saya-ch/dsh-mobile/main/assets/screenshots/device-management.jpg" width="44%" alt="Paired computer list in the Android app"><br>
      <sub>Device management: paired computers, transport, and reachability</sub>
    </td>
    <td align="center" valign="top" width="50%">
      <img src="https://raw.githubusercontent.com/saya-ch/dsh-mobile/main/assets/screenshots/startup-behavior.jpg" width="44%" alt="Startup behavior settings in the Android app"><br>
      <sub>Startup behavior: open DSH directly or show the device list</sub>
    </td>
  </tr>
</table>

## Third-party plugin compatibility

Version 0.5.3 includes the independently switchable `dsh-mobile-question-fixes` component, enabled by default. Disable it in DSH's plugin component list to restore the stock card immediately. Long questions, options, and footer actions share one bounded scroll area, and collapsed titles show up to two lines. Touch Enter retains its newline in phone browsers; the Android app applies this behavior only when its software keyboard is open and no hardware keyboard is connected. DSH continues to own answer drafts, with no additional copy in browser localStorage.

DSH Mobile keeps the Workspace, task-management, terminal and file-panel entry points; DSH still loads third-party plugins. The mobile layer adapts layout and access without changing DSH source. A particular plugin's usability on a small screen still depends on its own layout and interactions.

A third-party plugin must work in DSH Web and use reachable HTTP/WebSocket interfaces. The mobile layer cannot guarantee a phone layout for every plugin or replace a desktop-native window required by that plugin.

A skin tied to stock layout containers may not mount its backgrounds or decorations in the dedicated mobile layout. Mobile page module settings can omit an optional skin on this device without uninstalling the computer plugin; see [skins and mobile layout](docs/SKIN_COMPATIBILITY.en.md) for theme behavior and diagnosis.

### WebSocket approval

- The gateway allows first-party DSH WebSocket paths by default, including `/sidebar/ws/terminal`. Other paths used by community sidebar plugins are blocked by default and appear in Diagnostics; the `/sidebar/ws/agent-opens` and `/sidebar/ws/agent-terminals` paths in the image are examples that must be reviewed for the actual plugin.
- In **Connection diagnostics → Third-party WebSocket paths**, select **Allow** only for an exact path you have verified. Query strings and fuzzy prefixes are rejected; **Allow all** is not recommended. Approved paths can be removed at any time, and the same policy applies to LAN and remote connections.
- Approval only lets that path pass through the authenticated, same-origin DSH Mobile gateway. It does not open arbitrary TCP/UDP ports or bypass device pairing. If a community plugin still fails, check the path recorded by Diagnostics and approve one path at a time.

If another remote-access plugin shows its own “not paired” page inside DSH Mobile, the two authorization systems are separate. Temporarily turn off the other plugin's remote access on the computer to check whether the Mobile path recovers; do not enter a DSH Mobile pairing key on that page. Excluding its client module below does not necessarily remove a request-rewriting script injected before client boot. See [#111](https://github.com/saya-ch/dsh-mobile/issues/111).

Allowing HTTP frames in the gateway does not make every client load them: the content is unencrypted, Android still blocks HTTP mixed content inside HTTPS pages, and browsers may block it too. Prefer HTTPS. The remote panel shows this risk when opened through an HTTPS administration entry.

### Optional modules and advanced configuration

Version 0.6.0 adds [mobile page module settings](docs/CLIENT_MODULES.en.md) for computer defaults and device choices without uninstalling plugins. Changes apply on the next manual open, not an automatic conversation reload; an outdated saved selection offers an explicit recovery action.

<details>
<summary>Configure excludedClientModules in the profile</summary>

Advanced users can reduce mobile startup traffic by adding exact package ids to `excludedClientModules` in the current profile's `mobile-access` plugin configuration, then restarting DSH. This changes only the dedicated mobile page served through the gateway; desktop and `?frontend=stock` pages are unaffected. If both packages are present in the current boot graph, this example removes document preview and its dependent “Open In…” feature:

```yaml
excludedClientModules:
  - '@deepseek-ai/dsh-client-ui-sidebar-documentpreview'
  - '@deepseek-ai/dsh-client-ui-open-in-app'
```

There is no default exclusion list. The plugin rejects unknown or boot-critical modules and modules still referenced through `inject` or `external` by retained entries. If a DSH or community-plugin update invalidates the selection, the mobile page returns `409 excluded_client_modules_invalid` with the conflicting module; the computer also warns so you can adjust or remove the option. Bundle sizes and dependencies change between DSH installations and versions; another user's savings are not a prediction for yours.

Selection priority is device choice → computer defaults → plugin configuration. See the [module guide](docs/CLIENT_MODULES.en.md) for application and recovery rules.

</details>

<table>
  <tr>
    <td align="center" valign="top" width="50%">
      <img src="https://raw.githubusercontent.com/saya-ch/dsh-mobile/main/assets/screenshots/third-party-plugin-adaptation.png" width="96%" alt="Android app wide layout with a community sidebar plugin adapted"><br>
      <sub>Community sidebar plugin compatibility in the Android app</sub>
    </td>
    <td align="center" valign="top" width="50%">
      <img src="https://raw.githubusercontent.com/saya-ch/dsh-mobile/main/assets/screenshots/websocket-diagnostics.png" width="96%" alt="Third-party WebSocket path diagnostics in the Android app"><br>
      <sub>Connection diagnostics: review and allow third-party WebSocket paths</sub>
    </td>
  </tr>
</table>

## App or mobile browser

| Client | Best for | Notes |
| --- | --- | --- |
| Android app | Everyday use | Separate Local and Remote entries at first pairing; LAN discovery, system trust for public remote certificates, and app-pinned CA for the self-signed FRP entry |
| iPhone/iPad Safari or Home Screen web app (PWA) | Everyday iOS access and optional push | [Pair in Safari and add a Home Screen icon](<#iphone-and-ipad-home-screen-web-app-pwa>); no native iOS app. Capable Home Screen apps can enable [Web Push](docs/WEB_PUSH.en.md) |
| Mobile browser | Everyday or cross-platform access | Open the HTTPS origin shown by Mobile Access; a private LAN certificate may need confirmation, while a public remote certificate should not warn. Continuing through a certificate warning does not make the page eligible for Web Push |

The Android app is a thin Kotlin WebView shell and contains no frontend copy; mobile browsers load the same page. Developers can append `?frontend=stock` to an authenticated mobile URL to diagnose boot and layout behavior. This entry skips dedicated mobile boot rewriting and module selection, but installed client adaptation and authenticated customizations may still apply. It is not a plugin-free control; some API operations may be rejected, so it does not replace normal mobile access. See [skins and mobile layout](docs/SKIN_COMPATIBILITY.en.md).

The dedicated mobile page synchronously loads the authenticated, same-origin `/mobile-access/compat.js` before the first DSH boot script. This bundled compatibility layer supplies missing `Iterator` / Iterator helpers, `Promise.withResolvers` and `AbortSignal.any`. It uses feature detection to preserve or repair native implementations, needs no CDN, and does not weaken CSP. The desktop and `?frontend=stock` pages do not load this gateway script. On WebViews that support document-start injection, the Android App also supplies `Promise.withResolvers` early for the paired exact Origin.

**Old-engine limits**: API shims cannot repair JavaScript syntax an engine cannot parse. The published **DSH 0.2.1-rc.2** frontend contains class static blocks, which Chromium **92** cannot parse. This syntax became enabled by default in Chrome 94, but that does not establish full DSH compatibility on 94. [V8 announcement](https://v8.dev/blog/v8-release-94). The App's below-100 advisory is not a compatibility guarantee; choosing Continue does not make the current DSH runnable. If system WebView cannot be updated, use a phone browser already confirmed to work with the computer's mobile address, without clearing existing App pairings.

The current plugin retains the 0.6.12 compatibility layer and startup feedback, alongside 0.6.13's Gateway receive-timeout/header-size classification and packed text/image prompt-failure checks. It does not transpile or modify DSH, and it does not automatically replay messages; acceptance on the physical Huawei Chromium 92 App remains unverified. Reports should include DSH/plugin/App and WebView versions, entry mode and the first redacted console error, never tokens or complete pairing URLs.

> **Community client (unofficial)**: [WeChat Mini-Program client](https://github.com/StrawberryAO/dsh-mobile-minapp)
> A native WeChat Mini-Program that reuses the Mobile Access pairing and Remote stream protocol (requires dsh-mobile ≥ 0.3.8).
> Because WeChat release builds enforce a domain allow-list (ICP-registered HTTPS origins only), it currently works via WeChat DevTools / real-device debugging; see its README.

## How it works

```mermaid
flowchart LR
  Phone["Android / mobile browser"] -->|"LAN HTTPS"| Lan["LAN gateway"]
  Phone -->|"remote HTTPS"| Remote["separate remote gateway"]
  Lan --> Gateway["DSH Mobile Gateway Core"]
  Remote --> Gateway
  Gateway -->|"loopback proxy"| DSH["Stock DSH Web and Host"]
  DSH -->|"same workspace, sessions and event stream"| Phone
```

Three layers: the Host face for discovery, pairing, HTTPS, loopback proxying, and extension registration; the Client face for the dedicated mobile layout and extension SDK; and the Android app for a narrow native bridge. The bridge uses `androidx.webkit` WebMessage, verifies the exact top-level origin and main frame on every bounded message, and never uses `addJavascriptInterface`. The plugin does not rewrite source or webpage files in the DeepSeek Harness installation. Its mobile gateway serves the startup compatibility layer and dedicated layout per request; installation and removal use the plugin mechanism. The upstream DSH Web port defaults to 3080 and is configurable through `dsh web --port`.

## Security

- Use the LAN listener only on a trusted home, office, or hotspot network; do not add your own port forwarding.
- A remote origin is publicly reachable, but unpaired requests cannot enter DSH; turn the remote switch off when it is not needed.
- cpolar downloads a pinned official build only after confirmation and verifies its size and SHA-256. It installs no system service, PATH entry, or startup task, and plugin cleanup removes its managed files.
- cloudflared likewise downloads a pinned build from the official GitHub Release only after confirmation and verifies the exact size and SHA-256, and it launches the client with automatic updates disabled so the running binary is always the verified one. A quick tunnel needs no account, token, or DNS record; a named tunnel token is stored only in the plugin private directory and reaches cloudflared through the environment, and cleanup deletes every file it manages.
- Managed Caddy downloads a fixed component reviewed and published by DSH Mobile, only after confirmation, and checks its size, SHA-256, core and DNS module versions. DNS credentials and certificates stay in a private directory; no system service, PATH entry or system trust certificate is added. Removing the component preserves other channels and paired devices.
- Self-hosted FRP downloads pinned official `frpc` only after confirmation and verifies the origin, exact size, SHA-256, archive paths, and executable version. The shared token never appears in status, diagnostics, or attachment-plan responses. Copying a server template, or explicitly copying a token-bearing attach config after re-entering its token, places it on the system clipboard; clear it after use. Local cleanup removes only plugin-managed files. Managed VPS deployments require separate uninstall-script or one-click cleanup; attaching to an existing frps neither changes nor cleans up that VPS. Automatic deployment and server cleanup require SSH host-key verification against the VPS console.
- A paired device is a fully trusted DeepSeek Harness operator and can run tools on the computer; revoke lost devices from the computer.
- The mobile gateway proxies requests as a local DSH operator and supports `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, and `DELETE` on ordinary plugin routes; writes still require a paired Session, exact Origin, and CSRF validation. Third-party plugins must not treat the upstream loopback Host as proof that the client is physically local to the computer.
- The LAN gateway listens only while Mobile Access is enabled; with it off, DSH keeps running normally on the computer.

See [SECURITY.md](SECURITY.md).

## Troubleshooting

- **Pairing a second computer overwrites the first**: see [#213](https://github.com/saya-ch/dsh-mobile/issues/213). Update to plugin 0.6.8 or newer, restart DSH normally, then scan each affected computer's current QR code. An App credential already overwritten cannot be recovered automatically; working old rows need no re-pairing. If the same address has both an old and a new row, confirm the new one works, then delete only the extra local App row. Do not reset remote access. Read the [device-state backup and downgrade precautions](SECURITY.md#installation-identity-and-device-state-upgrades) before upgrading.
- **Pairing succeeds but renewal returns `401` or repeatedly asks to pair again**: other services on the same hostname or stale Cookies may interfere with authentication. Update to the latest plugin and app, then retry through the current Mobile Access entry. In a browser, scanning the current QR code again refreshes this plugin's authentication Cookies without clearing all website data. If it still fails, inspect the failed request and sanitized logs; other authentication or proxy errors can also return `401`.
- **The testing notice cannot be confirmed or settings cannot be saved**: open DSH directly at its local address on the computer, then inspect the terminal log or the failed settings request in the browser's Network panel. Connection diagnostics do not test settings writes. Keep the existing configuration and `settings.yaml.imported`, and investigate the specific error; the same UI message can have different causes. See [DSH #860](https://github.com/deepseek-ai/deepseek-harness/discussions/860).
- **A settings request returns HTTP `403`**: first inspect DSH's Host/Origin trust checks and any proxy response. Check whether an iframe, proxy, or browser extension changes the request's origin, and verify direct local access. Keep the trust checks enabled.
- **The error contains `profile reload requires the root Include entry`**: this error occurs while DSH reloads the profile. [Issue #132](https://github.com/saya-ch/dsh-mobile/issues/132) reports it after two copies of `dsh-app-boot` were loaded, but the message alone does not establish that cause. Compare the versions and installation paths used by the running DSH command and the active profile; keep the configuration and follow the [official DSH documentation](https://deepseek-harness.github.io/deepseek-harness/) to repair the dependencies. If it still fails, report the versions, module paths, and full sanitized error upstream.
- **The settings error contains `EACCES`, `EPERM`, or a lock-file failure**: inspect the reported file's permissions and any file-operation tools injected into the launch environment. Lock cleanup can fail after a write, so check what was actually saved.
- **The phone shows another plugin’s pairing-code page**: `dsh-remote-web-ui` and DSH Mobile have separate remote channels and pairing codes; they cannot be mixed. If DSH Mobile diagnostics warn about a competing remote plugin, turn off that plugin’s remote access on the computer, refresh, and scan the current DSH Mobile QR code. Merely installing the other plugin without enabling its remote channel does not trigger this warning.
- **Windows initialization waits on permissions or fails**: `sid-query` identifies the current-account SID lookup and `acl-apply` identifies private-file permission setup; failures also report the full wait duration for that stage. Do not disable permission checks or make sensitive files readable by everyone. Share the redacted stage, duration, error code and DSH version for diagnosis. These diagnostics do not establish a fix for the startup-contention problem in [#128](https://github.com/saya-ch/dsh-mobile/issues/128).
- **Remote diagnostics say “reachable through the computer's proxy”**: the check tries a direct request first, then an HTTP proxy from the DSH process environment only if direct access fails; `NO_PROXY` may exclude the target. This proves only that the computer completed an HTTPS probe through the proxy, not that the phone or actual tunnel can connect. Test from the phone's mobile network. If both paths fail, diagnostics continue to report the endpoint unreachable instead of treating an offline route as ready.
- **LAN access stops after switching networks**: if the log reports `saved LAN interface "XXX" is not connected`, the saved adapter is unavailable. DSH keeps running while Mobile Access stays dormant and retries when the adapter returns. If you have moved to a different adapter, configure LAN again or re-run `setup`. If mobile access is not needed, disable `mobile-access` in `cordis.patch.yml`.

## Compatibility

The plugin retains DSH host peer declarations without rejecting installation or startup solely by DSH version. If mobile access breaks after a DSH update, update the plugin and check the verified scope below. An installable version does not establish that every feature is compatible. Release history lives in [CHANGELOG.md](CHANGELOG.md).

### OS support matrix

This table describes the **computer running the plugin**, not the phone's OS; iPhone/iPad access uses the [browser/Home Screen route](<#iphone-and-ipad-home-screen-web-app-pwa>).

| Channel | Windows x64 | Linux x64 | Linux arm64 | macOS |
| --- | --- | --- | --- | --- |
| Local network | Yes (firewall automated) | Yes (open the firewall yourself) | Yes | Yes |
| Tailscale Funnel | Yes (bundled) | Yes (bundled) | Yes (bundled) | No |
| cpolar | Yes (on-demand) | Yes (on-demand) | Yes (on-demand) | No |
| cloudflared quick/named tunnel | Yes (on-demand) | Yes (on-demand) | Yes (on-demand) | Yes, x64/arm64 (on-demand) |
| Self-hosted FRP | Yes (on-demand) | Yes (on-demand) | Yes (on-demand) | Yes (on-demand) |
| Own reverse proxy | Yes (config only) | Yes (config only) | Yes (config only) | Yes (config only) |
| Managed Caddy | Yes (on-demand) | Yes (on-demand) | No | No |
| iroh (Experimental) | Yes (on-demand) | Yes (on-demand) | No | No |

On macOS, local network, cloudflared, self-hosted FRP and the own reverse proxy work; Funnel and cpolar have no managed macOS component yet. The diagnostics firewall check currently covers Windows only and reports “not applicable” elsewhere.

| DSH Mobile plugin | Verified DeepSeek Harness version |
| --- | --- |
| `0.8.0` | Push public-contract, settings, encrypted-payload and tap-ownership checks are pinned to `0.2.1-rc.2 / rc.3`; see [CI](https://github.com/saya-ch/dsh-mobile/actions/workflows/ci.yml) for the general boot/layout matrix. iOS device results accept contributor testing; browser checks do not establish every phone, plugin or public route |

<details>
<summary>Earlier release checks</summary>

| DSH Mobile plugin | Verified DeepSeek Harness version |
| --- | --- |
| `0.7.1` | Isolated packed installation, mobile sidebar and breakpoint hit tests on `0.2.1-rc.3`, plus access-panel, pairing-expiry and component-cleanup checks |
| `0.6.11` | Isolated packed-browser CI on `0.1.7-alpha.2`, `0.1.7-rc.1`, `0.1.7-rc.2`, `0.2.0-rc.1`, `0.2.0-rc.2`, `0.2.1-alpha.2` and `0.2.1-alpha.3`; additional real history-pagination, viewport-preservation and manual-loading checks on `0.2.0-rc.2` and `0.2.1-alpha.3`. Browser checks do not establish acceptance of every phone engine, third-party plugin or public route |
| `0.6.12` | Packed installation, mobile boot, missing-API simulation, Workspace streaming, retained-page transport recovery and mobile settings on `0.2.1-rc.2`; authentication/resource regression with the actual community `dsh-web-startup-auth@0.1.12` on `0.2.0-rc.2`. This does not establish physical Chromium 92, arbitrary auth-plugin or public-route acceptance |
| `0.6.13` | Packed text/image HTTP 400 recovery, Host refusal guard and error-feedback checks on `0.2.0-rc.2` and `0.2.1-rc.2`; Gateway 408/431 classification, bounded diagnostics and four Gateway factory wiring passed local tests. DSH source, iroh P2P and Android native code are outside this release |
| `0.6.14` | Release CI packed-browser jobs green on all eight DSH versions from `0.1.7-alpha.2` to `0.2.1-rc.2`; no additional per-version manual acceptance was recorded for this release |
| `0.6.15` | `0.2.1-rc.2`: real admin-panel pairing in Firefox 158 privacy mode, the HTTPS mobile page and Workspace-read baseline, and silent Blob playback; release CI green on all eight versions |
| `0.6.16` | `0.2.1-rc.2`: Gallery selection, plain-text draft transfer through public DSH input APIs, real mux recovery and cross-client pending questions; CI additionally covered `0.1.7-alpha.2`, `0.1.7-rc.1`, `0.1.7-rc.2`, `0.2.0-rc.1`, `0.2.0-rc.2`, `0.2.1-alpha.2` and `0.2.1-alpha.3` |
| `0.6.17` | `0.2.0-rc.2` and `0.2.1-rc.2`: 15 real packed Chromium directory-picker checks, the old-WebView missing-API simulation and Workspace mux reads; the published package was then installed into official Desktop `0.2.1-rc.2` and its files matched byte for byte |
| `0.6.18` | `0.2.1-rc.2`: 18 real packed Chromium directory-picker checks, including compact layout, folder creation and cancellation; the candidate was installed in local official Desktop `0.2.1-rc.3` with LAN and Cloudflare gateways running |
| `0.7.0` | Packed-browser CI across eight DSH versions (`0.1.7-alpha.2`–`0.2.1-rc.2`), Windows/Linux Gateway and iroh Host checks, both Android ABIs and compatibility APK checks. See the [iroh guide](docs/IROH.en.md) for device and network limits |

| DSH Mobile plugin | Verified DeepSeek Harness version |
| --- | --- |
| `0.6.8` | Packed mobile boot, legacy-WebView API simulation, WebSocket Workspace reads, mobile settings, module management, sidebar and composer regressions on `0.2.1-alpha.3`; separate real HTTP/TLS and legacy-credential upgrade tests cover the identity fix. The local official Desktop `0.2.0-rc.2` loads this plugin version with existing pairings preserved. This does not establish phone cellular or every third-party plugin combination |
| `0.6.6` | Packed attachment intake and decoded-preview regressions on `0.2.0-rc.2` and `0.2.1-alpha.2`, covering multiple images, cancellation, late results and superseded requests. Android system-picker changes are released independently, not through the npm update |
| `0.6.5` | Packed module-management and mobile-settings regressions on `0.2.0-rc.2` and `0.2.1-alpha.2`; additionally Windows cpolar extraction and populated Trajectory layout with published `maid-atelier` 0.1.7. This does not establish acceptance of every third-party skin or reporter device |
| `0.6.4` | `0.2.0-rc.2` (packed installation, isolated pairing, mobile boot and WebSocket Workspace reads); additionally 72 real public-slot composer layouts, Windows Desktop directory-picker composition and cross-platform regressions. The reported remote timeout in community Desktop 2.0.17 remains unclaimed as accepted |
| `0.6.3` | `0.2.0-rc.2` and `0.2.1-alpha.2` (packed installation, isolated pairing, mobile boot and WebSocket Workspace reads); additional checks cover the composer, settings and extension Worker timeout, streaming and explicit recovery |
| `0.6.2` | Packed legacy-WebView boot, touch scrolling and missing-API/viewport negative controls passed on `0.2.0-rc.2`, with release CI passing. The reporter's physical old devices in #187 were not claimed as accepted |
| `0.6.0` | `0.1.7-alpha.2`, `0.1.7-rc.1`, `0.1.7-rc.2`, `0.2.0-rc.1` and `0.2.0-rc.2` (packed installation, pairing, mobile-page boot and WebSocket Workspace reads); additional checks cover the mobile composer, module settings and component loading after a normal official Desktop restart |
| `0.5.5` | `0.1.7-alpha.2`, `0.1.7-rc.1`, `0.1.7-rc.2`, `0.2.0-rc.1`, and `0.2.0-rc.2` (npm installation, isolated pairing, mobile-page boot, and WebSocket Workspace baseline) |
| `0.5.4` | `0.1.7-alpha.2`, `0.1.7-rc.1`, `0.1.7-rc.2`, `0.2.0-rc.1`, and `0.2.0-rc.2` (npm installation, isolated pairing, mobile-page boot, and WebSocket Workspace baseline) |
| `0.5.3` | `0.1.7-alpha.2`, `0.1.7-rc.1`, `0.1.7-rc.2`, `0.2.0-rc.1`, and `0.2.0-rc.2` (source contract, npm installation, isolated pairing, mobile-page boot, and WebSocket Workspace baseline) |
| `0.5.2` | `0.1.7-alpha.2`, `0.1.7-rc.1`, `0.1.7-rc.2`, and `0.2.0-rc.1` (carried forward from earlier verification); `0.2.0-rc.2` (source contract, isolated pairing, mobile-page boot, and WebSocket Workspace baseline) |
| `0.5.1` | `0.1.7-alpha.2`, `0.1.7-rc.1`, `0.1.7-rc.2`, and `0.2.0-rc.1`; official Desktop `0.1.7-rc.2` (administration surface) |
| `0.5.0` | `0.1.7-alpha.2`, `0.1.7-rc.1`, and `0.1.7-rc.2`; official Desktop `0.1.7-rc.2` (administration surface) |
| `0.4.7` | `0.1.7-alpha.2`, `0.1.7-rc.1`, and `0.1.7-rc.2` (source contract, isolated pairing, and workspace baseline over WebSocket) |
| `0.4.6` | `0.1.7-alpha.2` and `0.1.7-rc.1` (source contract, isolated pairing, and workspace baseline over WebSocket) |
| `0.4.5` | `0.1.7-alpha.2` (source contract check, local and remote gateway integration) |
| `0.4.4` | `0.1.6-alpha.2` (local source and renderer-v2 contract check) |
| `0.4.3` | `0.1.6-alpha.2` (local source and renderer-v2 contract check) |
| `0.4.2` | `0.1.6-alpha.1` (local source and renderer-v2 contract check) |
| `0.4.1` | `0.1.6-alpha.1` (local source and renderer-v2 contract check) |
| `0.3.15`, `0.3.16`, `0.4.0` | `0.1.5-rc.2` (contract check); `0.1.5-rc.1` (@idoall LAN verification) |
| `0.3.14` | `0.1.3-alpha.2` |
| `0.3.9`-`0.3.12` | `0.1.3-alpha.1` |
| `0.3.6`-`0.3.8` | `0.1.2-rc.1` |
| `0.3.4`, `0.3.5` | `0.1.2-alpha.2` |
| `0.3.0`-`0.3.3` | `0.1.2-alpha.1` |
| `0.1.4`, `0.2.x` | `0.1.1-rc.2` |

</details>

Existing apps (0.3.3 and later) do not need re-pairing. cpolar users should use app 0.3.15 or later because earlier apps may time out before a slow first load over the free route finishes; earlier apps also use a different status-bar strategy. The 0.4.0 app adds the multi-device list, startup behavior, and computer-side revocation status; older apps continue to connect to their saved single device. App 0.1.3 or earlier requires reinstalling and pairing again.

See the [App guide](apps/mobile/README.md) for native release versions and changes. Package identity, signing and the pairing/renewal protocol remain compatible without requiring re-pairing. Plugin and app version numbers do not need to match; connections check protocol and minimum-version requirements. Features with additional native requirements state the app version they need.

GitHub Release APKs use a stable signing certificate, so an older official APK with the same signer can be upgraded in place while retaining pairings. A locally built Debug APK with a different signer cannot be overwritten by the official APK; plan to pair again when switching between them.

## Uninstall

Choose one of the two Web-profile paths below. In official DSH Desktop, uninstall the plugin from the app's **Plugins** page. Uninstalling the package alone leaves certificates, pairing records, and custom files under `$DSH_HOME/mobile-access/` intact.

Remove only the plugin and keep local data:

```powershell
dsh plugin --profile web remove dsh-mobile
```

To remove local plugin data as well, first back up extensions and custom files you want to keep. **Run `purge --yes` before removing the plugin**; do not run the preceding remove-only command first. `purge` deletes the entire `$DSH_HOME/mobile-access/` directory and the plugin's Windows firewall rules, but it does not remove VPS files.

```powershell
dsh plugin --profile web exec dsh-mobile purge --yes
dsh plugin --profile web remove dsh-mobile
```

Source users replace `dsh` with `pnpm dsh`.

## Contributors

Thanks to everyone who submitted PRs, reproduced issues, or proposed improvements. [The contributors list](CONTRIBUTORS.md) credits merged PRs, PR work later incorporated without a direct merge, and issue reports separately. GitHub's sidebar Contributors panel is generated from commits on the default branch and cannot be manually extended with issue-only contributors.

## Development

```powershell
npm ci
npm run verify
```

Use `npm run check:docs` for quick documentation checks. [CONTRIBUTING.md](https://github.com/saya-ch/dsh-mobile/blob/main/CONTRIBUTING.md) covers behavior-specific browser tests, isolated packed DSH acceptance, captures and release steps; the [Android manual](apps/mobile/README.md#build) covers app builds. Do not substitute real user profiles or official app data for test fixtures.

Licensed under [Apache-2.0](LICENSE).
