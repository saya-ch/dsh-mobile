# cpolar reserved subdomain

[中文指南](CPOLAR_SUBDOMAIN.md)

> Requires plugin **0.6.7 or later**; versions through 0.6.6 do not read these two settings. No Android App update is required.

cpolar assigns a temporary public address by default. Reserving a subdomain lets an account request a fixed address, reducing bookmark updates and re-pairing after tunnel restarts. A fixed address does not keep the tunnel permanently online or remove re-pairing requirements after credentials expire or a device is revoked.

The public entry still reaches the DSH Mobile Gateway with HTTPS, device pairing and authorization checks; it does not expose the ordinary DSH WebServer directly. The computer connects out to cpolar, so this channel needs neither a home-network inbound port nor Tencent Cloud DNSPod. Availability and speed still depend on the cpolar plan and both network paths.

## Prerequisites

1. Check that your cpolar plan supports reserving a secondary subdomain. The [official tutorial](https://www.cpolar.com/blog/cpolar-quick-start-tutorial-raspberry-pi-series) uses Basic plans or above; your account dashboard is the authority for current eligibility, available regions and naming rules.
2. Reserve a name under **Reserved → Reserve a secondary subdomain** in the [cpolar dashboard](https://dashboard.cpolar.com), and record the selected region.
3. Install the component and save the Authtoken under **Mobile access → cpolar** in DSH.

The region must match the reservation. The official command example uses `cn_vip`, but do not copy it for a reservation in another region; confirm other identifiers against cpolar's current instructions. This guide does not maintain a fixed region or domain-suffix mapping.

## Configuration

> The panel has no subdomain or region fields yet. Edit the current DSH profile's `cordis.patch.yml` after making a backup; do not edit generated `cordis.yml` or the plugin-managed `cpolar.yml`.

Find the current profile directory, for example `$DSH_HOME/profiles/<profile>/cordis.patch.yml`. Update the existing `mobile-access` configuration override. If none exists, add the override below to a profile that already loads the DSH Mobile bundle. **Do not create a second `mobile-access` instance or copy the bundle's `insert` list again.**

The DSH loader replaces an entry's entire `config`, rather than merging individual keys. Do not paste an override containing only the subdomain and region. This example includes every field of the standard bundle's `config` block in this repository, followed by the two new settings; **it is only suitable for a standard installation without custom configuration for this entry**:

```yaml
- id: mobile-access
  name: dsh-mobile
  config:
    setupFile: !!js dshHomePath('mobile-access/setup.json')
    stateFile: !!js dshHomePath('mobile-access/devices.json')
    controlFile: !!js dshHomePath('mobile-access/control.json')
    customCssFile: !!js dshHomePath('mobile-access/mobile.css')
    customScriptFile: !!js dshHomePath('mobile-access/mobile.js')
    initiallyEnabled: false
    listenHost: 127.0.0.1
    listenPort: 3443
    allowedCidrs: [127.0.0.0/8]
    tls:
      mode: disabled
    cpolarSubdomain: your-reserved-name
    cpolarRegion: cn_vip
```

If you already customize paths, listeners, TLS or other settings, **keep your current complete `config` and add only these two fields inside it**. Replacing it with the example can change data locations or access settings. Do not add the Authtoken here; save it through the panel as before.

| Field | Value |
| --- | --- |
| `cpolarSubdomain` | The reserved name itself, not a full domain, HTTPS address or path. Omitted, empty or whitespace-only values do not request a fixed name. |
| `cpolarRegion` | The region identifier matching your reservation; `cn_vip` above is only an official example. Omitted, empty or whitespace-only values do not send a region argument, leaving routing to cpolar; specify the matching region for a fixed reservation. |

Leading and trailing whitespace is removed. The plugin only bounds the requested name's syntax: it starts with a letter or digit, contains letters, digits, `.`, `_`, `-`, and is at most 63 characters long. This is not a DNS-label specification or a guarantee of server acceptance. The account, region and cpolar's actual rules determine whether the reservation is valid. The [official subdomain instructions](https://www.cpolar.com/docs#configure-secondary-subdomain) and tutorial describe the `-subdomain` and `-region` arguments.

After checking that no tasks are running, quit DSH completely and reopen it, then connect under **Mobile access → cpolar**. Use the actual HTTPS address shown by the panel; do not construct a domain suffix yourself.

## Verification and pairing

1. Compare the public hostname displayed by the panel with your account's reservation.
2. From the external network used by the phone, open `https://<hostname-shown-by-the-panel>/mobile-access/health`, check the HTTPS certificate and confirm a `{"ok":true}` response. This is a basic connectivity check; an HTTP `401`, `301`, or an accessible webpage alone does not identify your DSH gateway.
3. When the target computer needs confirmation, compare the `instanceId` returned by that address's `/mobile-access/discovery` with the local gateway's value. Do not publish full discovery responses, pairing codes or credentials.
4. Choose **Remote** in the Android App and connect using the remote pairing QR code generated by the panel. Check that workspaces and conversations load and real-time connections work; the panel's connection diagnostics can also help. No model request is needed to check connectivity.

Existing pairings are bound to an exact HTTPS Origin. Switching from a temporary address to a fixed address requires pairing once more. Afterwards the record remains usable while the address stays unchanged and authorization remains valid. A fixed domain does not prevent Token expiry, device revocation, certificate problems or provider outages.

## Troubleshooting

| Symptom | Checks and action |
| --- | --- |
| A temporary address is still displayed | Confirm that plugin 0.6.7 or later is running, the fields are inside the existing `mobile-access` entry's complete `config`, and DSH has fully restarted. Then check the account reservation and region; local configuration alone is not success. |
| The plugin reports `cpolar subdomain is invalid` | Check the request syntax and 63-character limit above, using only the reserved name. Passing local syntax checks still does not ensure cpolar accepts it. |
| The plugin reports `cpolar region is invalid` | The format starts with a lowercase letter, followed only by lowercase letters, digits or underscores, up to 32 characters. Also confirm the identifier is valid for the account reservation. |
| cpolar rejects the name or fails to start | Check the current plan, account, reserved name and region; inspect the error and follow cpolar's current instructions. The plugin does not treat the requested value as a successfully returned public address. |
| Health responds but workspaces do not load | Check pairing authorization and the actual WebSocket connection using connection diagnostics; a successful health request does not establish a working session. |
| Data or listeners changed after editing | Check for omitted fields from the original complete `config`; restore the original paths and access settings from your backup. Do not delete pairing files. |

## Security boundaries

- These settings only append `-subdomain` and `-region` arguments to `cpolar http`; gateway pairing, TLS and device authorization are unchanged.
- The plugin still uses only the public address actually reported by cpolar and validated by the plugin; the entered name does not become a trusted Origin on its own.
- The Authtoken retains its existing private storage. The reserved name appears in the public domain and is not secret, but do not publish it together with Tokens, Cookies or pairing QR codes.
