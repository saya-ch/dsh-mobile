/** Validate the self-contained question-card component before packaging. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const mobile = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const companion = JSON.parse(await readFile(new URL('packages/question-fixes/package.json', root), 'utf8'))
assert.equal(companion.name, 'dsh-mobile-question-fixes')
assert.equal(companion.private, true, 'The embedded component is not published separately')
assert.equal(mobile.version, companion.version, 'The component must belong to this Mobile artifact')
assert.match(companion.version, /^\d+\.\d+\.\d+$/u)
assert.ok(mobile.workspaces.includes('packages/question-fixes'), 'Source installs must link the companion workspace')
assert.ok(!(mobile.bundledDependencies ?? []).includes(companion.name), 'The component must not depend on nested node_modules resolution')
assert.equal(mobile.dependencies[companion.name], undefined, 'The component ships inside the Mobile artifact')
assert.ok(mobile.files.includes('packages/question-fixes/package.json'))
assert.ok(mobile.files.includes('packages/question-fixes/lib/**'))
assert.equal(companion.dsh.client.platform, 'web')
assert.equal(companion.exports['./client'].default, './lib/client.js')
assert.equal(companion.exports['.'].default, './lib/index.mjs')
assert.equal(companion.license, mobile.license)
assert.equal(await readFile(new URL('packages/question-fixes/LICENSE', root), 'utf8'), await readFile(new URL('LICENSE', root), 'utf8'))
console.log(`Embedded component ${companion.name}@${companion.version} is ready for packaging`)
