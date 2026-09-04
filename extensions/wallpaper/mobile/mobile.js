window.dshMobile?.define?.({
  apiVersion: 1,
  id: 'wallpaper',
  activate(api) {
    const STORAGE_KEY = 'dsh-mobile.wallpaper.v1'
    const builtinUrl = api.host.assetUrl('wallpaper-builtin.png')

    const readChoice = () => {
      try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
        if (saved !== null && typeof saved === 'object' && (saved.type === 'builtin' || saved.type === 'custom' || saved.type === 'none')) {
          return saved
        }
      } catch { /* fall through to default */ }
      return { type: 'builtin' }
    }
    const writeChoice = (choice) => {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(choice)) } catch { /* private browsing: session-only */ }
    }
    const resolveUrl = (choice) => {
      if (choice.type === 'builtin') return builtinUrl
      if (choice.type === 'custom' && typeof choice.url === 'string' && choice.url !== '') return choice.url
      return ''
    }
    const applyBackground = () => {
      const url = resolveUrl(readChoice())
      const shell = document.querySelector('.dshm-shell')
      const target = shell ?? document.body
      if (url === '') {
        target.style.removeProperty('background-image')
        return
      }
      target.style.setProperty('background-image', `url("${url}")`, 'important')
      target.style.setProperty('background-size', 'cover', 'important')
      target.style.setProperty('background-position', 'center', 'important')
      target.style.setProperty('background-repeat', 'no-repeat', 'important')
      target.style.setProperty('background-attachment', 'fixed', 'important')
    }

    const root = document.createElement('div')
    root.className = 'wallpaper-page'
    const title = document.createElement('h2')
    title.textContent = '壁纸'
    const hint = document.createElement('p')
    hint.textContent = '选择手机端背景，立即生效并记住选择。'
    root.append(title, hint)

    const grid = document.createElement('div')
    grid.className = 'wallpaper-grid'
    const refresh = () => {
      const current = readChoice()
      grid.replaceChildren()
      const options = [
        { type: 'builtin', label: '内置壁纸', preview: builtinUrl },
        ...(current.type === 'custom' ? [{ type: 'custom', label: '自定义', preview: current.url }] : []),
      ]
      for (const option of options) {
        const card = document.createElement('button')
        card.type = 'button'
        card.className = 'wallpaper-card' + (current.type === option.type ? ' is-active' : '')
        const thumb = document.createElement('span')
        thumb.className = 'wallpaper-thumb'
        thumb.style.setProperty('background-image', `url("${option.preview}")`)
        const label = document.createElement('span')
        label.textContent = option.label + (current.type === option.type ? ' ✓' : '')
        card.append(thumb, label)
        card.addEventListener('click', () => {
          writeChoice(option.type === 'custom' ? { type: 'custom', url: current.url } : { type: option.type })
          applyBackground()
          refresh()
        })
        grid.append(card)
      }
      const none = document.createElement('button')
      none.type = 'button'
      none.className = 'wallpaper-card' + (current.type === 'none' ? ' is-active' : '')
      const noneLabel = document.createElement('span')
      noneLabel.textContent = '恢复默认' + (current.type === 'none' ? ' ✓' : '')
      none.append(noneLabel)
      none.addEventListener('click', () => {
        writeChoice({ type: 'none' })
        applyBackground()
        refresh()
      })
      grid.append(none)
    }

    const form = document.createElement('div')
    form.className = 'wallpaper-form'
    const input = document.createElement('input')
    input.type = 'url'
    input.placeholder = '粘贴图片地址，以 https:// 开头'
    input.autocomplete = 'off'
    input.spellcheck = false
    const apply = document.createElement('button')
    apply.type = 'button'
    apply.textContent = '使用这张'
    apply.addEventListener('click', () => {
      const url = input.value.trim()
      if (!/^https:\/\//u.test(url)) {
        input.focus()
        return
      }
      writeChoice({ type: 'custom', url })
      applyBackground()
      refresh()
    })
    form.append(input, apply)
    root.append(grid, form)
    refresh()
    applyBackground()

    const disposeSurface = api.ui.registerSurface({
      id: 'wallpaper-page',
      placement: 'page',
      label: '壁纸',
      mount(container) {
        container.replaceChildren(root)
        return () => root.remove()
      },
    })
    return () => {
      disposeSurface()
      root.remove()
    }
  },
})
