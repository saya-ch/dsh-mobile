# Attach to an existing frps

[中文指南](ATTACH_EXISTING_FRPS.md)

> The plugin requires **0.4.6 or later**; the self-signed entry also requires **Android app 0.4.6 or later**. Apps 0.3.3–0.4.5 can use the public-CA entry, not self-signed ingress. Do not downgrade a newer app.

Use this path when you already run frps on a public VPS. The plugin does not install, edit, or restart that frps and does not automatically change your Caddyfile; public-CA mode requires **you** to add a Caddy snippet and import. Inspect the server's listeners before choosing an entry mode. The panel's **Copy attachment plan** action only produces a masked local `frpc.toml` preview and VPS instructions; it neither connects to the VPS nor writes configuration. To copy a token-bearing local config, re-enter the token and explicitly click its copy button; a saved token is never returned to the page. Nothing on the computer side changes DSH's own configuration.

## Choose the HTTPS entry

| Entry | Public route | VPS requirements | Client trust |
| --- | --- | --- | --- |
| **Public CA** (`public-ip-cert`, default) | HTTPS 443 → Caddy → loopback HTTP vhost → FRP | Enter the real `vhostHTTPPort`; keep that plaintext listener on loopback. A domain uses Caddy-managed certificates; public IPv4 needs a short-lived Let's Encrypt IP certificate and operator-managed renewal. | Phone browsers and Android app 0.3.3+ use the platform trust store and still require DSH pairing. |
| **Self-signed passthrough** (`self-signed`) | HTTPS on `publicPort` (default 33080) → frps raw TCP proxy → computer-side HTTPS gateway | Use a globally routable public IPv4 address. The frps TCP listener must be publicly reachable; no new Caddy site, public certificate or HTTP vhost is needed. | Requires Android app 0.4.6 or later with remote CA pinning. Older apps cannot pair; ordinary phone browsers do not trust this certificate. |

frps `proxyBindAddr` is global to proxy listeners, not a per-entry switch. Binding it to `127.0.0.1` protects the HTTP vhost but also makes a TCP `remotePort` unreachable from the public network. Binding it publicly for the TCP entry may expose plaintext vhosts already running on that frps. Inspect every listener and firewall rule; use a separate frps instance or the public-CA mode when the requirements conflict. Neither mode permits arbitrary FRP proxy configuration or editing the operator's server from the plugin.

