# Managed Caddy

[中文](CADDY_MANAGED.md)

> Since plugin 0.6.9, Windows/Linux x64 can install managed Caddy on demand for plugin-managed HTTPS and certificates. The component is a fixed build reviewed and published by DSH Mobile, not the Caddy custom-download service. Existing Cloudflared channels and external proxies remain available; no migration or Android app update is required.

## Requirements

Managed Caddy manages an HTTPS proxy and certificates; it is not a NAT traversal service. You need a domain whose DNS-01 challenge records the Tencent Cloud DNSPod credentials can update, plus a public HTTPS inbound port that reaches the DSH computer. If the computer sits behind a router you control, forward the public port to its local Caddy port; on a cloud host, check its security group and host firewall instead. DNS-01 proves domain control but cannot bypass CGNAT, campus isolation, or an unavailable inbound route. Use Cloudflare Tunnel, cpolar, or FRP on an existing VPS for those networks.

The panel currently supports only the `tencentcloud` DNS module and Tencent Cloud DNSPod credentials; another DNS provider's key cannot be used in this mode. Cloudflare DNS users can keep using Cloudflared without migrating DNS for this feature; do not enter a Cloudflared connector token in the Tencent Cloud credential fields.

```text
Android App / browser → public HTTPS hostname (Caddy terminates TLS)
                      → dedicated HTTP Gateway on 127.0.0.1
                      → current DSH WebServer
```

## Relationship to an external proxy

These are upstream modes of the same own-proxy provider. External mode remains the default: you manage Lucky, Nginx, or Caddy, and the plugin provides the HTTP backend. Managed mode owns a separate Caddy child and loopback Gateway, stopping the previous mode before starting the next. External proxy settings and paired-device records are retained, never overwritten by managed settings.

Configure the public HTTPS origin, DNS-01 credentials and local HTTPS port separately. The public URL can use port 443 while the router forwards to local port 8443; the local port is what Caddy actually binds. Its range is 1024–65535, excluding reserved ports 3080, 3443 and 3444. Check that it is unused and permit the required HTTPS ingress through the host firewall, router or cloud security group; never expose the loopback HTTP backend. Use a least-privilege DNS credential restricted to the required zone, not an account-wide cloud master key.

## Installation, startup, and readiness

