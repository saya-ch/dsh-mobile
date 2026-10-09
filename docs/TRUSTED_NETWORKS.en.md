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

## Windows firewall is separate

DSH Mobile's default Windows HTTPS / Discovery inbound rules allow only `LocalSubnet`. Saving extra CIDRs **does not update or broaden those rules**. You or your administrator must separately allow the controlled sources to reach the actual Mobile HTTPS port in Windows firewall settings.

A routed network may not support LAN broadcast discovery. If the computer is not discovered, use its displayed pairing link or QR code; routing, firewall access, and the HTTPS entry must still work. Adding an IPv6 CIDR does not create an IPv6 listener.

This setting controls source access to the LAN Gateway, not source CIDRs for an external reverse proxy. Configure that separately with the [own HTTPS reverse proxy guide](SELF_HOSTED_ORIGIN.en.md). Do not expose the LAN Gateway or private HTTP backend directly to the public internet.
