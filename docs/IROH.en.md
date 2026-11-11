# Experimental iroh connection

iroh replaces public domains and tunnel accounts with an encrypted direct connection (relay fallback when direct fails): the phone finds the computer's cryptographic identity first, then traffic returns to the loopback gateway. You need no domain, port mapping, or separate HTTPS tunnel.

> Plugin 0.7.0 and the full App 0.7.0 integrate the computer provider, pinned TLS, pairing UI and Android native transport; the feature is off by default and remains experimental. This guide was verified on plugin 0.8.6 and the full Android App 0.7.3 (build 88); iroh has been available since 0.7.0. Direct connectivity, relay use and speed depend on both networks; availability on every campus, corporate or carrier network is not guaranteed.
> The design lives in the companion's [integration seam](https://github.com/saya-ch/dsh-mobile-iroh/blob/main/docs/INTEGRATION_SEAM.md).

## Prerequisites

- Windows x64 or Linux x64 (the only published sidecar targets).
- Android 10+ with the full `-iroh.apk`, supporting arm64-v8a and x86_64. The ordinary `.apk` is the compatibility build without native libraries: it retains existing HTTPS connections and serves older automatic-update links, but cannot use iroh. Mobile browsers cannot connect directly through iroh either. Both APKs have the same application ID and official signer; install only one.
- Press **Install official component** once to fetch the sidecar: the plugin downloads the pinned `dsh-mobile-iroh 0.1.0-alpha.1` release per platform (about 15 MB on Windows x64, 24 MB on Linux x64), verifies its SHA-256, and stores it in the plugin private directory. An installed companion plugin with a verified copy is reused instead, with no download. The Rust source lives with the main repository under `native/iroh-host` (shared core under `native/iroh-core`) and is built per platform in CI.
- DSH Mobile stays enabled; iroh is off by default. LAN runs independently, but only one remote provider is active: switching to iroh stops the previous remote channel.

## Usage

1. Under **Mobile access**, pick `iroh (Experimental)`.
2. Press **Install official component** (labelled with the download size): the first run downloads and verifies the sidecar; later runs reuse the verified copy. A hash mismatch or an unsupported platform stops here with a reason instead of a half-started channel. Merely switching the channel on never triggers a download.
3. Turn remote access on: the plugin resolves the endpoint identity, issues the endpoint gateway certificate (own CA, 90-day leaf, 30-day renewal headroom), starts a dedicated gateway, launches the sidecar, and waits for `ready`. `ready` means the sidecar is connected and the gateway serves its loopback socket.
4. Press **Generate iroh pairing QR code** and scan it with the full App. The descriptor binds the sidecar's six-digit code, the Gateway's one-time token and pinned CA. Generating another descriptor replaces the previous pairing window; pairing a phone redeems the Gateway token through the normal pair endpoint over iroh.
5. Switching off or switching providers stops the owned process and Gateway without deleting stored pairings. The independent App has a different package identity; its Keystore credentials are not automatically migrated into this App.

Main actions stay hidden before component installation. Afterwards, the toggle, QR generation and Copy pairing link buttons share one row. Copy stays visible but disabled without valid pairing data. From plugin 0.8.3, when pairing data is valid but no QR image was generated, you can copy it and paste it into the App's iroh pairing screen. Copying does not generate another pairing code.

To reclaim component storage, turn off iroh remote access, expand the component details and choose **Remove the downloaded iroh component**. This removes only the pinned program downloaded by this plugin, keeping identities, pairings and external companion packages. Later use can reinstall it or reuse a verified external copy. Removal while enabled is refused by the management API as well as the panel.

## Security boundaries

- The sidecar proxies only to a `127.0.0.1`/`::1` loopback gateway with end-to-end TLS; commands and events are versioned and bounded (16 KiB command lines, 64 KiB peer lines), and rejected closed on unknown fields.
- A rotated fingerprint, replaced binary, or moved file fails verification instead of silently running a stale one: a missing or damaged component parks the channel at `unavailable`, while an identity or TLS fingerprint mismatch reports `error` (`gateway_start_failed`).
- Transport revocation and device-token revocation are separate authorizations; their unified management is Phase 2 work. Computer-side revocation keeps working through the existing device management.

## Troubleshooting

Store the iroh identity and certificates in a directory tree writable only by the current user or trusted system accounts. DSH's default state under the Windows user profile usually qualifies; custom locations also need private ancestors, and even the default location is rejected when an ancestor grants write or replacement rights to another account (some AppData, shared or redirected profiles). Do not loosen ACLs, delete real identities or move state into untrusted storage to bypass that refusal. Back up and preserve existing identity files.

