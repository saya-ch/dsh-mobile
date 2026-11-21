import { describe, expect, it, vi } from 'vitest'
import { readViewerFile, parseViewerAddress, browserHandoff } from '../src/mobile-viewer-file-share.js'
import { placeMenu, viewerMenu } from '../src/mobile-viewer-file-menu.js'

describe('viewer menu placement', () => {
  const viewport = { left: 0, top: 0, width: 360, height: 740 }
  const bar = { left: 22, bottom: 142, width: 248 }

  it('fits directly below the filename bar, not at the viewport center', () => {
    expect(placeMenu(bar, viewport, 106)).toEqual({ mode: 'dropdown', left: 22, top: 150, width: 248 })
  })

  it('pins to the safe viewport bottom when the panel will not fit below', () => {
    const safeViewport = { left: 20, top: 10, width: 320, height: 696 }
    expect(placeMenu({ ...bar, bottom: 606 }, safeViewport, 106))
      .toEqual({ mode: 'sheet', left: 20, bottom: 706, width: 320 })
  })

  it.each([320, 360])('clamps an oversized long-path bar to the %ipx viewport', width => {
    expect(placeMenu({ left: -15, bottom: 142, width: 710 }, { ...viewport, width }, 106))
      .toEqual({ mode: 'dropdown', left: 0, top: 150, width })
  })

  it('keeps a right-edge bar and its panel width within the viewport', () => {
    expect(placeMenu({ ...bar, left: 95 }, { ...viewport, width: 320 }, 106))
      .toEqual({ mode: 'dropdown', left: 72, top: 150, width: 248 })
  })

  it('clamps to the visible top when the bar scrolls above it', () => {
    expect(placeMenu({ ...bar, bottom: 34 }, { ...viewport, top: 50 }, 106))
      .toEqual({ mode: 'dropdown', left: 22, top: 50, width: 248 })
  })

  it('keeps clear of preview controls that intersect the dropdown', () => {
    const control = { left: 235, right: 271, top: 190, bottom: 230 }
    expect(placeMenu(bar, viewport, 106, [control])).toEqual({ mode: 'sheet', left: 0, bottom: 740, width: 360 })
    expect(placeMenu(bar, viewport, 106, [{ ...control, left: 271, right: 307 }]))
      .toEqual({ mode: 'dropdown', left: 22, top: 150, width: 248 })
  })
})

const stat = { bytes: 3, version: 'v2', absolutePath: '/other/報告.xlsx' }
const file = { sessionId: 'other', path: '報告.xlsx' }
function transport(meta = stat, content = new Uint8Array([0, 255, 9]), patch = {}) {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)); expect(request.payload.args).toEqual({workspaceFileScopeId:'other', path:'報告.xlsx',options:{}})
    const form = new FormData(); form.set('bytes-0', new Blob([content])); form.set('metadata', JSON.stringify({type:'server-response',rpcId:request.rpcId,attachments:[{part:'bytes-0',codec:'bytes',path:['data']}],result:{ok:true,value:{...meta, offset:0,eof:true,data:null,...patch}}})); return new Response(form)
  })
}
const signal = () => new AbortController().signal
it('decodes only the addressed session file, preserving absolute paths and escaped delimiters', () => {
  expect(parseViewerAddress('dsh-resource://file/session/B//dir/a%23%3F.xlsx?q')).toEqual({sessionId:'B',path:'/dir/a#?.xlsx'})
  for(const address of ['dsh-resource://file/absolute/foo','dsh-resource://file/session/A/','dsh-resource://file/session/A/%FF']) expect(parseViewerAddress(address)).toBeUndefined()
})
describe('bounded complete file',()=>{
  it('shares the current original XLSX bytes, never the rendered preview',async()=>{
    const f=await readViewerFile(file,signal(),async()=>stat,transport()); expect(f.name).toBe('報告.xlsx'); expect(f.type).toContain('spreadsheet'); expect([...new Uint8Array(await f.arrayBuffer())]).toEqual([0,255,9])
  })
  it('accepts a verified empty file',async()=>{const s={...stat,bytes:0}; expect((await readViewerFile(file,signal(),async()=>s,transport(s,new Uint8Array()))).size).toBe(0)})
  it.each([undefined,-1,8*1024*1024+1])('refuses size %s without a byte request',async bytes=>{const fetcher=transport(); await expect(readViewerFile(file,signal(),async()=>({...stat,bytes}),fetcher)).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled()})
  it.each([{version:'v3'},{eof:false},{bytes:4},{offset:1},{absolutePath:'/new-name'}])('rejects changed or incomplete result %j',async patch=>{await expect(readViewerFile(file,signal(),async()=>stat,transport(stat,undefined,patch))).rejects.toThrow()})
  it('cancels an oversized growing response before consuming all chunks',async()=>{const cancel=vi.fn();let n=0;const body=new ReadableStream({pull(c){if(++n>32) c.close();else c.enqueue(new Uint8Array(64*1024))},cancel}); await expect(readViewerFile(file,signal(),async()=>stat,async()=>new Response(body,{headers:{'content-type':'multipart/form-data; boundary=x'}}))).rejects.toThrow();expect(cancel).toHaveBeenCalled();expect(n).toBeLessThan(32)})
})
it('slow preparation is reused by the next gesture, and double selection launches once',async()=>{const ready=Promise.withResolvers<File>();const item=new File(['hi'],'one.txt'); const share=vi.fn(async()=>{});const read=vi.fn(()=>ready.promise);const state=vi.fn(); const hand=browserHandoff({read,current:()=>true,active:()=>false,canShare:()=>true,share,state,done:vi.fn()}); const started=hand.choose();void hand.choose();ready.resolve(item);await started;expect(state).toHaveBeenCalledWith('ready');expect(share).not.toHaveBeenCalled();const next=hand.choose();expect(share).toHaveBeenCalledWith(item);await next;expect(read).toHaveBeenCalledTimes(1);hand.dispose()})
it('refuses an expired prepared file even before a suspended timer runs',async()=>{
  vi.useFakeTimers(); try {
    const share=vi.fn(), done=vi.fn(); const hand=browserHandoff({read:async()=>new File([],'old.txt'),current:()=>true,active:()=>false,canShare:()=>true,share,state:vi.fn(),done})
    await hand.choose(); vi.setSystemTime(Date.now()+60_001); await hand.choose(); expect(share).not.toHaveBeenCalled();expect(done).toHaveBeenCalledOnce();hand.dispose()
  } finally {vi.useRealTimers()}
})
it('dismissal during a pending read never launches a sheet',async()=>{const ready=Promise.withResolvers<File>();const share=vi.fn();const hand=browserHandoff({read:()=>ready.promise,current:()=>true,active:()=>true,canShare:()=>true,share,state:vi.fn(),done:vi.fn()});const pending=hand.choose();hand.dispose();ready.resolve(new File([],'old.txt'));await pending;expect(share).not.toHaveBeenCalled()})

