// Guard the root cause of "the button label renders dark": an implicit TextBlock style that
// sets Foreground outranks inheritance, so every control template that colours its own label
// loses. Asserting Button.Foreground does not catch it — that property was correct all along.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const app = readFileSync(
  fileURLToPath(new URL('../apps/windows/DshMobile.Win/App.xaml', import.meta.url)),
  'utf8',
)
const mainWindow = readFileSync(
  fileURLToPath(new URL('../apps/windows/DshMobile.Win/MainWindow.xaml', import.meta.url)),
  'utf8',
)
const renameDialog = readFileSync(
  fileURLToPath(new URL('../apps/windows/DshMobile.Win/RenameDialog.xaml', import.meta.url)),
  'utf8',
)

/** The body of an implicit (keyless) style for the given target type. */
function implicitStyle(source: string, targetType: string): string | null {
  const match = new RegExp(
    `<Style TargetType="${targetType}">([\\s\\S]*?)</Style>`,
    'u',
  ).exec(source)
  return match?.[1] ?? null
}

describe('Windows text colour inheritance', () => {
  it('does not force a colour from the implicit TextBlock style', () => {
    const body = implicitStyle(app, 'TextBlock')
    expect(body).not.toBeNull()
    // A Foreground setter here silently wins over every template's own label colour.
    expect(body).not.toMatch(/Property="Foreground"/u)
  })

  it('gives each window root the default text colour instead', () => {
    // Both windows carry TextElement.Foreground so ordinary text still looks like before.
    for (const [name, source] of [['MainWindow', mainWindow], ['RenameDialog', renameDialog]]) {
      expect(source, `${name} must set TextElement.Foreground on its root`).toMatch(
        /TextElement\.Foreground="\{DynamicResource PrimaryTextBrush\}"/u,
      )
    }
  })

  it('keeps the font in the implicit style', () => {
    // Removing the colour setter must not have taken the font with it.
    const body = implicitStyle(app, 'TextBlock')
    expect(body).toMatch(/Property="FontFamily"/u)
  })
})
