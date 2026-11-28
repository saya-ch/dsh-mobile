// The update-failure message and the data-location footer both told the user something untrue.
//
// The failure template is "检查失败：{0}。可以稍后重试，或手动打开 {1} 查看。", and two of the values
// substituted into it ended their own sentence and repeated the advice, producing
//
//   检查失败：GitHub 限制了更新检查的频率（未登录时每小时 60 次）。请稍后重试。。可以稍后重试，…
//
// The footer promised the data folder was beside the executable even when AppDataPaths had to
// fall back to the user profile.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const LOCALES = ['', '.en', '.ja', '.ko', '.es', '.fr', '.de', '.it']

function resx(suffix: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../apps/windows/DshMobile.Win/Resources/Strings${suffix}.resx`, import.meta.url)),
    'utf8',
  )
}

function value(text: string, key: string): string | null {
  const match = new RegExp(`<data name="${key}"[^>]*>\\s*<value>(.*?)</value>`, 'su').exec(text)
  return match?.[1] ?? null
}

/** Text substituted into Update_CheckFailed, which supplies the full stop itself. */
const SUBSTITUTED = ['Update_RateLimited', 'Update_ReleasesMissing', 'Update_TimeoutCheck', 'Update_CannotReachGitHub']

describe('Windows update failure copy', () => {
  it('does not repeat the advice or the punctuation inside the substituted value', () => {
    for (const locale of LOCALES) {
      const text = resx(locale)
      for (const key of SUBSTITUTED) {
        const reason = value(text, key)
        expect(reason, `${locale || 'zh'}:${key} missing`).not.toBeNull()
        if (reason === null) continue
        // The template appends "。" so the value must not carry one.
        expect(reason.trimEnd(), `${locale || 'zh'}:${key} ends with a full stop`)
          .not.toMatch(/[.。]$/u)
        // The template already says "retry later" and "open the release page".
        if (key === 'Update_RateLimited') {
          expect(reason, `${locale || 'zh'}:${key} repeats the retry advice`)
            .not.toMatch(/重试|Try again|再試行|다시 시도|vuelve a intentarlo|réessayer|erneut/iu)
        }
      }
    }
  })

  it('strips a trailing full stop from an exception message before substituting it', () => {
    // The catch-all branch passes error.Message through, and a message may end in a period.
    const source = readFileSync(
      fileURLToPath(new URL('../apps/windows/DshMobile.Win/UpdateInstaller.cs', import.meta.url)),
      'utf8',
    )
    expect(source).toContain('WithoutTerminalStop(')
    expect(source).toMatch(/\u3002/u)
  })

  it('describes where the data actually is instead of promising the program folder', () => {
    const client = readFileSync(
      fileURLToPath(new URL('../apps/windows/DshMobile.Win/MainWindow.xaml.cs', import.meta.url)),
      'utf8',
    )
    expect(client).toContain('DataLocationHint.Text = AppDataPaths.IsPortable')
    expect(client).toContain('Strings.Settings_InstalledHint')
    expect(client).toContain('PortableBadge.Visibility = AppDataPaths.IsPortable')

    // The XAML must not hardcode the promise any more; the element carries no static text.
    const xaml = readFileSync(
      fileURLToPath(new URL('../apps/windows/DshMobile.Win/MainWindow.xaml', import.meta.url)),
      'utf8',
    )
    expect(xaml).not.toContain('Text="{x:Static res:Strings.Settings_PortableHint}"')

    for (const locale of LOCALES) {
      expect(value(resx(locale), 'Settings_InstalledHint'), `${locale || 'zh'} missing`)
        .toContain('{0}')
    }
  })
})