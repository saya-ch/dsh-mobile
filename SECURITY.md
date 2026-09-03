# Security policy

`dsh-mobile` exposes a control surface that can run tools on the host computer. Treat every paired device as security-sensitive.

## Supported versions

Security fixes target the newest stable release. Prereleases receive fixes only when the corresponding GitHub Release says they are supported. The README compatibility table identifies the exact DSH release tested with each plugin version.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability-reporting form for `saya-ch/dsh-mobile`. Include the affected version, deployment topology, reproduction steps, and whether a device credential, session Cookie, or local access is required.

The maintainer will acknowledge a complete report within seven days. Publication timing is coordinated with the reporter after a fix and a revocation or upgrade path are available.

## Deployment requirements

- Keep the ordinary DSH Web listener on loopback.
- Expose only the plugin-owned HTTPS listener to the LAN.
- DNS-SD/mDNS, periodic UDP announcements, active UDP query replies, and HTTPS discovery return only the device name, public HTTPS origin, port, protocol version, and stable non-secret installation identifier. Discovery never returns the CA, a pairing key, a device token, Cookies, credentials, or private configuration.
- For LAN pairing, only after a user selects a device and enters the fingerprint-bound pairing key may Android fetch the public CA from that exact HTTPS origin. The bootstrap GET sends no key or credential. The app retains the CA in its encrypted credential record and never adds it to Android's system trust settings. Native requests use a private trust store; WebView accepts only the otherwise-untrusted leaf signed by that CA, for the exact origin and validity period. Every other TLS error is cancelled.
- Public remote origins provided by Funnel, cpolar, or self-hosted FRP use platform-trusted HTTPS. Android stores no private CA for those credentials and cancels every TLS error. Browser clients likewise require a certificate trusted by their platform.
- Keep pairing closed except during a short local onboarding action.
- Revoke a lost device immediately and rotate the device registry if credential theft is suspected.
- Do not expose the LAN gateway through router port forwarding. Optional remote access uses a separate loopback gateway behind the selected Tailscale Funnel, cpolar, or self-hosted FRP path. The outer provider or Caddy terminates public TLS, while DSH pairing, device authentication, CSRF checks, and session revocation remain enforced by the plugin gateway.
- The Funnel node stores its Tailscale login state under `$DSH_HOME/mobile-access/remote/tailscale/`. The plugin does not request or store a Tailscale password, Auth Key, or OAuth secret.
- cpolar is downloaded only after confirmation from a pinned official artifact whose size and SHA-256 are verified. Its Authtoken is stored in a private, self-update-disabled configuration under `$DSH_HOME/mobile-access/`, never returned by the admin API or written to logs. Cleanup removes the managed executable, configuration, logs, and independent remote device registry.
- Self-hosted FRP accepts only a VPS address, frps control port, operator-generated high-entropy shared token, and standard-port public HTTPS origin. The plugin validates the token's length and format; the operator remains responsible for its entropy. It generates one HTTP vhost pointed at the plugin's ephemeral loopback gateway; arbitrary FRP configuration, TCP/UDP forwarding, FRP plugins, services, PATH entries, and startup tasks are not supported.
- The generated frps template binds its plaintext vhost to `127.0.0.1` and expects Caddy to provide public HTTPS. Before starting `frpc`, the plugin rejects a vhost port reachable through the configured VPS address. It reports readiness only when the public discovery response carries this computer's exact non-secret installation identifier.
- The FRP token stays in a private file under `$DSH_HOME/mobile-access/`, is never returned by status or diagnostic responses, and is never logged. Copying the generated server template intentionally places the token on the system clipboard and into the VPS configuration; clear the clipboard after use and protect the VPS file. The FRP cleanup action removes the managed `frpc`, local token, runtime configuration, staging files, and logs. Server-side artifacts are removed only through the reviewable uninstall script or the separately confirmed one-click VPS cleanup, both of which delete solely DSH Mobile-owned files, services, and tagged firewall rules.
- Automatic VPS deployment and one-click VPS cleanup first read the server's SSH host keys and require the operator to confirm every `SHA256:` fingerprint against the VPS console before any authenticated connection. All SSH/SCP channels pin `StrictHostKeyChecking=yes` to a temporary known_hosts file built from the confirmed keys; unknown, rotated, or extra keys abort the operation instead of being silently accepted. SSH credentials themselves are key-or-agent only, never passwords; the private key path is convenience state in the current browser profile, and key material is never uploaded or logged.
- Disabling remote access stops the selected provider process without affecting LAN access. Resetting remote access also removes provider state and the independent remote device registry.
- Treat every paired device as a fully trusted operator. Stock DSH methods reached through the authenticated loopback proxy may read configuration or run tools with the desktop user's authority.
- Treat `mobile.js` as application code with the paired page's same-origin authority. Restrict write access to trusted host-side DSH sessions and review generated API calls or browser-permission use.
- Treat every extension `host.mjs` as a local program with the desktop user's Node.js privileges. It is never sandboxed and is not editable through the mobile gateway; only place code there that you trust.
- Extension Actions and Routes receive filtered request data, a device identifier, and an abort signal. They cannot set proxy security headers or access the gateway's cookies, device tokens, CSRF tokens, or internal request headers.

## Known limitation

The current DSH HTML boot process contains inline JavaScript, revives Schemastery callbacks with `new Function`, and applies some styles dynamically. To keep the stock Web UI runnable, the gateway's Content Security Policy currently includes `script-src 'self' 'unsafe-inline' 'unsafe-eval'` and `style-src 'self' 'unsafe-inline'`. The remaining directives still restrict origins, connections, frames, objects, workers, images, and form targets, but this policy does not eliminate script-injection risk. Removing these allowances requires upstream DSH support for nonces, stable hashes, external boot resources, and a non-evaluating schema representation.

This repository never accepts private keys, npm tokens, pairing values, device credentials, Cookies, or captured settings in issues, logs, fixtures, or example configuration.
