# Cloudflare named tunnel (a stable public hostname)

[中文指南](CLOUDFLARE_TUNNEL.md)

The built-in cloudflared provider runs in one of two modes, chosen in the panel under **Mobile access → Remote → cloudflared → Tunnel type**:

| | Quick tunnel (default) | Named tunnel |
| --- | --- | --- |
| Account | Not needed | Cloudflare account required |
| Address | Random `*.trycloudflare.com` on every start | A fixed hostname under your own domain |
| After a restart | Address changes; pair again | Address is unchanged; paired devices keep working |
| Availability | Officially for testing: rate-limited, no uptime guarantee | Carried by your own Cloudflare account |
| Settings | None | Connector token, public hostname, local forward port |

Cloudflare provides the public hostname and TLS. The plugin runs `cloudflared` locally and forwards requests to its paired-device gateway. Select **Remote access** in the Android app; a mobile browser can also use the public HTTPS pairing link. The tunnel does not replace DSH Mobile pairing.

## Quick tunnel feature limits

[Cloudflare's official limits](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/#limitations) include no uptime guarantee, up to 200 in-flight requests and no SSE. DSH Mobile uses SSE for extension changes, task completion and online revocation events. Quick-tunnel extension updates fall back to periodic checks; completion notifications and immediate revocation notices may not arrive, and missed completion events are not replayed. Server-side revocation still blocks access. For regular use, choose a named tunnel or another channel.

## Prerequisites

1. A domain already on Cloudflare. Its nameservers must point at the pair Cloudflare assigned, changed at your registrar; that usually takes minutes and up to 24 hours.
2. A Cloudflare account permitted to manage that domain and Tunnel.
3. The cloudflared component installed in the panel. Named and quick tunnels share the same official client.

The component supports Windows x64, Linux x64/arm64 and macOS x64/arm64. Official downloads are verified before installation; macOS also verifies the extracted executable. Components remain inside DSH Mobile's private directory.

## Create the tunnel in the Cloudflare dashboard

1. In the Cloudflare dashboard, open **Networking → Tunnels** and create a tunnel named, for example, `dsh-mobile`.
2. Obtain its Tunnel token from the connector instructions. **Do not run the service-install command**: DSH Mobile manages the verified cloudflared process.
3. Open **Routes → Add route → Published application** and add a public hostname:
   - Subdomain `dsh`, and pick your domain, giving `dsh.example.com`
   - Service: **HTTP** → `127.0.0.1:3444`
4. Save the route and enter the connector token in the DSH Mobile panel below. It is a credential: never put it in an issue, screenshot or log.

These labels follow [Cloudflare's current official guide](https://developers.cloudflare.com/tunnel/get-started/); older dashboards may call the published route Public Hostname. This setup uses an HTTP loopback Service and does not require disabling TLS verification.

> `127.0.0.1:3444` is the panel's "Local forward port". Cloudflare routes the public hostname to exactly that port, so it must match what you enter in the panel and must not change afterwards.

## Fill in the DSH Mobile panel

1. **Mobile access → Remote → cloudflared**.
2. Set the tunnel type to **Named**.
3. Enter:
   - **Public hostname**: `dsh.example.com`
   - **Local forward port**: `3444`, matching the Service port from step 3
   - **Connector token**: the token you copied
4. Choose **Save and connect**.

Once saved, leaving the token field blank keeps the stored token, and the field never echoes a saved token back. **Remove the saved token** also **stops the cloudflared channel** and returns the provider to a quick tunnel. Nothing reconnects on its own: switch the channel back on afterwards.

## Connect the phone to a named tunnel

Moving to a fixed hostname means **an already paired phone must pair again**: the App does not send a saved device token to a changed Origin without new pairing. This client-side exact-address policy does not mean the server token automatically expires by hostname; remote channels share the device registry. Use a trusted entry you control and revoke a device on the computer if credential theft is suspected.

1. On the computer, open **Remote** in the panel and choose **Create remote pairing QR code**. That is what opens the pairing window, which is time-limited; while it is closed nothing can pair.
2. In the app, **open the Remote entry first** (the remote access setup page in the connection center), then scan the code.

> **A named tunnel must be scanned from inside the Remote flow.** The app treats platform suffixes such as `.ts.net`, cpolar and `.trycloudflare.com` as remote without asking. A domain you own is recognised as a remote candidate too, but the Local network flow accepts only non-candidate addresses, so scanning there is rejected as **Invalid QR code** and looks exactly like "cannot connect". Enter the Remote flow first, then scan.
>
> Scanning is optional: the full link (`https://your-domain/mobile-access/pair#instance=…&token=…`) can be copied to the phone and pasted, because the app accepts a complete link in its input field.

The old address may show **Address may have changed** or temporarily unreachable before re-pairing. After pairing the same computer again, the app updates its existing remote-device record by device identity and keeps the custom name; there is no old entry to delete.

## Security boundary

- The token is written only into the DSH Mobile private directory (by default `$DSH_HOME/mobile-access/remote/cloudflared/tunnel.json`; Unix mode `0600`, restricted ACL on Windows) and is passed to `cloudflared` **only** through the `TUNNEL_TOKEN` environment variable, never on the command line.
- The token is never returned to a browser or a phone. Panel status carries only whether it is configured, plus the hostname and port.
- Behind the tunnel sits DSH Mobile's own authenticated gateway: the public hostname exposes that gateway, and DSH still requires paired-device credentials.
- The plugin adds no system service, startup item, registry entry or PATH entry. Disabling the channel ends the process.

## Error codes

| Panel message | Code | Meaning and remedy |
| --- | --- | --- |
| Local forward port unavailable | `cloudflared_tunnel_port_unavailable` | The configured port is taken. A named tunnel cannot move to another port, because Cloudflare routes to that exact one: free the port, or pick another and update the Service in Cloudflare to match. |
| Invalid public hostname | `cloudflared_tunnel_hostname_invalid` | Must be a real hostname under a domain on this account. IP literals, wildcards, `.trycloudflare.com` and `.cfargotunnel.com` are refused. |
| Invalid forward port | `cloudflared_tunnel_port_invalid` | The port must be between 1024 and 65535. |
| Reserved forward port | `cloudflared_tunnel_port_reserved` | **3443** is the reserved default LAN HTTPS port and is rejected in this mode. Select 3444, 3445 or another allowed, unused port. Reservation does not mean the LAN listener is always active. |
| Invalid token | `cloudflared_tunnel_token_invalid` | Copy the whole token from the dashboard, with no spaces or newlines. |
| Settings rejected | `cloudflared_tunnel_settings_invalid` | The request carried a field that does not belong to the mode, such as a port in quick mode. |
| Token, hostname and port are all required | `cloudflared_tunnel_config_missing` | First-time named-tunnel setup needs all three. |
| Saved configuration is unreadable | `cloudflared_tunnel_config_invalid` | The stored file is corrupt or malformed. The provider falls back to a quick tunnel; save the settings again. |
| Saved configuration is not a regular file | `cloudflared_tunnel_target_invalid` | `tunnel.json` became a symlink or a non-regular file. Remove it and save the settings again. |
| Could not reserve a local port | `cloudflared_port_reservation_failed` | Reserving the loopback port failed for a reason other than the port being busy. Retry, and check system resources if it persists. |
| Component download failed verification | `cloudflared_download_hash_mismatch` / `cloudflared_download_size_mismatch` | The downloaded binary does not match the pinned size or SHA-256. Install again; repeated failures mean something is rewriting the transfer. |
| Installed component failed verification | `cloudflared_executable_hash_mismatch` | The local cloudflared no longer matches the verified build. Remove it completely and install again. |
| This build cannot run the component | `cloudflared_component_unsupported` | The platform is outside the supported set (Windows x64, Linux x64/arm64 and macOS x64/arm64). |
| Timed out waiting for the tunnel | `cloudflared_start_timeout` | The connector did not print `Registered tunnel connection` within the startup budget. In named mode a live connector keeps waiting (up to about 5 minutes); usually it cannot reach a Cloudflare edge. |
| Component not installed | `cloudflared_component_missing` | The official component is absent. Complete the preparation steps above. |
| Component verification failed | `cloudflared_component_invalid` | The local component does not match the verified build. Remove it completely and install again. |
| Could not allocate a port | `cloudflared_port_unavailable` | Quick mode could not allocate the loopback gateway port. Retry. |
| Client failed to launch | `cloudflared_launch_failed` | The cloudflared process did not start. Check the local logs. |
| Connection stopped or exited | `cloudflared_stopped` / `cloudflared_exited` | The channel dropped. Reconnect. |
| Unrecognized output | `cloudflared_invalid_output` / `cloudflared_invalid_origin` | cloudflared output, or the public address it printed, failed validation. Reconnect and copy the diagnostic report. |
| Gateway start failed | `gateway_start_failed` | The authentication gateway behind the tunnel did not start; this is not a port conflict. Check the local logs. |
| Download redirect problem | `cloudflared_download_redirect_missing` / `_invalid` / `_rejected` | The official page did not redirect to the fixed release asset, or validation rejected the target. Retry later or update the plugin; a global cloudflared installation does not replace its private pinned component. |

## Troubleshooting

- **Stuck on "connecting"**: the named tunnel becomes ready only after the connector registers with Cloudflare. Check cloudflared output in the DSH log and test DNS, UDP/QUIC and TCP reachability from the computer to a Cloudflare edge.
- **Public access returns 1033**: Cloudflare sees no healthy connector for the hostname. Confirm the dashboard reports Healthy and the route's Service port matches the panel.
- **`cloudflared` reports `Unauthorized`, or the tunnel id does not exist**: the token belongs to a different tunnel, for example one that was deleted and recreated. Copy the token again.
- **The phone stalls on "Loading plugins" or the remote page is slow while a TUN or transparent proxy is active**: check whether a catch-all rule sends `cloudflared` connections to `*.argotunnel.com` through a proxy node. This routing has caused slow boot-resource transfers before; it does not by itself indicate a pairing failure. This Clash-rule example is for Windows; on Linux, adapt the process name and syntax to your proxy client, and put direct-route rules before catch-all rules:

  ```yaml
  prepend-rules:
    - PROCESS-NAME,cloudflared.exe,DIRECT
    - DOMAIN-SUFFIX,argotunnel.com,DIRECT
    - DOMAIN-SUFFIX,trycloudflare.com,DIRECT
  ```

  Then make cloudflared **reconnect** so existing connections take the new route (use the panel's reconnect action, or toggle the provider off and on). Compare the same resource through the LAN and remote entries. If the remote entry is also slow on the computer, inspect the computer-to-Cloudflare route first; if only the phone is slow, inspect its network.
- **The domain still resolves to the old address**: after the nameserver change Cloudflare must move the zone from Pending to Active, and records in a pending zone are not served publicly.
