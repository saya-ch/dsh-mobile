# Third-party notices

## Brand artwork

The Android launcher whale-mark variants were contributed by [@abworks-dev in PR #175](https://github.com/saya-ch/dsh-mobile/pull/175), which describes rendering the DeepSeek whale SVG path. They identify the upstream brand; DSH Mobile remains a community-maintained client, not an official DeepSeek Android application or an assertion of endorsement. This repository's code license does not assert ownership of third-party names or marks. The default character artwork and repository hero remain the project's existing brand assets.

## Runtime components

DSH Mobile includes platform-specific Windows and Linux Funnel helpers built from the source in `native/funnel-host`. They use [Tailscale tsnet](https://pkg.go.dev/tailscale.com/tsnet) `v1.102.3`, distributed under the BSD 3-Clause license. The exact statically linked Go module versions and complete license and notice texts are generated from the bundled Windows x64 helper into `FUNNEL_THIRD_PARTY_LICENSES.txt` by `scripts/funnel-third-party-licenses.mjs`; that generator reads only `bin/dsh-mobile-funnel-win32-x64.exe` and records only that executable's SHA-256, and the resulting file is included in every npm package. The Linux x64 and Linux arm64 helpers are built from the same sources, but their embedded module metadata is not read by that generator and must be verified separately before publishing a change under `native/funnel-host`.

The optional cpolar component is not included in the npm package or Android App. When a user explicitly chooses cpolar installation, DSH Mobile downloads the pinned official archive shown in the UI, verifies its size and SHA-256 digest, and stores it only under the user's DSH Mobile data directory. cpolar remains subject to its [terms of service](https://www.cpolar.com/tos).

The optional [FRP](https://github.com/fatedier/frp) client is not included in the npm package or Android App. When a user explicitly chooses self-hosted FRP installation, DSH Mobile downloads the pinned official `frpc` 0.70.1 archive, verifies its origin, exact size, SHA-256 digest, archive paths, and executable version, then stores only `frpc` under the user's DSH Mobile data directory. FRP is distributed under the Apache License 2.0.

The optional [cloudflared](https://github.com/cloudflare/cloudflared) client is not included in the npm package or Android App. When a user explicitly chooses cloudflared installation, DSH Mobile downloads the pinned official release asset for the supported host platform (version recorded in `src/cloudflared-component.ts`), verifies its exact size and SHA-256 digest, and stores it only under the user's DSH Mobile data directory. The client is started with automatic updates disabled. Quick tunnels do not require account credentials; named tunnels use an operator-supplied connector token stored in the plugin's private directory. cloudflared is distributed under the Apache License 2.0; use of Cloudflare's quick tunnels remains subject to Cloudflare's [website terms](https://www.cloudflare.com/website-terms/).

The optional managed Caddy component is not included in the npm package or Android App. Since plugin 0.6.9, users on Windows/Linux x64 can explicitly confirm an on-demand download of the fixed [DSH Mobile component distribution](https://github.com/saya-ch/dsh-mobile/releases/tag/caddy-component-2.11.7-tencentcloud-0.4.3-r1); its source, exact size and SHA-256 are pinned in the plugin. This distribution builds [Caddy v2.11.7](https://github.com/caddyserver/caddy/blob/v2.11.7/LICENSE), under Apache License 2.0, with [caddy-dns/tencentcloud v0.4.3](https://github.com/caddy-dns/tencentcloud/blob/v0.4.3/LICENSE), under the MIT License. The component release supplies each platform's exact embedded dependency manifest, Go build metadata and complete third-party license/notice texts as separate assets. It is a DSH Mobile build, not an upstream Caddy release or a dynamically generated download. Existing user-managed proxies are separate from this optional component.

The experimental Rust transport is adapted from [dsh-mobile-iroh](https://github.com/saya-ch/dsh-mobile-iroh), copyright 2026 Guangqi Zhang, under the MIT License, and the host baseline preserves zexadev's MIT-licensed dsh-tether attribution. The source notices and complete licenses are retained under `native/iroh-host/` and included with the npm package. The optional sidecar is not bundled: explicit installation reuses a verified companion copy or downloads the size- and SHA-256-pinned companion release payload. Enabling the channel alone does not download it.

The npm package declares direct runtime dependencies on Schemastery (`@deepseek-ai/schemastery`, upstream [shigma/schemastery](https://github.com/shigma/schemastery)) `^3.18.1`, [@noble/hashes](https://github.com/paulmillr/noble-hashes) `2.4.0`, [bonjour-service](https://github.com/onlxltd/bonjour-service) `1.4.4`, [eventsource-parser](https://github.com/rexxars/eventsource-parser) `4.1.3`, [qrcode](https://github.com/soldair/node-qrcode) `^1.5.4`, [selfsigned](https://github.com/jfromaniello/selfsigned) `^5.5.0`, [ws](https://github.com/websockets/ws) `8.22.0`, and [Zod](https://zod.dev/) `4.6.7`. These packages are distributed under the MIT License; the release checkout's exact transitive versions appear in the attached CycloneDX npm SBOM. This direct-dependency list and its declared version ranges are checked by `npm run check:notices`.

Browser Web Push uses [web-push](https://github.com/web-push-libs/web-push) `3.6.7`, distributed under the Mozilla Public License 2.0 (MPL-2.0), for payload encryption and VAPID signing/key generation. It remains an unmodified, external Node runtime dependency, not part of the browser bundle; its npm package supplies the covered source and license. DSH Mobile owns the bounded HTTPS transport and endpoint validation. Exact transitive versions appear in the [npm lockfile](<package-lock.json>) and release SBOM.

The Android App runtime contains [Kotlin standard library](https://github.com/JetBrains/kotlin) `2.2.10`, [kotlinx.coroutines](https://github.com/Kotlin/kotlinx.coroutines) `1.6.4`, [JetBrains annotations](https://github.com/JetBrains/java-annotations) `13.0`, [AndroidX Core](https://developer.android.com/jetpack/androidx/releases/core) `1.15.0`, [AndroidX WebKit](https://developer.android.com/jetpack/androidx/releases/webkit) `1.18.0`, their AndroidX transitive components, [Guava listenablefuture](https://github.com/google/guava) `1.0`, and [ZXing Core](https://github.com/zxing/zxing) `3.5.4`. These runtime libraries are distributed under the Apache License 2.0; the exact resolved tree is attached to each release as `dsh-mobile-android-v<version>-dependencies.txt`.

The full Android APK packages `libdsh_mobile_iroh_android_transport.so` for arm64-v8a and x86_64, from `native/iroh-android-transport` and `native/iroh-core`. It includes the matching `org.rustls:rustls-platform-verifier` JVM component from an immutable official Maven archive, selecting its version from the Android shim entry in `native/Cargo.lock`. These transport sources retain their MIT license; the surrounding Android shell remains Apache-2.0. The compatibility APK uses `-PirohNative=false` and contains neither native libraries nor the JVM verifier dependency; it retains installation support for 32-bit devices. Both builds include the third-party notices asset.

### Rust workspace dependency metadata

The inventory made with `cargo metadata --locked --manifest-path native/Cargo.toml` describes the whole Rust workspace, including target-specific and development dependencies. It is not an inventory of code linked into either Android ABI, nor a complete set of license/notice texts for distribution. The exact versions remain in `native/Cargo.lock`.

Before publishing a native-enabled APK, identify the dependencies actually shipped for each target, retain the applicable license and notice texts with the distribution, and verify any source-availability obligations. The source MIT notices retained here do not by themselves complete that release check.

#### Where the complete license texts live

The upstream `dsh-mobile-iroh` companion package ships a generated
`native/THIRD_PARTY_NOTICES.txt` (~2.9 MB). It lists each dependency's declared
license, crates.io source and the full reproduced license text, and its header states
it covers build-time dependencies for the Windows x64, Linux x64, Android arm64 and
Android x64 targets. The two entries that need more than a one-line note are present in
full:

- **`attohttpc` 0.30.1** and **`option-ext` 0.2.0** — complete Mozilla Public License
  2.0 text. MPL-2.0 is file-level copyleft: static linking and distribution inside a
  larger work is permitted, the MPL-covered source stays available under MPL-2.0 from
  the sources named there, and no DSH Mobile source file is derived from them.
- **`r-efi`** offers `MIT OR Apache-2.0 OR LGPL-2.1-or-later`; the permissive option is
  taken, so LGPL-2.1 does not apply.

Both APK variants bundle this notice at `assets/THIRD_PARTY_NOTICES.txt`, based on
the published companion package with both transport source licenses and the MIT
text for Windows build dependency `winapi-util` added from their sources. `node scripts/check-iroh-notices.mjs`
checks coverage of each Android ABI's normal/build graph. When `native/Cargo.lock`
changes, regenerate the notice and replace this asset so the shipped texts stay current. See the [iroh
guide](docs/IROH.en.md) for the full and compatibility APK requirements.

## Notification identity hashing

The client bundle includes the SHA-256 implementation from @noble/hashes to derive bounded notification tags from complete IDs. Its MIT license is included below:

```text
The MIT License (MIT)

Copyright (c) 2022 Paul Miller (https://paulmillr.com)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the “Software”), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## Event-stream parsing

The Gateway uses eventsource-parser for Server-Sent Events framing. Its MIT license is included below:

```text
MIT License

Copyright (c) 2026 Espen Hovlandsdal <espen@hovlandsdal.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## core-js browser compatibility bundle

The standalone `lib/mobile-compat.js` bundles selected compatibility modules, including Iterator, `Promise.withResolvers`, collection methods and structured cloning, from [core-js](https://github.com/zloirock/core-js) `^3.50.0` (exact version recorded in `package-lock.json`). It is built into the npm package; browsers do not download a polyfill from a CDN. core-js is distributed under the following MIT License:

```text
Copyright (c) 2013–2025 Denis Pushkarev (zloirock.ru)
Copyright (c) 2025–2026 CoreJS Company (core-js.io)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
