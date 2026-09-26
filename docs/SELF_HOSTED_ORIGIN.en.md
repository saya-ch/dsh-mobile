# Own HTTPS reverse proxy

[中文指南](SELF_HOSTED_ORIGIN.md)

> This provider ships with the package from **0.4.2** on.

This provider appears under **Mobile Access → Remote → Self-hosted connection → Own reverse proxy**. It adds a separate authenticated private HTTP origin for an HTTPS reverse proxy you already own; it does not install a tunnel or manage your proxy, DNS, certificate, firewall, or router.

## Setup

- Public origin: `https://phone.example.com:8815` (HTTPS only, optional custom port, no path/query/fragment/credentials).
- Same computer: listen on `127.0.0.1:3444`, allow `127.0.0.0/8`.
- Separate LAN proxy: listen on the DSH computer's private IPv4, e.g. `192.168.50.10:3444`, and allow the proxy's actual direct source, e.g. `192.168.50.1/32`.
- Only explicit loopback/RFC1918 IPv4 binds are supported. Wildcard, public and IPv6 binds are rejected. The port must be 1024–65535 and may not be 3443 (the LAN gateway) or 3080 (DSH's own WebServer); note that 3444 is also the cloudflared named tunnel's default forward port. Source CIDRs must be canonical private/loopback networks, at most 16; prefer a single-host /32. Forwarded headers do not determine source authorization.

Select **Save and start backend**, then point the proxy at the displayed HTTP backend. **Never expose/port-forward that HTTP listener publicly**, and never bypass it by proxying to DSH's WebServer (default port 3080) or the LAN 3443 gateway. HTTP between separate devices is suitable only for a trusted private network. Pairing, authentication, normalized-exact Host/Origin enforcement, CSRF, Secure cookies and WebSocket path policy remain active. Do not open the plain HTTP backend in a browser to verify it: it only accepts requests proxied from the configured public HTTPS origin; direct access has the wrong Host, and its cookie/CSRF flow may fail.

## Proxy contract

Terminate public TLS with a trusted certificate on your proxy. Preserve the external **Host including the port** (`phone.example.com:8815`), Origin, cookies and authentication/CSRF headers; do not rewrite cookie security attributes or cache authentication responses. Forward WebSocket upgrades and bidirectional traffic.

[Lucky's Web module](https://lucky666.cn/docs/modules/web) supports WebSocket by default. Use **“使用请求Host” (request Host)** rather than **“使用目标地址Host” (target-address Host)**, and verify the external custom port survives. Certificates remain Lucky's responsibility. If the proxy is on another machine, configure routing and a source-restricted private firewall rule yourself; the plugin does not change either.

## Readiness, pairing and persistence

**Backend listening is not public readiness.** The provider and diagnostics make no public probe: check your domain, certificate, public port, pairing and WebSocket from the phone's intended external network. Use the existing Android **Remote access** QR flow on app **0.4.0 or later** for user-owned domains and custom HTTPS ports. App 0.3.16 rejects these pairings; no APK change is required for this provider. Local real-socket HTTPS/HTTP/WebSocket tests are not a substitute for testing your own proxy and phone.

Stopping retains settings and paired devices. **Clear proxy settings** stops only this listener and deletes only its configuration, after confirmation. The separate existing **reset remote devices** action removes shared remote pairings, but keeps proxy settings and LAN devices. Switching providers stops the previous remote provider without affecting LAN.

Under the default `$DSH_HOME/mobile-access/` root, settings live at `remote/origin/config/settings.json`, enabled state at `remote/origin/control.json`, and pairings continue to use `remote/devices.json`. Only the selected, enabled provider resumes on DSH restart. All addresses shown here are examples; supply your own configuration.

## More detail

The [Chinese guide](SELF_HOSTED_ORIGIN.md) carries the full field-by-field table, the Lucky checklist and a troubleshooting list; this English page is the condensed version.
