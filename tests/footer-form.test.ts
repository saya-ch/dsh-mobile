import { describe, expect, it } from 'vitest'
import {
  FOOTER_COUNT_LIMIT,
  FOOTER_ICON_WIDTH,
  FOOTER_MAX_LABEL_BOX,
  FOOTER_ROW_GAP,
  FOOTER_ROW_PADDING,
  footerFormFor,
  footerRequiredWidth,
  measureFooterSeat,
  occupiesFooterSeat,
  resolveFooterForm,
  type FooterSeatView,
} from '../src/footer-form.js'

interface FakeStyle {
  display: string
  flexDirection: string
  flexWrap: string
  position: string
}

class FakeNode {
  parentElement: FakeNode | null = null
  children: FakeNode[] = []
  clientWidth = 0
  width = 36
  height = 36

  constructor(readonly style: FakeStyle = { display: 'block', flexDirection: 'row', flexWrap: 'nowrap', position: 'static' }) {}

  append(child: FakeNode): FakeNode {
    child.parentElement = this
    this.children.push(child)
    return child
  }

  contains(target: unknown): boolean {
    return target === this || this.children.some(child => child.contains(target))
  }

  getBoundingClientRect(): { width: number; height: number } {
    return { width: this.width, height: this.height }
  }
}

const view: FooterSeatView = { getComputedStyle: element => (element as unknown as FakeNode).style }

function row(overrides: Partial<FakeStyle> = {}, clientWidth = 320): FakeNode {
  const node = new FakeNode({ display: 'flex', flexDirection: 'row', flexWrap: 'nowrap', position: 'static', ...overrides })
  node.clientWidth = clientWidth
  return node
}

function button(): FakeNode {
  return new FakeNode({ display: 'flex', flexDirection: 'row', flexWrap: 'nowrap', position: 'static' })
}

/** Host shape: flex row -> display:contents slot outlet -> our button. */
function hostRow(peers: FakeNode[], options: { contents?: boolean; wrapper?: number; row?: FakeNode } = {}) {
  const container = options.row ?? row()
  const seat = (node: FakeNode) => {
    if (options.contents === false) {
      container.append(node)
      return node
    }
    const outlet = new FakeNode({ display: 'contents', flexDirection: 'row', flexWrap: 'nowrap', position: 'static' })
    outlet.append(node)
    container.append(outlet)
    return outlet
  }
  const ours = button()
  let outermost: FakeNode = ours
  for (let index = 0; index < (options.wrapper ?? 0); index += 1) {
    const wrapper = new FakeNode()
    wrapper.append(outermost)
    outermost = wrapper
  }
  seat(outermost)
  for (const peer of peers) seat(peer)
  return { container, anchor: ours, ours }
}

describe('footer capacity contract', () => {
  it('keeps the shared geometry constants in one place', () => {
    expect(FOOTER_ICON_WIDTH).toBe(36)
    expect(FOOTER_MAX_LABEL_BOX).toBe(112)
    expect(FOOTER_COUNT_LIMIT).toBe(2)
    expect(FOOTER_ROW_GAP).toBe(4)
    expect(FOOTER_ROW_PADDING).toBe(16)
  })

  it('derives the required row width from the occupant count', () => {
    expect(footerRequiredWidth(0)).toBe(0)
    expect(footerRequiredWidth(1)).toBe(128)
    expect(footerRequiredWidth(2)).toBe(244)
    expect(footerRequiredWidth(3)).toBe(360)
  })

  it('is all-or-nothing across the row', () => {
    expect(resolveFooterForm(1, 128)).toBe('label')
    expect(resolveFooterForm(1, 127)).toBe('icon')
    expect(resolveFooterForm(2, 244)).toBe('label')
    expect(resolveFooterForm(2, 243)).toBe('icon')
    // Three occupants never keep a label, however wide the row is.
    expect(resolveFooterForm(3, 4000)).toBe('icon')
    // An unmeasured row falls back to the compact target, not to overflow.
    expect(resolveFooterForm(2, Number.NaN)).toBe('icon')
    // No row at all (a host that renders one occupant inline) keeps the label.
    expect(resolveFooterForm(0, Number.NaN)).toBe('label')
  })

  it('counts only seats that occupy lane space', () => {
    expect(occupiesFooterSeat({ position: 'static', width: 36, height: 36 })).toBe(true)
    expect(occupiesFooterSeat({ position: 'fixed', width: 36, height: 36 })).toBe(false)
    expect(occupiesFooterSeat({ position: 'absolute', width: 36, height: 36 })).toBe(false)
    expect(occupiesFooterSeat({ position: 'static', width: 0, height: 36 })).toBe(false)
    expect(occupiesFooterSeat(null)).toBe(false)
  })
})

