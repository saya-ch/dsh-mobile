# Additional trusted networks

[中文](TRUSTED_NETWORKS.md) · [Back to the LAN guide](../README.en.md#local-network)

> Plugin 0.6.0 and later provide this computer-side control. The App does not need a matching version or an update solely for this setting.

Default LAN setup permits the LAN source subnet of the selected interface. Explicitly append source CIDRs when an existing routed network you control, such as WireGuard, needs access. This does not create a VPN, route, IPv6 listener, or public entry.

## Configure on the computer

1. Open **Mobile Access → LAN → Additional trusted networks · Advanced**. This control supports only LAN setup managed by DSH Mobile. Failed or unsupported reads leave saving disabled.
2. Enter controlled IPv4 / IPv6 CIDRs, one per line or separated by spaces or commas. Examples such as `10.80.0.0/24` and `fd12:3456:789a::/64` show the format; replace them with your actual networks.
3. Select **Save networks**, then restart DSH to apply. Saving does not interrupt current connections or replace the selected interface, listen port, certificates, or pairing identity.
4. Check routing and firewall access from that network, then connect through the normal HTTPS pairing flow.

The current LAN subnet is always combined with the extra list. When Wi-Fi, hotspot, or address changes, the default part follows the selected interface; explicitly saved extras remain. Clearing the extra list restores current-LAN-only access without deleting paired devices or remote settings.

CIDRs match the direct TCP source address, not `X-Forwarded-For`. Allowing a source subnet does not permit every network or bypass HTTPS, device pairing, exact Host / Origin, or CSRF checks. Add only the ranges actually needed, rather than allowing the entire internet to diagnose a connection.

When the phone and the computer are on different subnets, the source-address check rejects a pairing request before the one-time code is ever examined. From plugin 0.8.9 that rejection answers HTTP 403 `{"error":"source_network_untrusted"}`, separately from an expired code (HTTP 401); from Android 0.7.5 the App reports "phone network not trusted" and points at this page, while an older half of either side still shows the pairing link as expired. Confirm both subnets before regenerating a QR code.

## Windows firewall is separate

DSH Mobile's default Windows HTTPS / Discovery inbound rules allow only `LocalSubnet`. Saving extra CIDRs **does not update or broaden those rules**. You or your administrator must separately allow the controlled sources to reach the actual Mobile HTTPS port in Windows firewall settings.

A routed network may not support LAN broadcast discovery. If the computer is not discovered, use its displayed pairing link or QR code; routing, firewall access, and the HTTPS entry must still work. Adding an IPv6 CIDR does not create an IPv6 listener.

This setting controls source access to the LAN Gateway, not source CIDRs for an external reverse proxy. Configure that separately with the [own HTTPS reverse proxy guide](SELF_HOSTED_ORIGIN.en.md). Do not expose the LAN Gateway or private HTTP backend directly to the public internet.

## Use an existing virtual LAN

A virtual LAN such as [StarVPN](https://doc.starvpn.cn/) can carry an existing Mobile connection. DSH Mobile does not install the provider's client, sign in to its account, or select direct or relayed paths. Join both devices to the same controlled network, then check that the phone can reach the **actual Mobile HTTPS listener at an address covered by its certificate**. Use that entry to test pairing, resource loading, opening a conversation, and reconnecting. If broadcast discovery is unavailable, use the pairing link copied from the computer. StarVPN has not been tested end to end.

Adding a trusted subnet only changes which sources are allowed. It does not bind the service to another virtual IP or add that IP to its certificate. If the pairing link's address cannot be routed, use an existing controlled route to the original HTTPS address, or configure a reachable address with a valid certificate using the [own HTTPS reverse proxy guide](SELF_HOSTED_ORIGIN.en.md). Do not rewrite the pairing link to an arbitrary virtual IP, bypass certificate validation, or forward the DSH administration port.

## Accessing the NAS administration page

The administration page's `/api/mobile-access` and the phone Gateway are separate entries. The additional trusted networks above do not open the management API. By default, the management API still accepts only direct loopback peers.

Plugin 0.6.18 adds `adminAllowedCidrs` for NAS deployments already accessed through a controlled LAN. Add this field to the existing `mobile-access` entry's complete `config`, replacing the example with the administration computer's actual address:

```yaml
adminAllowedCidrs:
  - 192.168.50.23/32
```

This is only the additional field, **not a complete replacement `config`**. DSH entry overrides replace the whole configuration; retain the existing `setupFile`, `stateFile`, `controlFile`, TLS and other custom settings. Restart DSH after editing.

This option does not change DSH's listener, routing or firewall, or open a public management entry. It accepts only the listed direct TCP peers, never `X-Forwarded-For`, and also requires the current request to pass DSH session authentication. Sign in to DSH normally first. A version without usable authentication, a deployment with authentication disabled or a request without credentials cannot gain management access merely through a CIDR. Prefer a single administration computer's `/32`; the limit is 32 entries, with no all-address `/0` or duplicate networks.

Existing private-IP/loopback Host restrictions, exact Origin checks, cross-site rejection and denied CORS preflights remain. The management API does not accept arbitrary DNS names or public Hosts. A proxy's direct address may represent several visitors: the proxy must restrict access, retain DSH authentication and never add CORS permission for this path. Plain HTTP on a LAN does not prevent interception; use HTTPS or SSH forwarding on uncontrolled networks, and never publish `/api/mobile-access`. Remove the field or set an empty list to restore the default without deleting pairings.