1. On the computer, open **Mobile Access → Own reverse proxy** and choose **Managed Caddy**.
2. Choose **Install managed Caddy** and confirm the download. The plugin downloads the fixed [DSH Mobile component distribution](https://github.com/saya-ch/dsh-mobile/releases/tag/caddy-component-2.11.7-tencentcloud-0.4.3-r1), checking its exact length, SHA-256, core and DNS module versions. Unavailable or invalid assets are not executed.
3. Enter the public HTTPS origin, such as `https://dsh.example.com`, select Tencent Cloud DNSPod, supply a `SecretId` and `SecretKey` with the required zone permissions, and set the local HTTPS port, such as `8443`. Point the domain at the public ingress and, where needed, forward public TCP 443 to port 8443 on the computer.
4. Choose **Save and start Caddy**. Installed is not ready: the panel reports readiness only after a computer-side public HTTPS probe validates the certificate and confirms that the entry belongs to the current DSH instance. That probe still does not prove phone-network reachability.
5. Generate a pairing QR code in the Remote panel (the button carries the same label as the LAN one) and scan it from **Remote access** in the Android app, or open the pairing link in a mobile browser. Use the phone's cellular connection to check actual page loading, session synchronization and WebSockets; a computer-side health check alone does not establish phone access.

Initial DNS-01 issuance waits for DNS propagation and certificate issuance. Keep the computer online and avoid repeated restarts that can trigger issuer limits. Managed mode creates no system service, PATH entry, startup item, or system trust-store certificate. Caddy's admin API and configuration autosave are disabled.

## Privacy and cleanup

Settings and DNS credentials are atomically stored in the plugin's private directory. The Caddyfile contains environment placeholders, never the credentials. The child receives only necessary DNS credentials and runtime environment, not unrelated API secrets, proxy overrides, or admin-address overrides. Raw DNS module logs are not retained. Certificates, private keys, configuration caches, and runtime files also stay in the private directory.

Stopping access or changing provider waits for Caddy and Gateway termination, retaining settings and certificates for the next connection. Confirming removal deletes the managed binary, DNS credentials, certificate keys, logs, and caches without deleting other providers, LAN settings, or paired-device data. A cleanup failure is reported and retains retryable state rather than claiming the deletion completed. Existing manually installed proxies are not owned or uninstalled by the plugin.

## Maintainer build and validation

Run these build and validation tools from a source checkout of this repository. The npm plugin package does not include these maintenance scripts; ordinary users do not need to compile Caddy.

The [builder](<https://github.com/saya-ch/dsh-mobile/blob/main/scripts/build-caddy-component.mjs>) fixes Go 1.26.9, xcaddy v0.4.7, Caddy v2.11.7, Tencent Cloud DNS v0.4.3 and golang.org/x/net v0.60.0. The [input lock](<https://github.com/saya-ch/dsh-mobile/blob/main/scripts/caddy-component-lock.json>) freezes source revisions and compiled dependency versions/checksums. Each build uses fresh private compiler AND module caches, normal Go checksum verification, source-origin checks and retained-module verification. Unknown dependencies, replacements, wrong native settings or compiler versions fail closed before executing the generated Caddy.

Use the exact Go compiler (optionally through `GO_BINARY`); output directories must be new and absolute:

```sh
node scripts/build-caddy-component.mjs --output-dir /absolute/new/first
node scripts/build-caddy-component.mjs --output-dir /absolute/new/second
node scripts/compare-caddy-builds.mjs --first /absolute/new/first --second /absolute/new/second --target linux-x64
```

Windows uses native absolute paths and `--target win32-x64`. Reproducibility means identical executable bytes/size/SHA-256, not identical OS images or every rendered metadata/license file. The [workflow](<https://github.com/saya-ch/dsh-mobile/blob/main/.github/workflows/caddy-component.yml>) natively builds twice on Windows/Linux x64, validates complete evidence and tests the actually installed binary with an independent manifest. Tests cover real default inspection/promotion, no-redownload restart, corrupt-download rollback, TLS/pairing/API/WSS, durable device credentials and stopped-process owned cleanup while neighboring/pairing data survives. Other targets remain unreviewed.

PR and normal dispatch runs are read-only review-artifact builds. Only an explicit manual opt-in on an existing `caddy-component-2.11.7-tencentcloud-0.4.3-review.N` tag in the authorized `abworks-dev/dsh-mobile` fork can publish a **TEST prerelease**, after both native jobs pass:

```sh
gh workflow run caddy-component.yml --repo abworks-dev/dsh-mobile --ref caddy-component-2.11.7-tencentcloud-0.4.3-review.1 -f publish_review_prerelease=true
```

Component tags never start with `v`, avoiding the plugin release trigger. The separate write-permission job refuses occupied releases, creates a non-latest draft prerelease without asset clobbering, verifies an authenticated download of every draft asset against prepared bytes, then publishes. Assets include platform-distinct raw executables, manifests, build/module/version/license records, double-build proof, source-commit/run identity and SHA256SUMS. The [verifier](<https://github.com/saya-ch/dsh-mobile/blob/main/scripts/verify-caddy-release.mjs>) checks **every published asset** through GitHub metadata and the actual installer's HTTPS/validated-redirect downloader before emitting a review-only catalog. A failed post-publication check leaves the labelled prerelease public, fails the job and emits no catalog; it does not silently delete or roll back a release. Artifact retention is 14 days; release assets are separate.

The public custom-download endpoint returned v2.11.7 when v2.11.6 was requested; dynamic latest downloads are not a trust source. Versioned GitHub URLs can still be replaced by repository owners: exact reviewed byte/hash pins, not URL spelling or a remotely supplied checksum alone, define the content boundary. A fork catalog is only a review candidate; it never automatically populates the [production table](<https://github.com/saya-ch/dsh-mobile/blob/main/src/caddy-component.ts>).

### Official distribution and installation enablement

A maintainer with repository publication access reviews the candidate and dispatches publication manually. One maintainer is sufficient: a second approver and a preconfigured GitHub Environment are not required. Both publication inputs default to false, so PR and ordinary builds cannot publish. Contributor tests may be accepted within their stated version, environment and observed scope without rebuilding the same environment on the maintainer's computer. Isolated tests or an older candidate must not be reported as public issuance or renewal acceptance of a new binary.

Official publication accepts only the public `saya-ch/dsh-mobile` repository and version-bound non-`v` tag `caddy-component-2.11.7-tencentcloud-0.4.3-r1`. The maintainer creates that tag on the reviewed main commit and explicitly dispatches the existing workflow with `publish_official_release=true` and review input false. Existing tags are never moved or overwritten; this publication-preparation correction uses the new fixed `-r1` revision tag and retains the original tag. The publisher checks that the tag SHA equals this Actions SHA and belongs to main, and requires both platforms' independent double builds, native tests and plugin builds from that same run. Wrong events, branches, repositories, conflicting inputs, failed native jobs and mismatched tags reject publication.

The single publisher uses `contents: write` and the existing `GITHUB_TOKEN` to create a non-latest official component distribution, not npm or APK. It refuses occupied releases, downloads and byte-compares all 16 draft assets, then publishes and independently verifies public metadata, lengths and hashes through the installer's actual HTTPS downloader. Verification failure preserves the actual public state and fails the job; it never deletes or destructively retries publication.

Component updates have two stages: publish and verify the official distribution, then separately review the plugin catalog change that pins the actual public binaries' source, size and SHA-256 in `CADDY_COMPONENT_RELEASES`. Version 0.6.9 enables the fixed Windows/Linux x64 catalog; publishing another component asset does not automatically change the version users run.

The prepare/verify CLI defaults to review; the final `--channel official` selects official identity validation. Successful verification emits `official-candidate-not-production` with `productionCatalogEnabled: false`: this JSON is review input, not runtime configuration, and cannot enable installation by itself. Contributor real-world feedback is accepted within its stated version and deployment scope.

Isolated validation uses ephemeral loopback listeners and a private internal CA with `skip_install_trust`; no system trust, production DNS or existing proxy is changed. This fixed component has not received separate public DNS-01/ACME issuance or long-cycle renewal acceptance. Issuance, renewal, public reachability and actual page/API/stream delivery need separate observations; isolated CI or an older candidate's real-world tests cannot substitute for them.