Before a component release, verify first use with the exact catalog-pinned executable, not only a locally compiled host or a directory initialized by hand. The controller invokes `tls-prepare` because `id` only reads existing identity state. On Windows, `DSH_IROH_PINNED_FIRST_USE=<verified executable> npx vitest run tests/iroh-pinned-first-use.test.ts` checks initialization, reuse and corruption refusal in owned private storage. A failure blocks component acceptance; do not loosen directory ACL checks or replace real identities to make it pass.

| Symptom | Meaning |
| --- | --- |
| `iroh_companion_missing` | Nothing installed yet: press Install first, or point `DSH_MOBILE_IROH_COMPANION` at a companion absolute path to reuse |
| `iroh_sidecar_invalid` | An installed file was modified; reinstalling overwrites it in place, or reinstall the companion for a damaged companion copy |
| `iroh_platform_unsupported` | No sidecar is published for this OS/architecture |
| `iroh_data_directory_insecure` | A Windows parent directory of the state path grants write or replacement rights to another account. Move `DSH_HOME` to private storage or correct those ACLs; the plugin log retains the sidecar's bounded stderr explanation |
| `iroh_identity_invalid` / `iroh_identity_failed` | Check private permissions on the state directory and its ancestors and check for damaged identity files, preserving originals. `id` reads an existing identity; first use invokes `tls-prepare`, not copying or deleting an identity |
| `iroh_start_timeout` | Inspect iroh errors in the DSH log and network connectivity, and verify that the pinned component runs; repeated pairing is not a substitute for process diagnosis |
| Channel `ready` but no phone connects | Check that the App is the full build, the device supports a packaged ABI and the descriptor is fresh. Computer readiness does not establish phone connectivity; a relay-service connection alone does not establish that data uses the relay |

## Ready channel but failed mobile customization

Desktop `ready` means the local component and endpoint are prepared, not that the phone loaded every manifest, stylesheet, script and event stream. If conversations work but customization fails, distinguish manifest and resource failures using the page notice and contemporaneous redacted HTTP diagnostics. `parser/400/other` does not identify a malformed request; a `transport` reset does not establish a server rejection. See [slow-link diagnostics](SLOW_CONNECTIONS.en.md).

If scanning fails while copied content pairs successfully, report the scanner entry, App version and elapsed time since generation separately. Do not upload the descriptor, QR code or pairing key. Channel readiness does not establish a fix; do not disable certificate verification, clear existing pairings or change global proxy settings as a diagnostic shortcut.

## VPN, proxies and network environments

iroh prefers direct connections with relay fallback. Direct connections use QUIC/UDP; discovery and relays also need their network services to be reachable. The following environment factors **can** interfere; they are troubleshooting directions, not confirmed failure mechanisms for every VPN or network:

- **Global VPN/TUN** (system-level virtual adapters) may take over UDP and DNS so that neither direct nor relay handshakes complete. One user on Win11 + WSL2 mirrored networking over mobile data reported ~6 s to connect after disabling the global VPN, and recovery after excluding DSH Mobile from the VPN. This is community evidence, not a statement about every VPN/network combination or both ABIs.
- **DNS policy** (fake-IP, filtering): discovery depends on DNS resolution; fake-IP modes may resolve discovery domains to a proxy virtual IP.
- **Loopback entry**: the app reaches the local gateway via `*.iroh.localhost`; this loopback address should not be handed to a remote proxy/DNS.

Things to try (voluntary, subject to your own security policy):

1. Add DSH Mobile (package `io.github.sayach.dshmobile`) to a per-app bypass/exclusion list in your VPN/proxy client; debug builds and the standalone experimental app use different package names. This is the community Android App, not the official DSH Desktop application; configure the one you actually installed.
2. If your client supports per-domain rules, set discovery/relay domains to direct. Clash Meta example (illustrative; use your client's syntax): `DOMAIN-SUFFIX,iroh.link,DIRECT`; with fake-ip, add `+.iroh.link` to `fake-ip-filter`. Domain rules only cover client-side resolution — they **cannot** cover all direct peer IPs, relay services and loopback paths, and must not be summarized as "no UDP means it can never work".
3. `*.iroh.localhost` is the app's local entry point and must not be sent to a remote proxy/DNS.
4. Always-on/lockdown VPN policies may not allow per-app bypass; this plugin will not bypass system security policy, disable certificate verification, or force network switches.

A native "detect VPN and warn" is only an optional follow-up; the current version has no such feature, and whether to run a VPN remains the user's decision.

Chinese version: [IROH.md](IROH.md).
