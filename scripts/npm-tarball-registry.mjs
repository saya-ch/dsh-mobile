/** Read-only loopback registry for one actual npm tarball in installation smokes. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { packedManifest } from './packed-profile.mjs'

/** Serve the owned package and let pnpm obtain other dependencies from the public registry. */
export async function tarballRegistry(tarball) {
  const manifest = await packedManifest(tarball)
  if (manifest.name !== 'dsh-mobile' || typeof manifest.version !== 'string') throw new Error('Unexpected Mobile tarball')
  const bytes = await readFile(tarball)
  const requests = []
  const tarballPath = `/dsh-mobile/-/dsh-mobile-${manifest.version}.tgz`
  let origin
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname
    requests.push(path)
    if (request.method !== 'GET') { response.writeHead(405).end(); return }
    if (path === '/dsh-mobile') {
      const metadata = { ...manifest, dist: { tarball: `${origin}${tarballPath}`, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` } }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ name: manifest.name, 'dist-tags': { latest: manifest.version }, versions: { [manifest.version]: metadata } }))
    } else if (path === tarballPath) {
      response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(bytes)
    } else {
      const upstream = new URL(request.url, 'https://registry.npmjs.org')
      if (upstream.origin !== 'https://registry.npmjs.org') { response.writeHead(400).end(); return }
      response.writeHead(307, { location: upstream.href }).end()
    }
  })
  await new Promise((fulfill, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', fulfill) })
  origin = `http://127.0.0.1:${server.address().port}`
  return {
    origin, requests,
    async close() {
      const done = new Promise((fulfill, reject) => { server.close(error => error === undefined ? fulfill() : reject(error)) })
      server.closeAllConnections()
      await done
    },
  }
}
