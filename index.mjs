/**
 * Package entry used by plugin loaders before the compiled implementation is built.
 * The implementation lives in ./lib/index.mjs; this file only re-exports it.
 */
export * from './lib/index.mjs'
export { apply, inject, name, originGatewayConfig } from './lib/index.mjs'
