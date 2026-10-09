# Self-hosted FRP guide

[中文指南](SELF_HOSTED_FRP.md)

This page covers a new FRP entry, deployed manually or managed by the plugin over SSH. If your VPS already runs frps, plugin 0.4.6 or later can attach to it without deployment; see the [attachment guide](ATTACH_EXISTING_FRPS.en.md).

Self-hosted FRP is for users who already operate a VPS and want to avoid the bandwidth limits of public tunnels. The phone reaches Caddy on the VPS over HTTPS, crosses the encrypted FRP tunnel, and then reaches DSH on the computer. FRP only transports the request; DSH pairing is still required.

```text
Android app
  -> HTTPS (domain or public IPv4)
  -> Caddy on the VPS
  -> 127.0.0.1:7080 (frps HTTP vhost, loopback only)
  -> encrypted FRP tunnel
  -> computer running DSH
```

## Two entry modes

- **Domain mode**: use your own public domain; Caddy obtains and renews the certificate automatically.
- **Public IPv4 mode**: use the VPS public IPv4 directly. The current template uses Certbot for a roughly six-day Let's Encrypt IP certificate. Automatic deployment installs a daily renewal timer; manual deployment requires operator-managed renewal, certificate copying and Caddy reload. Documentation ranges such as `203.0.113.10`, private addresses and reserved addresses are rejected; enter a real routable public IP.

The publicly trusted entry in this guide requires Android app 0.3.3 or later for custom remote origins. The separate self-signed TCP passthrough in the [existing-frps attachment guide](ATTACH_EXISTING_FRPS.en.md) is attach-only and requires the 0.4.6 or later app with remote CA pinning; older apps cannot use that entry and continue to work with LAN, cpolar, and Tailscale.

## Manual deployment vs automatic deployment

- **Manual deployment**: install frps and Caddy and configure services and firewalls yourself, then copy the panel's restricted template. Save its frps section as `/etc/dsh-mobile/frps.toml` and Caddy snippet as `/etc/caddy/dsh-mobile-dsh.caddy`. Add `import /etc/caddy/dsh-mobile-dsh.caddy` once to the main Caddyfile without overwriting other sites. Copying or saving a template does not install or start services. This project's public-IPv4 template uses Certbot and requires operator-managed renewal and certificate reload; Caddy manages domain certificates.
- **Automatic deployment**: enter an SSH user, port, and local private-key path (leave the path empty to use ssh-agent or SSH configuration), then select the one-click deployment action. The VPS must run Ubuntu or Debian with systemd. Only key-based login is accepted; passwords are not supported.

Before deployment, the panel lists every VPS change. It installs Caddy from its official APT source; public IPv4 mode additionally installs a Python virtual environment, Certbot and the renewal timer. It creates the frps service/configuration, Caddy snippet and one import line, and allows the FRP control port plus 80/tcp and 443/tcp when UFW is active. An existing `dsh-mobile` system user is reused and retained during cleanup; a user created by this deployment is removed during cleanup. **Your existing Caddy content is never merged or overwritten**: an existing DSH Mobile import is only normalized to one line; another non-empty configuration stops deployment and asks you to add the import manually.

## Verify the host keys every time

Automatic deployment and one-click cleanup read the VPS host keys before opening an authenticated SSH connection:

1. Select deployment or cleanup. The panel shows the current `KEYTYPE SHA256:…` fingerprints.
2. Compare every fingerprint with the VPS provider console or the information supplied when the server was created.
3. Continue only when every key matches. Cancel when a key cannot be verified. The plugin never accepts an unknown host key silently, and a key change during the operation aborts it.

The SSH user, port, and private-key path are kept only in this browser's `localStorage` under `dsh-mobile.frp-vps-form.v1` for convenience. The shared token never enters `localStorage`, and the private-key file is never uploaded.

## Clean up the VPS

The local **Remove FRP completely** action removes only the computer's managed frpc, token, and configuration; it does not touch the VPS. The non-secret plugin `installation-id` remains so a later FRP connection keeps the same proxy name; removing all DSH Mobile private state removes that identifier too. Server cleanup has two equivalent paths, and both remove only DSH Mobile-owned files, services, and tagged firewall rules:

1. **Copy the uninstall script**: select **Copy VPS uninstall script**, review it, and run it as root on the VPS. The script stops and removes the frps service and certificate-renewal timer, deletes DSH Mobile configuration, binaries, certificates, and the Caddy snippet, removes the import line from the main Caddyfile while preserving your content, and removes UFW rules carrying the DSH Mobile marker. It deletes the `dsh-mobile` system user only when this deployment created it; an existing user is kept and reported.
2. **One-click cleanup**: select **Remove DSH Mobile from the VPS**. The panel verifies the host keys again and runs the same script over pinned SSH after confirmation.

Public IPv4 mode also removes the corresponding Let's Encrypt IP certificate. Domain-mode certificates remain managed by Caddy.

## Operations and troubleshooting

On the VPS:

```bash
sudo systemctl status dsh-mobile-frps.service caddy
sudo journalctl -u dsh-mobile-frps.service -u caddy -n 200 --no-pager
sudo ss -lntp
curl -v https://PUBLIC_HOST/mobile-access/discovery
```

Only public IPv4 mode installs `dsh-mobile-cert-renew.timer`; in that mode, also run `sudo systemctl status dsh-mobile-cert-renew.timer`. Replace `PUBLIC_HOST` with your actual domain or public IPv4 address. Do not add `-k`: verify the public certificate as well as the response. Check the same address from an independent external network and confirm discovery reports this computer's installation identifier; success on the VPS alone does not prove the phone's network can reach it.

On the computer, start with the plugin log at `$DSH_HOME/mobile-access/logs/dsh-mobile.log` (JSONL; existing files of at least 5 MB rotate at startup) and the panel diagnostic report. Custom extensions must not log tokens or keys; inspect and remove sensitive content before sharing logs because this is not a generic secret redactor. Windows antivirus software can quarantine frpc; if it does, create the smallest possible exception for the verified component directory only.

When several computers share one frps, proxy names are unique across the server and entry ports cannot overlap. The plugin uses `dsh-mobile-<first 12 characters of the installation identity>` as its name. A name conflict requires checking another computer or an unexpired old connection; a port conflict requires a different entry port. A running frpc process does not mean the public entry was published: verify the public route.

## Limits

- An unregistered domain on a mainland-China VPS may be intercepted by the cloud provider; use public IPv4 mode in that case.
- An IPv4 certificate is short-lived; keep the automatic deployment's timer or your manual renewal/copy/reload procedure operational.
- SSH form values are browser-profile state. Changing browsers or clearing site data requires entering them again; private keys and passwords are never stored.
- VPS SSH targets currently cannot use IPv6.
- The frps plaintext vhost must bind to `127.0.0.1`. The plugin rejects a publicly reachable plaintext port and reports readiness only after public discovery identifies the current computer.

## Acceptance check

After deployment, check the certificate, public discovery endpoint, app pairing, and a live conversation on your own VPS and phone network. The repository's historical tests are recorded in the [self-hosted FRP handoff](HANDOFF_SELF_HOSTED_FRP.md); they cannot replace your own acceptance test.
