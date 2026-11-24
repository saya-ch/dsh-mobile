#!/usr/bin/env node
/**
 * Assert the Windows client tag matches the version declared in the project file.
 *
 * The client ships on its own track (`windows-v<version>`), independent of the
 * plugin's `v<version>` tags and of the iroh sidecar pin, so the tag is the only
 * thing that says which build this is. Without this check a mistyped tag would
 * publish a package whose own metadata disagrees with its release name.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const project = fileURLToPath(new URL('../apps/windows/DshMobile.Win/DshMobile.Win.csproj', import.meta.url))
const source = readFileSync(project, 'utf8')
const match = /<Version>([^<]+)<\/Version>/u.exec(source)
if (match?.[1] === undefined) {
  console.error(`windows release check failed: ${project} declares no <Version>`)
  process.exit(1)
}
const declared = match[1].trim()
const ref = process.env.GITHUB_REF_NAME ?? ''
if (ref === '') {
  // Local run: report the declared version and succeed, so the check is usable
  // before a tag exists.
  console.log(`windows release version ok: project declares ${declared} (no tag to compare)`)
  process.exit(0)
}
const prefix = 'windows-v'
if (!ref.startsWith(prefix)) {
  console.error(`windows release check failed: tag ${ref} does not start with ${prefix}`)
  process.exit(1)
}
const tagged = ref.slice(prefix.length)
if (tagged !== declared) {
  console.error(`windows release check failed: tag says ${tagged} but the project declares ${declared}`)
  process.exit(1)
}
console.log(`windows release version ok: ${declared}`)
