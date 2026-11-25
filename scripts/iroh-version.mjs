#!/usr/bin/env node
/**
 * Print the iroh companion version this plugin pins.
 *
 * The version appears in several places: the pin catalog, the Windows client's
 * provisioner, the client's manifest mirror, and CI jobs that fetch the published
 * artifact to test first use. Copying it by hand let the CI copy drift one release
 * behind, which made the iroh host job fetch alpha.1 bytes and compare them against
 * the alpha.2 pins. Anything that needs the version asks this instead.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(resolve(root, 'src/iroh-component.ts'), 'utf8')
const match = /export const IROH_VERSION = '([^']+)'/u.exec(source)
if (match?.[1] === undefined) {
  console.error('iroh version: src/iroh-component.ts declares no IROH_VERSION')
  process.exit(1)
}
process.stdout.write(match[1])