The [official frps configuration reference](https://gofrp.org/en/docs/reference/server-configures/) defines `proxyBindAddr` as the proxy listening address and `vhostHTTPPort` as the HTTP-proxy listening port; use the values actually configured on your server. A guessed `vhostHTTPPort` is a safety failure, not a cosmetic one: the plaintext-exposure check probes that port, so a wrong value can report a publicly reachable vhost as safe.

## Enter addresses and ports separately

**VPS address** takes a hostname or IP only, without `https://`, a path or a port; enter the frps control port in its own field. **Public entry** requires a complete `https://domain` or `https://PUBLIC_IPV4` without a nonstandard port, path, query or credentials. The plugin does not add a missing scheme. Private, loopback and reserved IPv4 addresses are not public entries.

Public-CA mode uses HTTPS 443. For self-signed mode, keep `https://PUBLIC_IPV4` in the address field and put the TCP port, such as `33080`, in **Public entry port**; the plugin builds the actual pairing address from both. Use public-CA mode for domains rather than the current IPv4-only self-signed mode.

Plugin 0.6.16 adds Chinese, English and Italian field-level feedback: submission or preview marks invalid fields and focuses the first error; editing rechecks and clears corrected errors. It does not relax the validation above or change server listeners or ports for you.

With plugin 0.8.3 or later, fill **frpc user (optional)** only if your shared frps provider supplies a username for proxy registration. The server uses it as a proxy-name prefix; it does not replace the shared token. To remove a saved username, clear the field and save. If the frps address and control port have not changed, you can reuse the saved token without displaying or reentering it.

## Public-CA mode

1. In **Self-hosted FRP**, choose **Attach to my existing frps** and **Public CA certificate**. Enter the VPS address, frps control port, high-entropy shared token, public domain or IPv4 HTTPS origin, and the frps instance's actual `vhostHTTPPort`. Do not assume the managed deployment's default of 7080.
2. Copy the attachment plan. Confirm the plaintext vhost is loopback-only, then add the generated Caddy snippet at `/etc/caddy/dsh-mobile-dsh.caddy` and its `import` line at the top of the Caddyfile manually. Caddy manages domain certificates. For public IPv4, the current plan pins Certbot 5.8.0 and uses `--standalone --preferred-profile shortlived --ip-address` for a [roughly six-day Let's Encrypt IP certificate](https://letsencrypt.org/2026/03/11/shorter-certs-certbot). Standalone issuance briefly stops Caddy to free port 80 and may interrupt other sites on the VPS; schedule a maintenance window, choose a domain, or use the self-signed TCP mode in app 0.4.6 or later if that interruption is unacceptable. The attach path only checks an existing `certbot.timer`; it does not install renewal or a certificate-copy/reload hook. Arrange renewal, installation into Caddy, and reload before expiry yourself. Copying the plan does not change the VPS.
3. Install the pinned official `frpc` on the computer, save and verify the connection, and test `/mobile-access/discovery` from an independent external network with normal certificate validation. Confirm HTTP 200 and this computer's installation identifier before pairing through the app's **Remote access** flow or a phone browser. A local self-check alone does not verify public reachability.

## Self-signed passthrough mode

The computer-side gateway terminates TLS with a five-year CA and 397-day public-IPv4 leaf. The leaf can renew under the same CA; an expired or replaced CA requires a new fingerprint check and pairing. QR links and App keys carry the CA-required `dsh2` marker, rejected by older apps. Supported apps keep this CA in their private connection records, never Android's system trust store.

> Topology: `phone ──HTTPS(:33080)──▶ frps TCP proxy (passthrough) ──encrypted tunnel──▶ local frpc ──▶ 127.0.0.1:<gateway HTTPS port> ──▶ dsh web 127.0.0.1:3080`

1. In **Self-hosted FRP**, enter the VPS address, frps control port, token, and `https://YOUR_PUBLIC_IPV4`. Choose **Attach to my existing frps**, **Self-signed passthrough**, and the public TCP port (default 33080; not 3080, 3443, or 3444).
2. Copy and review the masked `frpc.toml` and VPS checklist. This is read-only: finish the server checks before selecting **Save and verify connection**.
3. On the VPS, allow the chosen TCP entry port in its host firewall and cloud security group; the existing frps control port must already be reachable from the computer. Confirm frps is running and the TCP proxy listens on an address reachable from the public network. The plugin does not change the server's frps configuration or firewall.

   ```sh
   ufw allow 33080/tcp
   ufw status | grep 33080
   ```

   With firewalld or a cloud security group, allow the same **TCP 33080**. Then check the frps service and its listeners (use your own service manager if frps does not run under systemd):

   ```sh
   systemctl is-active frps || true
   ss -lnt | grep -E ':(<your bindPort>|33080)\b' || true
   ```

   The control port should already be listening. A proxy entry such as 33080 usually appears only after frpc registers successfully, so check its actual address once the connection is up.
4. Install official frpc and select **Save and verify connection**. The plugin now writes the config in private `remote/frp/config/` (Unix `0600`, restricted Windows ACL), then runs `frpc verify` before startup. Clear the clipboard if you explicitly copied a token-bearing config. A public TCP proxy port normally appears only after frpc registers; check its actual listener then.
5. From another network, check the public entry end to end, replacing the host and port with your own:

   ```sh
   # Replace YOUR_PUBLIC_IPV4 and 33080, then run this from an external network.
   curl -k -sS -o /dev/null -w '%{http_code}\n' https://YOUR_PUBLIC_IPV4:33080/mobile-access/discovery
   # Expected output: 200. `-k` skips curl's certificate check and proves reachability only, not identity.
   ```

   HTTP 200 proves reachability only: `-k` does not verify identity. Pair through **Remote access** in app 0.4.6 or later; it fetches the CA from `GET /mobile-access/ca.cer` without device credentials, checks the `dsh2` fingerprint and pins the exact Origin. CA HTTP 404 cannot fall back to platform trust. An Origin or CA change requires new pairing.

## Troubleshooting and cleanup

| Symptom | Check |
| --- | --- |
| `frp_attach_mode_requires_vhost_port` | Public-CA mode needs the existing frps instance's real `vhostHTTPPort`; a guessed value can make the plaintext exposure probe check the wrong port. |
| `frp_vhost_publicly_reachable` | The public-CA entry's plaintext vhost is reachable from outside. Restrict it without exposing another listener; a separate frps instance may be safer than changing global `proxyBindAddr`. |
| `frp_attach_cert_unknown` | The self-signed certificate is absent or unreadable. Inspect the panel's certificate status and the private `remote/ingress/` files; do not bypass fingerprint validation. |
| `frp_ingress_ca_expired` | The pinned CA expired. Reconfigure the self-signed entry and pair the phone again after checking the new fingerprint. Android App 0.6.3 and later keep the device record readable and removable, while TLS still rejects the expired certificate. If App 0.6.2 or earlier cannot read its device list, preserve App data and use the [App guide](../apps/mobile/README.md) to install a same-signer release of 0.6.3 or later rather than clearing all pairings for one computer. |
| Browser reports an untrusted certificate | Expected for self-signed ingress. Use app 0.4.6 or later and explicit pairing, or public-CA mode for a browser. |
| `frp_proxy_name_in_use` | frps keeps proxy names unique across **all** its clients, and this installation's own name (`dsh-mobile-<first 12 characters of the installation identity>`) is already registered — usually another DSH computer, or this computer's previous session before the frps heartbeat expires it. Disable self-hosted FRP there, or remove that proxy on the frps. frpc keeps running without publishing the entry port, so check proxy registration rather than relying on process liveness. |
| `frp_remote_port_in_use` | Another proxy on the same frps already owns the chosen entry port. Ports are first-come, first-served per server, so give this computer a different `publicPort` and allow it in the firewall. |
| Public entry unreachable | Check the chosen port, cloud and host firewalls, frps listener address, running `frpc`, and the external-network probe. A computer-side probe is not proof that a phone can connect. |
| App reports "connected to another DSH" | The public entry points at a different DSH: check `remotePort`, and confirm frpc is running on this computer. |

## Relation to the other channels

- The **`origin` own-reverse-proxy channel** (default 3444) is a separate path: TLS is terminated by **your own external proxy** and it is independent of this mode.
- **Deploy mode** (the plugin installs frps + Caddy) is unchanged and still needs SSH; attach mode needs **zero SSH**.

**Remove FRP completely** deletes only plugin-managed FRP files on the computer, including the local `frpc` configuration and self-signed ingress material. The non-secret plugin `installation-id` remains so a later FRP connection keeps the same proxy name; removing all DSH Mobile private state removes that identifier too. The attach path never deletes or restarts your existing frps, Caddy site, certificates, or firewall rules on the VPS. Managed deployment and its separate server cleanup are described in the [self-hosted FRP guide](SELF_HOSTED_FRP.en.md).