it('native viewerMenu returns false without throwing when sidebarRight lacks focusedTarget (keeps one-tap copy)', () => {
  vi.stubGlobal('window', { isSecureContext: true })
  vi.stubGlobal('HTMLDialogElement', Object.assign(function HTMLDialogElement() {}, { prototype: { showModal() {} } }))
  try {
    const copy = vi.fn()
    const menu = viewerMenu(
      () => ({
        sidebarRight: { isTargetCurrent: () => true, mounted: { getSnapshot: () => 's1', subscribe: () => () => {} } },
        remote: { workspaceFiles: { stat: async () => ({ ok: false }) } },
        connection: { state: { getSnapshot: () => 'connected', subscribe: () => () => {} } },
      }) as never,
      { copy: 'Copy', share: 'Share', ready: 'Ready', reading: 'Reading', sharing: 'Sharing', failed: 'Failed', size: 'Size' },
      { enabled: () => true, send: async () => 'shared' },
    )
    expect(menu.open({} as Element, copy)).toBe(false)
  } finally {
    vi.unstubAllGlobals()
  }
})

it('native viewerMenu returns false without throwing when DSH functions are present but throw', () => {
  const validOcc = {
    signal: new AbortController().signal,
    navigation: {
      getSnapshot: () => ({ address: 'dsh-resource://file/session/s1/note.md', revision: 1 }),
      subscribe: () => () => {},
    },
  }
  const validTarget = { navigationRevision: 1, occurrence: validOcc }
  const owner = { isConnected: true, getClientRects: () => [{ width: 10, height: 10 }] } as unknown as Element
  vi.stubGlobal('window', { isSecureContext: true })
  vi.stubGlobal('getComputedStyle', () => ({ visibility: 'visible' }))
  vi.stubGlobal('HTMLDialogElement', Object.assign(function HTMLDialogElement() {}, { prototype: { showModal() {} } }))
  try {
    const labels = { copy: 'Copy', share: 'Share', ready: 'Ready', reading: 'Reading', sharing: 'Sharing', failed: 'Failed', size: 'Size' }
    const native = { enabled: () => true, send: async () => 'shared' as const }

    // Case 1: isTargetCurrent throws
    const s1 = {
      sidebarRight: { focusedTarget: () => validTarget, isTargetCurrent: () => { throw new Error('boom-isTargetCurrent') }, mounted: { getSnapshot: () => 's1', subscribe: () => () => {} } },
      remote: { workspaceFiles: { stat: async () => ({ ok: false }) } },
      connection: { state: { getSnapshot: () => 'connected', subscribe: () => () => {} } },
    }
    const m1 = viewerMenu(() => s1 as never, labels, native)
    expect(m1.open(owner, vi.fn())).toBe(false)

    // Case 2: connection.state.getSnapshot throws
    const s2 = {
      sidebarRight: { focusedTarget: () => validTarget, isTargetCurrent: () => true, mounted: { getSnapshot: () => 's1', subscribe: () => () => {} } },
      remote: { workspaceFiles: { stat: async () => ({ ok: false }) } },
      connection: { state: { getSnapshot: () => { throw new Error('boom-connection') }, subscribe: () => () => {} } },
    }
    const m2 = viewerMenu(() => s2 as never, labels, native)
    expect(m2.open(owner, vi.fn())).toBe(false)

    // Case 3: focusedTarget succeeds on first call and throws when re-invoked inside current()
    let calls = 0
    const s3 = {
      sidebarRight: { focusedTarget: () => { if (++calls > 1) throw new Error('boom-focusedTarget-2'); return validTarget }, isTargetCurrent: () => true, mounted: { getSnapshot: () => 's1', subscribe: () => () => {} } },
      remote: { workspaceFiles: { stat: async () => ({ ok: false }) } },
      connection: { state: { getSnapshot: () => 'connected', subscribe: () => () => {} } },
    }
    const m3 = viewerMenu(() => s3 as never, labels, native)
    expect(m3.open(owner, vi.fn())).toBe(false)

    // Case 4: occ.navigation.getSnapshot throws
    const s4 = {
      sidebarRight: {
        focusedTarget: () => ({ navigationRevision: 1, occurrence: { signal: new AbortController().signal, navigation: { getSnapshot: () => { throw new Error('boom-nav') }, subscribe: () => () => {} } } }),
        isTargetCurrent: () => true,
        mounted: { getSnapshot: () => 's1', subscribe: () => () => {} },
      },
      remote: { workspaceFiles: { stat: async () => ({ ok: false }) } },
      connection: { state: { getSnapshot: () => 'connected', subscribe: () => () => {} } },
    }
    const m4 = viewerMenu(() => s4 as never, labels, native)
    expect(m4.open(owner, vi.fn())).toBe(false)
  } finally {
    vi.unstubAllGlobals()
  }
})

