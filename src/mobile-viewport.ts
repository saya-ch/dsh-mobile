/**
 * The viewport contract shared by the dedicated Mobile page and the plugin's
 * own browser documents.
 *
 * `viewport-fit=cover` lets the shell own the display cutout and system-bar
 * edges. `interactive-widget=resizes-content` lets supporting browsers shrink
 * the layout viewport and the shell's `100dvh` height when the keyboard opens.
 */
const MOBILE_VIEWPORT_OPTIONS = ['viewport-fit=cover', 'interactive-widget=resizes-content']

export const MOBILE_VIEWPORT_CONTENT =
  ['width=device-width', 'initial-scale=1', ...MOBILE_VIEWPORT_OPTIONS].join(',')

const VIEWPORT_META = /<meta\b(?=[^>]*\sname\s*=\s*(["'])viewport\1)[^>]*>/iu
const CONTENT_ATTRIBUTE = /(\s+content\s*=\s*)(["'])(.*?)\2/isu
const MOBILE_OWNED_OPTION = /^(?:viewport-fit|interactive-widget)(?:\s*=|$)/iu

/**
 * Ensure the dedicated Mobile document declares the viewport contract.
 *
 * The upstream DSH document may already carry a viewport meta without these
 * keys, so the helper rewrites that tag instead of inserting a second one.
 * Both keys are enforced: the dedicated layout is a full-height shell whose
 * composer depends on the layout viewport shrinking with the keyboard, and a
 * later `resizes-visual` value would silently undo that contract.
 *
 * @param html - The upstream document, before the Mobile gateway serves it.
 * @returns The document with the contract applied, or the input unchanged when
 * it has neither a viewport meta nor a head element to insert one into.
 */
export function ensureMobileViewport(html: string): string {
  const match = VIEWPORT_META.exec(html)
  if (match === null) {
    const head = /<head\b[^>]*>/iu.exec(html)
    if (head?.index === undefined) return html
    const position = head.index + head[0].length
    return `${html.slice(0, position)}<meta name="viewport" content="${MOBILE_VIEWPORT_CONTENT}">${html.slice(position)}`
  }
  const content = CONTENT_ATTRIBUTE.exec(match[0])
  let tag: string
  if (content === null) {
    tag = match[0].replace(/\s*\/?>$/u, ` content="${MOBILE_VIEWPORT_CONTENT}">`)
  } else {
    const tokens = (content[3] ?? '').split(',').map(token => token.trim())
      .filter(token => token.length > 0 && !MOBILE_OWNED_OPTION.test(token))
    const nextContent = [...tokens, ...MOBILE_VIEWPORT_OPTIONS].join(',')
    const quote = content[2] ?? '"'
    tag = `${match[0].slice(0, content.index)}${content[1]}${quote}${nextContent}${quote}${match[0].slice(content.index + content[0].length)}`
  }
  return `${html.slice(0, match.index)}${tag}${html.slice(match.index + match[0].length)}`
}