describe('measureFooterSeat', () => {
  it('climbs out of the display:contents slot outlet to the real row', () => {
    const { container, anchor } = hostRow([])
    const facts = measureFooterSeat(anchor as unknown as Element, view)
    expect(facts.row).toBe(container as unknown as Element)
    expect(facts.lane).toBe(true)
    expect(facts.wrapped).toBe(false)
    expect(facts.count).toBe(1)
    expect(facts.rowWidth).toBe(320)
  })

  it('climbs past plain single-child wrappers', () => {
    const { container, anchor } = hostRow([], { wrapper: 2 })
    expect(measureFooterSeat(anchor as unknown as Element, view).row).toBe(container as unknown as Element)
  })

  it('counts peer occupants through nested display:contents outlets', () => {
    const first = new FakeNode()
    const second = new FakeNode()
    const { container, anchor } = hostRow([])
    const outlet = new FakeNode({ display: 'contents', flexDirection: 'row', flexWrap: 'nowrap', position: 'static' })
    outlet.append(first)
    outlet.append(second)
    container.append(outlet)
    const facts = measureFooterSeat(anchor as unknown as Element, view)
    expect(facts.count).toBe(3)
    expect(resolveFooterForm(facts.count, facts.rowWidth)).toBe('icon')
  })

  it('ignores overlays and zero-sized entries', () => {
    const overlay = new FakeNode({ display: 'block', flexDirection: 'row', flexWrap: 'nowrap', position: 'fixed' })
    const collapsed = new FakeNode({ display: 'block', flexDirection: 'row', flexWrap: 'nowrap', position: 'static' })
    collapsed.width = 0
    collapsed.height = 0
    const { container, anchor } = hostRow([overlay, collapsed])
    const facts = measureFooterSeat(anchor as unknown as Element, view)
    expect(facts.count).toBe(1)
    expect(facts.row).toBe(container as unknown as Element)
  })

  it('reports the container shape instead of a capacity for a vertical or wrapping row', () => {
    const vertical = hostRow([], { row: row({ flexDirection: 'column' }) })
    const verticalFacts = measureFooterSeat(vertical.anchor as unknown as Element, view)
    expect(verticalFacts.lane).toBe(false)
    expect(footerFormFor(verticalFacts, true)).toBe('label')

    const wrapping = hostRow([], { row: row({ flexWrap: 'wrap' }) })
    const wrappingFacts = measureFooterSeat(wrapping.anchor as unknown as Element, view)
    expect(wrappingFacts.wrapped).toBe(true)
    expect(footerFormFor(wrappingFacts, true)).toBe('label')
  })

  it('returns no facts when there is no measurable row', () => {
    const orphan = button()
    expect(measureFooterSeat(orphan as unknown as Element, view)).toMatchObject({ row: null, count: 0 })
    expect(measureFooterSeat(null, view)).toMatchObject({ row: null, count: 0 })
    expect(measureFooterSeat(orphan as unknown as Element, undefined)).toMatchObject({ row: null, count: 0 })
    // A non-flex ancestor with siblings is not a footer row.
    const outside = hostRow([], { contents: false })
    outside.container.style.display = 'block'
    outside.container.append(new FakeNode())
    expect(measureFooterSeat(outside.anchor as unknown as Element, view).row).toBeNull()
  })
})

describe('footerFormFor', () => {
  it('always uses the icon target in the collapsed rail', () => {
    const { container, anchor } = hostRow([])
    const facts = measureFooterSeat(anchor as unknown as Element, view)
    expect(footerFormFor(facts, false)).toBe('icon')
    expect(facts.row).toBe(container as unknown as Element)
  })

  it('keeps the label form when the host row is unknown', () => {
    expect(footerFormFor({ row: null, lane: false, wrapped: false, count: 0, rowWidth: Number.NaN }, true)).toBe('label')
  })

  it('decides from count and width only, never from a peer form', () => {
    const lonely = hostRow([], { row: row({}, 128) })
    expect(footerFormFor(measureFooterSeat(lonely.anchor as unknown as Element, view), true)).toBe('label')

    const shared = hostRow([new FakeNode()], { row: row({}, 200) })
    expect(footerFormFor(measureFooterSeat(shared.anchor as unknown as Element, view), true)).toBe('icon')

    const roomy = hostRow([new FakeNode()], { row: row({}, 244) })
    expect(footerFormFor(measureFooterSeat(roomy.anchor as unknown as Element, view), true)).toBe('label')
  })
})
