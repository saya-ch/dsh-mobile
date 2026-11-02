# Connection diagnostics and measurement scope

[中文](CONNECTION_DIAGNOSTICS.md) · [Documentation](README.md)

> Layered reporting applies to the plugin 0.8.2 candidate. Published 0.8.1 has fewer diagnostic fields and explanations. This computer-side change does not advance the App version.

On the computer, open **Mobile access → Diagnostics** and start the check. It reads configuration, component state and bounded network observations without model requests or changes to DNS, proxies, firewall or pairings. Duplicate actions are disabled while checking; a redacted report can be copied afterward.

## Read the result by scope

Cards and copied reports identify **Configuration, Computer-side check, and Phone not tested**. Green means that particular local observation succeeded, not that the phone can use the complete application. An error describes the measured path, not every network.

| Layer | What it establishes | What remains unverified |
| --- | --- | --- |
| Versions | Running plugin/DSH and declared minimum App version | Compatibility matrix and physical devices |
| Adapter and gateway | The computer's selected interface and listener state | Phone routing, hotspot isolation and cross-subnet access |
| Windows Firewall | Whether the expected enabled rules were found | Other policies, security software or network equipment |
| Local channel | Provider-reported ready, connecting, login or failure state | Public ingress, phone traffic and application resources |
| System DNS | Computer-side address categories and IPv4/IPv6, without copying addresses | DNS results do not prove an open port; deadline means context was not obtained |
| Computer egress | HTTP observation or DNS/connect/TLS/timeout/HTTP failure stage | Checks only the health path's HTTP status, not its body, login, script execution or message delivery |
| Phone path | Explicitly lists what must still be tested on the phone | Pairing, pages, resources and WebSockets are not accepted by a computer-only test |

A successful configured-proxy fallback is labelled as the computer's proxy egress. It does not erase private system-DNS context or establish that the phone uses that proxy. Inactive LAN configuration and firewall items should not be interpreted as remote-entry failures.

Script inspection uses the authenticated request's public Peer API without fabricating an identity. A failed optional observation remains explicitly unverified, not a claim that no competing plugin exists, while other network results remain available. Rejected authentication still refuses the report.

## Funnel inside the same tailnet

The bundled Funnel component uses `tsnet.FunnelOnly()`: it accepts public Funnel ingress, not direct connections from its local tailnet. If MagicDNS resolves the name to the node's `100.64.0.0/10` or Tailscale IPv6 address, the computer takes that private path. Failure there does not prove the public Funnel is down. Other official Funnel configurations need not have this restriction. See [Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel) and [MagicDNS](https://tailscale.com/docs/features/magicdns).

This result requires comparison rather than marking public ingress failed or healthy. It **does not repair phone access through that private path**. Compare from outside the tailnet using another available network. Any temporary per-device Tailscale DNS adjustment is the user's choice; it can affect private services and should be restored afterward. Do not automatically disable MagicDNS for the entire tailnet.

`100.64.0.0/10` is not Fake-IP. Diagnostics distinguish it from the common `198.18.0.0/15` Fake-IP range and do not infer tailnet-only resolution from mixed answers. Real TLS identity failures and HTTP rejection remain failures even when DNS returned a tailnet address.

## Investigate the failed stage

- **DNS**: compare system resolution and network policy. Public DoH is not silently introduced.
- **Connect**: check route, port and ingress; a refused TCP connection does not identify a proxy, certificate or pairing problem.
- **TLS**: check certificate, hostname and proxy path. Never disable certificate or hostname verification.
- **Timeout**: only establishes that the probe did not finish within its budget, not the failed hop.
- **HTTP**: check whether provider policy or reverse-proxy routing blocks the health path. No pairing credentials are sent.
- **Unknown**: insufficient evidence to classify; raw errors, URLs and response contents are not copied into the report.

Working conversations with failed customization need separate manifest, CSS, script and event-stream investigation. Transport errors, parser rejection and upstream HTTP rejection are distinct; see [slow-link diagnostics](SLOW_CONNECTIONS.en.md). Local readiness for iroh or an own reverse proxy is not public-route acceptance; see [iroh](IROH.en.md) and [own reverse proxy](SELF_HOSTED_ORIGIN.en.md).

## Share the report

Reports retain versions, interface names, masked endpoint suffixes, failure stages, timings, DNS categories and measurement scope. They do not read conversations or include pairing secrets, Tokens, Cookies, complete hostnames/IPs or proxy credentials. Context such as an interface name can still be identifying; review before posting.

Include the actual phone network, failure time and whether the failure occurs during pairing, page loading, resources or conversation connection. Do not upload pairing QR codes or descriptors. “Unverified” does not mean “failed”.
