# Third-party notices

DSH Mobile includes platform-specific Windows and Linux Funnel helpers built from the source in `native/funnel-host`. They use [Tailscale tsnet](https://pkg.go.dev/tailscale.com/tsnet) `v1.102.3`, distributed under the BSD 3-Clause license. Their exact statically linked Go module versions and complete license and notice texts are generated from the bundled executables into `FUNNEL_THIRD_PARTY_LICENSES.txt`, which is included in every npm package.

The optional cpolar component is not included in the npm package or Android App. When a user explicitly chooses cpolar installation, DSH Mobile downloads the pinned official archive shown in the UI, verifies its size and SHA-256 digest, and stores it only under the user's DSH Mobile data directory. cpolar remains subject to its [terms of service](https://www.cpolar.com/tos).

The optional [FRP](https://github.com/fatedier/frp) client is not included in the npm package or Android App. When a user explicitly chooses self-hosted FRP installation, DSH Mobile downloads the pinned official `frpc` 0.70.1 archive, verifies its origin, exact size, SHA-256 digest, archive paths, and executable version, then stores only `frpc` under the user's DSH Mobile data directory. FRP is distributed under the Apache License 2.0.

The optional [cloudflared](https://github.com/cloudflare/cloudflared) client is not included in the npm package or Android App. When a user explicitly chooses cloudflared installation, DSH Mobile downloads the pinned official release asset for the supported host platform (version recorded in `src/cloudflared-component.ts`), verifies its exact size and SHA-256 digest, and stores it only under the user's DSH Mobile data directory. The client is started with automatic updates disabled. Quick tunnels do not require account credentials; named tunnels use an operator-supplied connector token stored in the plugin's private directory. cloudflared is distributed under the Apache License 2.0; use of Cloudflare's quick tunnels remains subject to Cloudflare's [website terms](https://www.cloudflare.com/website-terms/).

The npm package declares direct runtime dependencies on [Schemastery](https://github.com/shigma/schemastery) `^3.18.1`, [bonjour-service](https://github.com/onlxltd/bonjour-service) `1.4.4`, [qrcode](https://github.com/soldair/node-qrcode) `^1.5.4`, and [selfsigned](https://github.com/jfromaniello/selfsigned) `^5.5.0`. These packages are distributed under the MIT License; the release checkout's exact transitive versions appear in the attached CycloneDX npm SBOM.

The Android App runtime contains [Kotlin standard library](https://github.com/JetBrains/kotlin) `2.1.0`, [kotlinx.coroutines](https://github.com/Kotlin/kotlinx.coroutines) `1.6.4`, [JetBrains annotations](https://github.com/JetBrains/java-annotations) `13.0`, [AndroidX Core](https://developer.android.com/jetpack/androidx/releases/core) `1.15.0`, [AndroidX WebKit](https://developer.android.com/jetpack/androidx/releases/webkit) `1.17.1`, their AndroidX transitive components, [Guava listenablefuture](https://github.com/google/guava) `1.0`, and [ZXing Core](https://github.com/zxing/zxing) `3.5.4`. These runtime libraries are distributed under the Apache License 2.0; the exact resolved tree is attached to each release as `dsh-mobile-android-v<version>-dependencies.txt`.

## core-js browser compatibility bundle

The standalone `lib/mobile-compat.js` bundles selected Iterator modules from [core-js](https://github.com/zloirock/core-js) `^3.50.0` (exact version recorded in `package-lock.json`). It is built into the npm package; browsers do not download a polyfill from a CDN. core-js is distributed under the following MIT License:

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
