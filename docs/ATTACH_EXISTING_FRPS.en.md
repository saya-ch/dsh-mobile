# Attach to an existing frps

[中文指南](ATTACH_EXISTING_FRPS.md)

> **Requires plugin 0.4.6**; the self-signed entry also requires the 0.4.6 Android app. Android apps 0.3.3–0.4.5 can use the public-CA entry but not the self-signed entry.

Use this path when you already run frps on a public VPS. The plugin does not install, edit, or restart that frps and does not automatically change your Caddyfile; public-CA mode requires **you** to add a Caddy snippet and import. Inspect the server's listeners before choosing an entry mode. The panel's **Copy attachment plan** action only produces a masked local `frpc.toml` preview and VPS instructions; it neither connects to the VPS nor writes configuration. To copy a token-bearing local config, re-enter the token and explicitly click its copy button; a saved token is never returned to the page.

## Choose the HTTPS entry

| Entry | Public route | VPS requirements | Client trust |
| --- | --- | --- | --- |
| **Public CA** (`public-ip-cert`, default) | HTTPS 443 → Caddy → loopback HTTP vhost → FRP | Enter the real `vhostHTTPPort`; keep that plaintext listener on loopback. A domain uses Caddy-managed certificates; public IPv4 needs a short-lived Let's Encrypt IP certificate and operator-managed renewal. | Phone browsers and Android app 0.3.3+ use the platform trust store and still require DSH pairing. |
| **Self-signed passthrough** (`self-signed`) | HTTPS on `publicPort` (default 33080) → frps raw TCP proxy → computer-side HTTPS gateway | Use a globally routable public IPv4 address. The frps TCP listener must be publicly reachable; no new Caddy site, public certificate, or HTTP vhost is needed for this entry. | Requires the 0.4.6 Android app with remote CA pinning. Older apps cannot pair; ordinary phone browsers do not trust the self-signed certificate. |

frps `proxyBindAddr` is global to proxy listeners, not a per-entry switch. Binding it to `127.0.0.1` protects the HTTP vhost but also makes a TCP `remotePort` unreachable from the public network. Binding it publicly for the TCP entry may expose plaintext vhosts already running on that frps. Inspect every listener and firewall rule; use a separate frps instance or the public-CA mode when the requirements conflict. Neither mode permits arbitrary FRP proxy configuration or editing the operator's server from the plugin.

The [official frps configuration reference](https://gofrp.org/en/docs/reference/server-configures/) defines `proxyBindAddr` as the proxy listening address and `vhostHTTPPort` as the HTTP-proxy listening port; use the values actually configured on your server.

## Public-CA mode

1. In **Self-hosted FRP**, choose **Attach to my existing frps** and **Public CA certificate**. Enter the VPS address, frps control port, high-entropy shared token, public domain or IPv4 HTTPS origin, and the frps instance's actual `vhostHTTPPort`. Do not assume the managed deployment's default of 7080.
2. Copy the attachment plan. Confirm the plaintext vhost is loopback-only, then add the generated Caddy snippet and `import` manually. Caddy manages domain certificates. For public IPv4, the current plan pins Certbot 5.8.0 and uses `--standalone --preferred-profile shortlived --ip-address` for a [roughly six-day Let's Encrypt IP certificate](https://letsencrypt.org/2026/03/11/shorter-certs-certbot). Standalone issuance briefly stops Caddy to free port 80 and may interrupt other sites on the VPS; schedule a maintenance window, choose a domain, or use the 0.4.6 app's self-signed TCP mode if that interruption is unacceptable. The attach path only checks an existing `certbot.timer`; it does not install renewal or a certificate-copy/reload hook. Arrange renewal, installation into Caddy, and reload before expiry yourself. Copying the plan does not change the VPS.
3. Install the pinned official `frpc` on the computer, save and verify the connection, and test `/mobile-access/discovery` from an independent external network with normal certificate validation. Confirm HTTP 200 and this computer's installation identifier before pairing through the app's **Remote access** flow or a phone browser. A local self-check alone does not verify public reachability.

## Self-signed passthrough mode

The computer-side gateway terminates TLS with a self-signed CA valid for five years and a public-IPv4 leaf valid for 397 days. The leaf can be reissued under the same CA. An expired or replaced CA is not silently accepted: inspect the certificate status in the panel, confirm a new fingerprint, and pair the phone again. The QR link, copied link, and bare App key carry a `dsh2` marker requiring CA pinning; older apps reject that format. The CA is private to the 0.4.6 app's connection record, not installed in Android's system trust store.

1. In **Self-hosted FRP**, enter the VPS address, frps control port, token, and `https://YOUR_PUBLIC_IPV4`. Choose **Attach to my existing frps**, **Self-signed passthrough**, and the public TCP port (default 33080; not 3080, 3443, or 3444).
2. Copy the attachment plan and review its masked local `frpc.toml` and VPS checklist. This is read-only. After you install `frpc` and select **Save and verify connection**, the plugin writes the real config under its private `remote/frp/config/` directory (Unix mode `0600`; restricted ACL on Windows). If you re-entered the token and explicitly copied a token-bearing config, clear the clipboard promptly.
3. On the VPS, allow the chosen TCP entry port in its host firewall and cloud security group; the existing frps control port must already be reachable from the computer. Confirm frps is running and the TCP proxy listens on an address reachable from the public network. The plugin does not change the server's frps configuration or firewall.
4. From another network, check the entry with `curl -k -sS -o /dev/null -w '%{http_code}\n' https://YOUR_PUBLIC_IPV4:33080/mobile-access/discovery`. Replace the host and port first. HTTP 200 only shows transport reachability: `-k` bypasses curl's certificate verification and does **not** verify the gateway identity. Pair from the 0.4.6 Android app's **Remote access** flow, which fetches the public CA without a device credential, checks its fingerprint against the `dsh2` key, and pins it to that exact Origin. A 404 CA response cannot fall back to platform trust in this flow. A changed Origin or CA requires a new pairing.

## Troubleshooting and cleanup

| Symptom | Check |
| --- | --- |
| `frp_attach_mode_requires_vhost_port` | Public-CA mode needs the existing frps instance's real `vhostHTTPPort`; a guessed value can make the plaintext exposure probe check the wrong port. |
| `frp_vhost_publicly_reachable` | The public-CA entry's plaintext vhost is reachable from outside. Restrict it without exposing another listener; a separate frps instance may be safer than changing global `proxyBindAddr`. |
| `frp_attach_cert_unknown` | The self-signed certificate is absent or unreadable. Inspect the panel's certificate status and the private `remote/ingress/` files; do not bypass fingerprint validation. |
| `frp_ingress_ca_expired` | The pinned CA expired. Reconfigure the self-signed entry and pair the phone again after checking the new fingerprint. |
| Browser reports an untrusted certificate | Expected for the self-signed entry. Use the 0.4.6 Android app and explicit pairing; use public-CA mode for a browser. |
| Public entry unreachable | Check the chosen port, cloud and host firewalls, frps listener address, running `frpc`, and the external-network probe. A computer-side probe is not proof that a phone can connect. |

**Remove FRP completely** deletes only plugin-managed files on the computer, including the local `frpc` configuration and self-signed ingress material. The attach path never deletes or restarts your existing frps, Caddy site, certificates, or firewall rules on the VPS. Managed deployment and its separate server cleanup are described in the [self-hosted FRP guide](SELF_HOSTED_FRP.en.md).
