// The install mode decides whether the client can save anything at all.
//
// It keeps pairings, settings and a log in <install>\data and runs unelevated. A per-machine
// install puts that folder under %ProgramFiles%, which the account running the client cannot
// write, so every launch would report that the program folder is not writable and nothing the
// user configured would survive. These assertions pin the mode the layout depends on.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const installer = readFileSync(
  fileURLToPath(new URL('../apps/windows/installer/DshMobile.Win.iss', import.meta.url)),
  'utf8',
)
const readme = readFileSync(
  fileURLToPath(new URL('../apps/windows/installer/README.md', import.meta.url)),
  'utf8',
)

describe('Windows installer install mode', () => {
  it('installs per-user, so the client owns the folder it writes data into', () => {
    expect(installer).toMatch(/^PrivilegesRequired=lowest$/mu)
    expect(installer).not.toMatch(/^PrivilegesRequired=admin$/mu)
  })

  it('keeps the data inside the install folder when that folder is writable', () => {
    // The portable layout is the preference: an upgrade or a move takes the pairings along.
    // When the folder refuses writes, AppDataPaths falls back to %LOCALAPPDATA%, which is why
    // the install folder has to be writable for the primary arrangement to hold.
    const client = readFileSync(
      fileURLToPath(new URL('../apps/windows/DshMobile.Win/MainWindow.xaml.cs', import.meta.url)),
      'utf8',
    )
    expect(client).toContain('private static readonly string DataRoot = AppDataPaths.DataRoot')

    const paths = readFileSync(
      fileURLToPath(new URL('../apps/windows/DshMobile.Win/AppDataPaths.cs', import.meta.url)),
      'utf8',
    )
    // Portable first, then the user's own folder, and existing data is carried across.
    expect(paths).toContain('Path.Combine(AppContext.BaseDirectory, "data")')
    expect(paths).toContain('SpecialFolder.LocalApplicationData')
    expect(paths).toContain('MigratePortableData')
  })

  it('relaunches the client after a silent update', () => {
    // Without this the in-app updater closes the window and nothing brings it back.
    expect(installer).toMatch(/^\[Run\]$/mu)
    expect(installer).toMatch(/Filename: "\{app\}\\DshMobile\.Win\.exe".*nowait postinstall/mu)
    expect(installer).not.toContain('skipifsilent')
  })

  it('does not claim an elevation prompt it will not show', () => {
    // The comments described a per-machine install for a while after the mode changed, which
    // is exactly how a maintainer ends up reverting the fix.
    expect(installer).not.toMatch(/raises the UAC prompt/iu)
    expect(installer).not.toMatch(/no administrator rights and no UAC prompt/iu)
    expect(readme).toContain('PrivilegesRequired=lowest')
    expect(readme).not.toContain('%ProgramFiles%\\DshMobile` with')
  })
})