it('viewerMenu close() tears down the dialog before evaluating current()', () => {
  const order: string[] = []
  const validOcc = {
    signal: new AbortController().signal,
    navigation: { getSnapshot: () => ({ address: 'dsh-resource://file/session/s1/note.md', revision: 1 }), subscribe: () => () => {} },
  }
  const validTarget = { navigationRevision: 1, occurrence: validOcc }
  const owner = { isConnected: true, getAttribute: () => 'note.md', getClientRects: () => [{ width: 140, height: 10 }], getBoundingClientRect: () => ({ left: 10, bottom: 50, width: 140 }), focus: vi.fn() } as unknown as Element
  const fakeDialog = {
    className: '',
    style: {},
    getBoundingClientRect: () => ({ height: 110 }),
    setAttribute: vi.fn(),
    append: vi.fn(),
    showModal: vi.fn(),
    close: vi.fn(() => { order.push('dialog.close') }),
    remove: vi.fn(() => { order.push('dialog.remove') }),
    focus: vi.fn(),
  }
  vi.stubGlobal('window', {
    isSecureContext: true,
    innerWidth: 360,
    innerHeight: 740,
    fetch: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })
  vi.stubGlobal('document', {
    createElement: (tag: string) => tag === 'dialog' ? fakeDialog : { type: '', textContent: '', setAttribute: vi.fn(), append: vi.fn(), focus: vi.fn() },
    body: { append: vi.fn() },
  })
  vi.stubGlobal('getComputedStyle', () => ({ visibility: 'visible', getPropertyValue: () => '' }))
  vi.stubGlobal('MutationObserver', class { observe() {} disconnect() { order.push('observer.disconnect') } })
  vi.stubGlobal('HTMLDialogElement', Object.assign(function HTMLDialogElement() {}, { prototype: { showModal() {} } }))
  try {
    let calls = 0
    const services = {
      sidebarRight: {
        focusedTarget: () => validTarget,
        isTargetCurrent: () => {
          if (++calls === 2) { order.push('current'); throw new Error('boom-on-close') }
          return true
        },
        mounted: { getSnapshot: () => 's1', subscribe: () => () => {} },
      },
      remote: { workspaceFiles: { stat: async () => ({ ok: false }) } },
      connection: { state: { getSnapshot: () => 'connected', subscribe: () => () => {} } },
    }
    const menu = viewerMenu(
      () => services as never,
      { copy: 'Copy', share: 'Share', ready: 'Ready', reading: 'Reading', sharing: 'Sharing', failed: 'Failed', size: 'Size' },
      { enabled: () => true, send: async () => 'shared' },
    )
    expect(menu.open(owner, vi.fn())).toBe(true)
    expect(() => menu.dispose()).not.toThrow()
    expect(order).toEqual(['observer.disconnect', 'dialog.close', 'dialog.remove', 'current'])
  } finally {
    vi.unstubAllGlobals()
  }
})
