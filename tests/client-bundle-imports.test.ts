import { describe, expect, it } from 'vitest'
import { LEGACY_CUSTOM_ASSET_LIMIT } from '../src/extension-limits.js'
import { MAX_MOBILE_BOOT_ENTRY_BYTES } from '../src/gateway.js'

const checker: {
  checkClientBundleImports: (source: string, runtimeDependencies?: readonly string[]) => void
  checkOwnedBundleSize?: (bytes: number, limit: number, label: string) => void
  checkOwnedBundleImports?: (source: string, supplied?: readonly string[]) => void
  OWNED_BOOT_BUNDLE_LIMIT?: number
  OWNED_BUNDLE_LIMITS?: Readonly<Record<string, number>>
} = await import(new URL('../scripts/check-client-bundle.mjs', import.meta.url).href)

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

describe('owned boot bundle size gate', () => {
  it('rejects a bundle the gateway would decline to serve on its own asset route', () => {
    const limit = MAX_MOBILE_BOOT_ENTRY_BYTES
    expect(() => checker.checkOwnedBundleSize!(limit + 1, limit, 'lib/mobile-graph-follower.js'))
      .toThrow(`lib/mobile-graph-follower.js is ${String(limit + 1)} bytes; the gateway serves an owned boot bundle only up to ${String(limit)} bytes`)
    expect(() => checker.checkOwnedBundleSize!(limit, limit, 'lib/mobile-graph-follower.js')).not.toThrow()
  })

  it('shares the gateway limit for owned boot bundles', () => {
    expect(checker.OWNED_BOOT_BUNDLE_LIMIT).toBe(MAX_MOBILE_BOOT_ENTRY_BYTES)
  })

  it('gates each owned bundle against the limit its own route serves', () => {
    // `src/gateway.ts` serves the follower as a boot entry and the other two under the customization cap.
    expect(checker.OWNED_BUNDLE_LIMITS).toEqual({
      'mobile-graph-follower.js': MAX_MOBILE_BOOT_ENTRY_BYTES,
      'mobile-layout.js': LEGACY_CUSTOM_ASSET_LIMIT,
      'mobile-compat.js': LEGACY_CUSTOM_ASSET_LIMIT,
    })
  })
})

describe('owned boot bundle imports', () => {
  const loader = (body: string, name = 'e'): string => `window.__ModuleLoader__.load({id:\`x\`,factory:${name}=>{${body}}})`

  it('accepts only the modules the DSH page supplies to the row, under the minified loader name', () => {
    const supplied = ['@deepseek-ai/dsh-api-gateway/client', 'zod']
    expect(() => checker.checkOwnedBundleImports!(loader('let r=e("@deepseek-ai/dsh-api-gateway/client"),i=e("zod");'), supplied)).not.toThrow()
    expect(() => checker.checkOwnedBundleImports!(loader('let i=e("left-pad");'), supplied))
      .toThrow('modules the DSH page does not supply: left-pad')
  })

  it('rejects Node builtins and falls back to the unminified loader name', () => {
    expect(() => checker.checkOwnedBundleImports!(loader('let fs=e("node:fs");'), [])).toThrow('Node builtins')
    expect(() => checker.checkOwnedBundleImports!('let z=require("zod");require("node:path")', ['zod'])).toThrow('Node builtins')
  })

  it('matches a loader name that contains a dollar sign and a bundle that takes nothing from the loader', () => {
    expect(() => checker.checkOwnedBundleImports!(loader('let i=$e("left-pad");', '$e'), ['zod']))
      .toThrow('modules the DSH page does not supply: left-pad')
    expect(() => checker.checkOwnedBundleImports!(loader('let fs=$e("node:fs");', '$e'), ['zod'])).toThrow('Node builtins')
    expect(() => checker.checkOwnedBundleImports!(loader('const ready=true;'), ['zod'])).toThrow('imports none of the modules')
  })
})
