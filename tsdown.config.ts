import { defineConfig, type UserConfig } from 'tsdown'

/** Standalone IIFE: no module loader or DSH services may be required at this point. */
export const mobileCompatibilityBuild = {
  entry: { 'mobile-compat': 'src/mobile-compat.ts' },
  outDir: 'lib',
  format: ['iife'],
  platform: 'browser',
  target: 'chrome92',
  dts: false,
  sourcemap: true,
  clean: false,
  minify: true,
  deps: { alwaysBundle: ['core-js'], onlyBundle: ['core-js'] },
  // Prototype polyfills must retain strict `this` semantics after CJS bundling.
  outputOptions: { banner: '"use strict";', entryFileNames: 'mobile-compat.js' },
} satisfies UserConfig

export default defineConfig([{
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  dts: true,
  sourcemap: true,
  clean: true,
  deps: {
    neverBundle: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-host-webserver',
      'web-push',
      'zod',
    ],
  },
}, {
  entry: ['src/cli.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  dts: false,
  sourcemap: true,
  clean: false,
  outputOptions: { entryFileNames: 'cli.js' },
}, {
  // Standalone worker runtime for opt-in worker
  // execution of local extension hosts. Self-contained (schemastery bundled)
  // because it must start from the installed artifact with no node_modules
  // resolution of its own.
  entry: ['src/extension-worker-runtime.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: { alwaysBundle: ['@deepseek-ai/schemastery'] },
  outputOptions: { entryFileNames: 'extension-worker-runtime.mjs' },
}, {
  // The question-fixes component. It is its own package so its bundle row can
  // name it, which is what gives it a separate entry in the dsh-mobile card's
  // Components list and its own Running toggle.
  entry: { index: 'packages/question-fixes/src/index.ts' },
  outDir: 'packages/question-fixes/lib',
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  dts: false,
  sourcemap: true,
  clean: true,
  outputOptions: { entryFileNames: 'index.mjs' },
}, {
  entry: { client: 'packages/question-fixes/src/client.ts' },
  outDir: 'packages/question-fixes/lib',
  format: ['cjs'],
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: { neverBundle: ['react'] },
  outputOptions: {
    entryFileNames: 'client.js',
    // The loader id is the package name: that is what binds this file to the row.
    banner: 'window.__ModuleLoader__.load({ id: "dsh-mobile-question-fixes", factory: (require) => {',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
}, {
  entry: { client: 'src/client.ts' },
  outDir: 'lib',
  format: ['cjs'],
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  // react stays external as the loader-provided React; the primitives module is the
  // DSH web shell's seeded public Switch provider, required lazily at push-category
  // render time and resolved by the module-loader factory require, never bundled.
  deps: { neverBundle: ['react', '@deepseek-ai/dsh-client-ui-primitives'], alwaysBundle: [/^@noble\/hashes(?:\/|$)/u] },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "dsh-mobile", factory: (require) => {',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
}, {
  entry: { 'mobile-layout': 'src/mobile-layout.ts' },
  outDir: 'lib',
  format: ['cjs'],
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: { neverBundle: ['react'] },
  outputOptions: {
    entryFileNames: 'mobile-layout.js',
    banner: 'window.__ModuleLoader__.load({ id: "@deepseek-ai/dsh-client-ui-layout", factory: (require) => {',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
}, {
  entry: { 'mobile-graph-follower': 'packages/mobile-graph-follower/src/client.ts' },
  outDir: 'lib',
  format: ['cjs'],
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  minify: true,
  deps: {
    // The DSH page supplies the gateway client and `zod` through its module loader;
    // the stock client row takes both the same way, so bundling a second copy only adds weight.
    neverBundle: ['@deepseek-ai/dsh-api-gateway/client', 'zod'],
    alwaysBundle: [/^@deepseek-ai\/dsh-(?:client-hmr|typert-protocol|brand|error)(?:\/|$)/u],
  },
  outputOptions: {
    entryFileNames: 'mobile-graph-follower.js',
    banner: 'window.__ModuleLoader__.load({ id: "@deepseek-ai/dsh-client-hmr", factory: (require) => {',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
}, mobileCompatibilityBuild])
