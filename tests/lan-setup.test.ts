import { X509Certificate } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  discardFirewallScratch,
  powerShellFailureDetail,
  prepareManagedLanSetup,
  windowsFirewallSetupScript,
} from '../src/lan-setup.js'
import { parseManagedSetup } from '../src/managed-setup.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('managed LAN setup', () => {
  it('updates an existing firewall rule without deleting it first and verifies the resulting scope', () => {
    const script = windowsFirewallSetupScript(3443)
    expect(script).not.toContain('Remove-NetFirewallRule')
    expect(script).toContain("$rules = @(Get-NetFirewallRule -DisplayName 'DSH Mobile HTTPS'")
    expect(script).toContain('$rule | Set-NetFirewallRule -Enabled True -Direction Inbound -Action Allow -Profile Any')
    expect(script).toContain("$rule | Get-NetFirewallPortFilter | Set-NetFirewallPortFilter -Protocol TCP -LocalPort 3443")
    expect(script).toContain("$rule | Get-NetFirewallPortFilter | Set-NetFirewallPortFilter -Protocol UDP -LocalPort 3443")
    expect(script).toContain("Get-NetFirewallRule -DisplayName 'DSH Mobile HTTPS' -ErrorAction Stop | Where-Object { $_.Enabled -eq 'True'")
    expect(script).not.toContain("Get-NetFirewallRule -DisplayName 'DSH Mobile HTTPS' -Enabled True")
    expect(script).toContain('$matchingAddress.Count -eq 0')
    expect(() => windowsFirewallSetupScript(443)).toThrow(/Windows firewall port/)
  })

  it('creates private TLS material and an enabled restart state after explicit confirmation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-lan-setup-'))
    directories.push(directory)
    const setupFile = join(directory, 'setup.json')
    const controlFile = join(directory, 'control.json')
    const result = await prepareManagedLanSetup({
      setupFile,
      controlFile,
      network: { name: 'Wi-Fi', address: '192.168.50.8', cidr: '192.168.50.0/24' },
      listenPort: 3443,
      dshPort: 43120,
      configureFirewall: false,
    })

    expect(result.origin).toBe('https://192.168.50.8:3443')
    expect(parseManagedSetup(JSON.parse(await readFile(setupFile, 'utf8')))).toMatchObject({
      version: 2,
      networkInterface: 'Wi-Fi',
      listenPort: 3443,
      upstreamOrigin: 'http://127.0.0.1:43120',
    })
    expect(JSON.parse(await readFile(controlFile, 'utf8'))).toEqual({ version: 1, enabled: true })
    const ca = new X509Certificate(await readFile(result.setup.tls.caCertFile, 'utf8'))
    const server = new X509Certificate(await readFile(result.setup.tls.certFile, 'utf8'))
    expect(ca.ca).toBe(true)
    expect(server.ca).toBe(false)
    expect(server.verify(ca.publicKey)).toBe(true)
    expect(await readFile(result.androidCertificate)).toEqual(ca.raw)
    if (process.platform !== 'win32') {
      for (const file of [...Object.values(result.setup.tls).filter(value => value !== 'managed'), result.androidCertificate, setupFile, controlFile]) {
        expect((await stat(file)).mode & 0o777).toBe(0o600)
      }
    }
  })

  it('rejects relative state paths and invalid listener ports before writing setup', async () => {
    await expect(prepareManagedLanSetup({
      setupFile: 'setup.json',
      controlFile: 'control.json',
      network: { name: 'Wi-Fi', address: '192.168.50.8', cidr: '192.168.50.0/24' },
      listenPort: 443,
      dshPort: 3080,
      configureFirewall: false,
    })).rejects.toThrow(/paths must be absolute/)

    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-lan-setup-invalid-'))
    directories.push(directory)
    await expect(prepareManagedLanSetup({
      setupFile: join(directory, 'setup.json'),
      controlFile: join(directory, 'control.json'),
      network: { name: 'Wi-Fi', address: '192.168.50.8', cidr: '192.168.50.0/24' },
      listenPort: 443,
      dshPort: 3080,
      configureFirewall: false,
    })).rejects.toThrow(/listenPort must be from 1024 through 65535/)
  })

  it('carries the launcher exit code and stderr without leaking the elevated command line', () => {
    const encoded = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODk='
    const failure = Object.assign(new Error('Command failed'), {
      code: 1,
      stderr: String.raw`Start-Process : This command cannot be run because the user canceled the operation.
At line:1 char:1
+ $process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -EncodedCommand ${encoded}
+ CategoryInfo : InvalidOperation: (:) [Start-Process], InvalidOperationException
+ FullyQualifiedErrorId : StartProcessFailed
C:\Users\alice\AppData\Local\Temp\dsh-mobile-firewall-abc123\error.log`,
    })

    const detail = powerShellFailureDetail(failure)
    expect(detail.startsWith(' (1): ')).toBe(true)
    // The operator needs the cause line; the invocation and scratch path are noise.
    expect(detail).toContain('canceled the operation')
    expect(detail).toContain('EncodedCommand <redacted>')
    expect(detail).not.toContain(encoded)
    expect(detail).not.toContain('C:\\Users')
    expect(detail).not.toContain('AppData')
  })

  it('prefers the elevated error log over the launcher text and bounds the detail', () => {
    const failure = Object.assign(new Error('Command failed'), { code: 9009, stderr: 'launcher text' })
    const innerLog = `${"DSH Mobile firewall rule 'DSH Mobile HTTPS' is not active with the expected scope ".repeat(20)}`

    const detail = powerShellFailureDetail(failure, innerLog)
    expect(detail.startsWith(' (9009): ')).toBe(true)
    expect(detail).toContain('is not active with the expected scope')
    expect(detail).not.toContain('launcher text')
    expect(detail.length).toBeLessThanOrEqual(512 + ' (9009): '.length)
  })

  it('reports a primitive failure without inventing a code', () => {
    expect(powerShellFailureDetail('nope')).toBe('unknown failure')
    expect(powerShellFailureDetail(new Error('plain'))).toBe('')
  })

  it('does not let scratch cleanup replace the run outcome', async () => {
    const warn = vi.fn()
    await expect(discardFirewallScratch('C:\\temp\\dsh-mobile-firewall-x', {
      remove: async () => { throw Object.assign(new Error('busy'), { code: 'EPERM' }) },
      warn,
    })).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith('EPERM')
  })

  it('removes the scratch directory quietly when cleanup succeeds', async () => {
    const remove = vi.fn(async () => undefined)
    const warn = vi.fn()
    await discardFirewallScratch('C:\\temp\\dsh-mobile-firewall-y', { remove, warn })
    expect(remove).toHaveBeenCalledWith('C:\\temp\\dsh-mobile-firewall-y')
    expect(warn).not.toHaveBeenCalled()
  })

  it('keeps a throwing warning sink from restoring the masking failure', async () => {
    await expect(discardFirewallScratch('C:\\temp\\dsh-mobile-firewall-z', {
      remove: async () => { throw Object.assign(new Error('locked'), { code: 'EBUSY' }) },
      warn: () => { throw new Error('observer failed') },
    })).resolves.toBeUndefined()
  })
})
