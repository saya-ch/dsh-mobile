import { describe, expect, it } from 'vitest'

const checker: { checkClientBundleImports: (source: string, runtimeDependencies?: readonly string[]) => void } =
  await import(new URL('../scripts/check-client-bundle.mjs', import.meta.url).href)

describe('browser client dependency imports', () => {
  it('rejects unbundled runtime libraries and their subpaths while retaining supplied peers', () => {
    for (const specifier of ['@noble/hashes', '@noble/hashes/sha2.js', '@noble/hashes/utils.js']) {
      expect(() => checker.checkClientBundleImports(`const hash = require('${specifier}')`, ['@noble/hashes']))
        .toThrow('runtime dependencies must be bundled')
    }
    expect(() => checker.checkClientBundleImports('const React = require("react");', ['@noble/hashes'])).not.toThrow()
    expect(() => checker.checkClientBundleImports('const hash = (value) => value;', ['@noble/hashes'])).not.toThrow()
    expect(() => checker.checkClientBundleImports('require("@noble/hashes-extra")', ['@noble/hashes'])).not.toThrow()
  })

  it('rejects Node builtin imports independently of runtime dependency declarations', () => {
    for (const specifier of ['node:crypto', 'fs/promises']) {
      expect(() => checker.checkClientBundleImports(`require('${specifier}')`)).toThrow('Node builtins')
    }
  })
})
