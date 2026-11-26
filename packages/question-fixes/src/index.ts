/**
 * Question-card fixes, node half.
 *
 * A pure UI plugin: this empty apply exists so the plugin appears in the Loader
 * and gets its own component row with its own toggle. The browser half ships as
 * `exports["./client"]`, discovered through the `dsh.client` declaration in this
 * package's manifest. All behaviour lives in `src/client.ts`.
 *
 * `name` is exported deliberately. The component is inserted by file path rather than as
 * an installed package, so the loader has no manifest to read a name from and falls back
 * to the resolved URL — which the plugin manager then shows as a `file:///…` path. An
 * exported name gives the row a readable identity; the patch's `id` is only the row key.
 */
export const name = 'dsh-ui-fixes'

export function apply(): void {}
