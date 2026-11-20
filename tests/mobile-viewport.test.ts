import { describe, expect, it } from 'vitest'
import { ensureMobileViewport, MOBILE_VIEWPORT_CONTENT } from '../src/mobile-viewport.js'

describe('dedicated mobile viewport contract', () => {
  it('resizes the layout viewport with the software keyboard', () => {
    expect(MOBILE_VIEWPORT_CONTENT).toContain('viewport-fit=cover')
    expect(MOBILE_VIEWPORT_CONTENT).toContain('interactive-widget=resizes-content')
  })

  it('inserts the contract into a document without a viewport meta', () => {
    const output = ensureMobileViewport('<!doctype html><html><head><title>DSH</title></head><body></body></html>')

    expect(output).toContain(`<meta name="viewport" content="${MOBILE_VIEWPORT_CONTENT}">`)
    expect(output.indexOf('name="viewport"')).toBeLessThan(output.indexOf('<title>'))
  })

  it('upgrades an existing viewport meta without adding a second one', () => {
    const output = ensureMobileViewport('<head><meta name="viewport" content="width=device-width, initial-scale=1"></head>')

    expect(output.match(/name="viewport"/gu)).toHaveLength(1)
    expect(output).toContain(`content="${MOBILE_VIEWPORT_CONTENT}"`)
  })

  it('adds the keyboard key to a viewport that already has viewport-fit=cover', () => {
    const output = ensureMobileViewport('<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">')

    expect(output).toContain('interactive-widget=resizes-content')
    expect(output.match(/viewport-fit=cover/gu)).toHaveLength(1)
  })

  it('replaces a conflicting interactive-widget value and keeps unrelated tokens', () => {
    const output = ensureMobileViewport('<meta content="width=device-width, initial-scale=1, user-scalable=no, interactive-widget=resizes-visual" name="viewport">')

    expect(output).toContain('user-scalable=no')
    expect(output).toContain('interactive-widget=resizes-content')
    expect(output).not.toContain('resizes-visual')
    expect(output.match(/viewport-fit=cover/gu)).toHaveLength(1)
  })

  it('enforces a single value for each Mobile option and preserves other options', () => {
    const html = '<meta name="viewport" content="width=device-width, interactive-widget=resizes-visual, initial-scale=1, viewport-fit=contain, INTERACTIVE-WIDGET = overlays-content, viewport-fit=cover">'
    const output = ensureMobileViewport(html)

    expect(output).toBe(`<meta name="viewport" content="${MOBILE_VIEWPORT_CONTENT}">`)
    expect(ensureMobileViewport(output)).toBe(output)
  })

  it('ignores data-name and data-content attributes when locating the viewport', () => {
    const unrelated = '<meta data-name="viewport" content="unchanged">'
    const output = ensureMobileViewport(`<head>${unrelated}<meta name="viewport" data-content="keep" content="width=device-width,initial-scale=1"></head>`)

    expect(output).toBe(`<head>${unrelated}<meta name="viewport" data-content="keep" content="${MOBILE_VIEWPORT_CONTENT}"></head>`)
  })

  it('adds the content attribute to a viewport meta that lacks one', () => {
    const output = ensureMobileViewport('<meta name="viewport"><meta name="theme-color" content="#000">')

    expect(output).toContain(`<meta name="viewport" content="${MOBILE_VIEWPORT_CONTENT}">`)
    expect(output).toContain('theme-color')
  })

  it('leaves a document without a head or viewport meta unchanged', () => {
    const html = '<!doctype html><body><p>Desktop-only document</p></body>'

    expect(ensureMobileViewport(html)).toBe(html)
  })

  it('leaves another meta element untouched when inserting the contract', () => {
    const html = '<head><meta name="theme-color" content="black"></head>'
    const output = ensureMobileViewport(html)

    expect(output).toContain('<meta name="theme-color" content="black">')
    expect(output).toContain(`<meta name="viewport" content="${MOBILE_VIEWPORT_CONTENT}">`)
  })
})
