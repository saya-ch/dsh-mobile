// Test-only preload: never delegates to native fetch or reads a profile/credential store.
import assert from 'node:assert/strict'
import { appendFileSync, readFileSync } from 'node:fs'

const { repository, tag, commit, assets, mode, trace, channel = 'review' } = JSON.parse(readFileSync(process.env.CADDY_TEST_FETCH_INPUT, 'utf8'))
const token = 'synthetic-caddy-review-token-not-a-secret'
assert.equal(process.env.GH_TOKEN, token)
const names = Object.keys(assets).sort()
const binary = names.find(name => name.endsWith('-linux-x64'))
const sidecar = names.find(name => name.endsWith('.modules.txt'))
const apiRoot = `https://api.github.com/repos/${repository}`
const releaseUrl = `${apiRoot}/releases/tags/${encodeURIComponent(tag)}`
const latestUrl = `${apiRoot}/releases/latest`
const commitUrl = `${apiRoot}/commits/${encodeURIComponent(tag)}`
const publicUrl = name => `https://github.com/${repository}/releases/download/${tag}/${name}`
const redirectUrl = name => `https://release-assets.githubusercontent.com/test/${name}?signed=synthetic`
const release = { draft: false, prerelease: channel === 'review', tag_name: tag, target_commitish: commit,
  assets: names.map(name => ({ name, browser_download_url: publicUrl(name), size: assets[name].size, digest: 'sha256:' + assets[name].sha256 })) }
// Wrong publication targets the other commit; a moved tag retains the original release target.
if (mode === 'wrong-commit') release.target_commitish = 'c'.repeat(40)
if (mode === 'draft') release.draft = true
if (mode === 'non-prerelease') release.prerelease = channel !== 'review'
if (mode === 'wrong-tag') release.tag_name = tag + '-wrong'
if (mode === 'missing-asset') release.assets.pop()
if (mode === 'extra-asset') release.assets.push({ ...release.assets[0], name: 'unexpected.txt' })
if (mode === 'duplicate-asset') release.assets[1] = { ...release.assets[0] }
for (const [failure, name, key, value] of [
  ['bad-binary-digest', binary, 'digest', 'sha256:' + '0'.repeat(64)],
  ['bad-binary-size', binary, 'size', assets[binary].size + 1],
  ['bad-binary-url', binary, 'browser_download_url', publicUrl(binary) + '?untrusted=1'],
  ['tampered-sidecar-digest', sidecar, 'digest', 'sha256:' + '0'.repeat(64)],
]) if (mode === failure) release.assets.find(asset => asset.name === name)[key] = value

// Assert headers/redirect policy before emitting any response; unexpected URLs fail closed.
globalThis.fetch = async (input, options = {}) => {
  const url = String(input)
  const headers = new Headers(options.headers)
  assert.ok(options.signal instanceof AbortSignal, 'bounded request required')
  const api = url === releaseUrl || url === commitUrl || url === latestUrl
  if (api) {
    assert.equal(options.redirect, 'error')
    assert.equal(headers.get('authorization'), 'Bearer ' + token)
    assert.equal(headers.get('accept'), 'application/vnd.github+json')
    assert.equal(headers.get('x-github-api-version'), '2022-11-28')
  } else {
    assert.equal(headers.get('authorization'), null, 'token must never reach public assets')
    assert.equal([...headers].length, 0, 'API headers must not reach public assets')
  }
  const name = names.find(name => url === publicUrl(name) || url === redirectUrl(name))
  assert.ok(api || name, 'unexpected network URI blocked')
  appendFileSync(trace, JSON.stringify({ url, redirect: options.redirect, authorization: headers.has('authorization') }) + '\n')
  if (api) {
    if (url === latestUrl) {
      if (mode === 'latest404') return new Response(null, { status: 404 })
      if (mode === 'latest-network') throw new TypeError('synthetic API network failure')
      if (/^latest-(401|403|500)$/u.test(mode)) return new Response(null, { status: Number(mode.slice(7)) })
      if (mode === 'latest-malformed') return Response.json({})
      if (mode === 'latest-null') return Response.json(null)
      if (mode === 'latest-json') return new Response('not-json')
      return Response.json({ tag_name: mode === 'latest-component' ? tag : mode === 'latest-other-component' ? 'caddy-component-2.11.5-tencentcloud-0.4.3' : 'v0.6.2', draft: false, prerelease: false })
    }
    const fault = /^api-(release|commit)-(401|403|500|network)$/u.exec(mode)
    if (fault && url === (fault[1] === 'release' ? releaseUrl : commitUrl)) {
      if (fault[2] === 'network') throw new TypeError('synthetic API network failure')
      return new Response(null, { status: Number(fault[2]) })
    }
    if ((mode === 'malformed-release' && url === releaseUrl) || (mode === 'malformed-commit' && url === commitUrl)) return Response.json({})
    return Response.json(url === releaseUrl ? release : { sha: ['wrong-commit', 'moved-commit'].includes(mode) ? 'c'.repeat(40) : commit })
  }
  if (url === publicUrl(name)) {
    assert.equal(options.redirect, 'manual')
    return new Response(null, { status: 302, headers: { location: mode === 'untrusted-redirect' ? 'https://example.invalid/asset' : redirectUrl(name) } })
  }
  assert.equal(options.redirect, 'error')
  const bytes = Buffer.from(assets[name].base64, 'base64')
  if ((mode === 'corrupt-public-binary' && name === binary) || (mode === 'corrupt-public-sidecar' && name === sidecar)) bytes[0] ^= 1
  return new Response(bytes, { headers: { 'content-length': String(bytes.length) } })
}
