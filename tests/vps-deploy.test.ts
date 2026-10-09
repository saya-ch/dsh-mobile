import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildPinnedKnownHosts,
  createVpsUninstallScript,
  deployVps,
  fetchVpsHostKeys,
  fingerprintHostPublicKey,
  parseVpsDeploymentInput,
  uninstallVps,
  vpsDeploymentScriptForTesting,
  VpsSshError,
  runVpsProcess,
} from '../src/vps-deploy.js'
import { parseFrpSettings } from '../src/frp-config.js'

const sshFixture=vi.hoisted(()=>({enabled:false,calls:[] as {args:string[];pins:string}[]}))
vi.mock('node:child_process',async()=>{
  const actual=await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return {...actual,spawn(command:string,args:readonly string[]=[],options:import('node:child_process').SpawnOptions={}){
    if(sshFixture.enabled&&/^ssh(?:\.exe)?$/u.test(command)){
      const pin=args.find(arg=>arg.startsWith('-o UserKnownHostsFile='))?.slice('-o UserKnownHostsFile='.length)
      sshFixture.calls.push({args:[...args],pins:pin===undefined?'':readFileSync(pin,'utf8')})
      return actual.spawn(process.execPath,['-e','process.stdin.resume();process.stdin.on("end",()=>{process.stdout.write("DSH_MOBILE_CHECK services ok removed\\nDSH_MOBILE_UNINSTALL_OK\\n")})'],options)
    }
    return actual.spawn(command,[...args],options)
  }}
})

const settings = parseFrpSettings({
  serverAddress: 'frp.example.com',
  serverPort: 7000,
  token: '0123456789abcdef0123456789abcdef',
  publicOrigin: 'https://dsh.example.com',
})

// Deterministic stand-in host keys (51-byte ed25519-style blobs).
const keyA = Buffer.alloc(51, 7).toString('base64')
const keyB = Buffer.alloc(51, 9).toString('base64')
const fingerprintA = fingerprintHostPublicKey('ssh-ed25519', keyA)
const fingerprintB = fingerprintHostPublicKey('ssh-ed25519', keyB)
const keyscanOutput = `# frp.example.com:22 SSH-2.0-OpenSSH_9.6\nfrp.example.com ssh-ed25519 ${keyA}\nfrp.example.com ssh-ed25519 ${keyB}\n`

function sshInput(fingerprints: readonly string[] = [fingerprintA, fingerprintB]) {
  return { sshUser: 'root', sshPort: 22, hostFingerprints: [...fingerprints] }
}

const processDirectories:string[]=[]
afterEach(async()=>{sshFixture.enabled=false;sshFixture.calls.length=0;for(const directory of processDirectories.splice(0)) await rm(directory,{recursive:true,force:true})})

describe('owned VPS utility lifecycle',()=>{
  it('contains early stdin closure and waits for the owned process to close',async()=>{
    const root=await mkdtemp(join(tmpdir(),'dsh-vps-process-'));processDirectories.push(root)
    const marker=join(root,'closed')
    await expect(runVpsProcess(process.execPath,['-e',`process.stdin.destroy();setTimeout(()=>{require('node:fs').writeFileSync(${JSON.stringify(marker)},'done');process.exit(0)},50)`],'x'.repeat(8*1024*1024),5000)).rejects.toMatchObject({message:'vps_ssh_input_failed',timedOut:false})
  })
  it('keeps timeout distinct when a terminated child exits successfully',async()=>{
    const script = process.platform === 'win32' ? 'setInterval(()=>{},1000)' : 'process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},1000)'
    const result=await runVpsProcess(process.execPath,['-e',script],undefined,200).catch((error:unknown)=>error)
    expect(result).toBeInstanceOf(VpsSshError)
    expect(result).toMatchObject({message:'vps_ssh_timeout',timedOut:true})
    if(process.platform!=='win32')expect(result).toMatchObject({exitCode:0,signal:null})
  })
  it('reports unavailable utilities without leaving a pending timer',async()=>{
    const root=await mkdtemp(join(tmpdir(),'dsh-vps-missing-'));processDirectories.push(root)
    await expect(runVpsProcess(join(root,'missing-utility'),[],undefined,5000)).rejects.toMatchObject({message:'vps_ssh_unavailable',timedOut:false})
  })
})

describe('VPS deployment', () => {
  // validSshKeyPath requires a platform-absolute path; a Windows literal is
  // invalid on Linux CI, so the fixture follows the current platform.
  const keyFixture = process.platform === 'win32' ? 'C:\\keys\\dsh' : '/tmp/dsh-test-key'
  it('validates SSH input without accepting arbitrary remote arguments', () => {
    expect(parseVpsDeploymentInput({ sshUser: 'root', sshPort: 22, hostFingerprints: [fingerprintA] })).toEqual({
      sshUser: 'root', sshPort: 22, hostFingerprints: [fingerprintA],
    })
    expect(parseVpsDeploymentInput({ sshUser: 'deploy-user', sshPort: 2222, sshKeyPath: keyFixture, hostFingerprints: [fingerprintA] })).toEqual({
      sshUser: 'deploy-user', sshPort: 2222, sshKeyPath: keyFixture, hostFingerprints: [fingerprintA],
    })
    expect(() => parseVpsDeploymentInput({ sshUser: 'root;rm -rf /', sshPort: 22, hostFingerprints: [fingerprintA] })).toThrow('vps_ssh_user_invalid')
    expect(() => parseVpsDeploymentInput({ sshUser: 'root', sshPort: 22, hostFingerprints: [fingerprintA], command: 'id' })).toThrow('vps_deploy_input_invalid')
  })

  it('requires confirmed host fingerprints before any connection', () => {
    expect(() => parseVpsDeploymentInput({ sshUser: 'root', sshPort: 22 })).toThrow('vps_host_key_unconfirmed')
    expect(() => parseVpsDeploymentInput({ sshUser: 'root', sshPort: 22, hostFingerprints: [] })).toThrow('vps_host_key_unconfirmed')
    expect(() => parseVpsDeploymentInput({ sshUser: 'root', sshPort: 22, hostFingerprints: ['not-a-fingerprint'] })).toThrow('vps_host_key_unconfirmed')
    expect(() => parseVpsDeploymentInput({ sshUser: 'root', sshPort: 22, hostFingerprints: ['MD5:aa:bb:cc'] })).toThrow('vps_host_key_unconfirmed')
  })

  it('refuses non-public targets without touching the network', async () => {
    for (const serverAddress of ['127.0.0.1', '192.168.1.20', '10.0.0.8', '203.0.113.10', '192.0.2.1', '::1']) {
      const badSettings = parseFrpSettings({ ...settings, serverAddress, publicOrigin: 'https://dsh.example.com' })
      let scanned = false
      await expect(deployVps(badSettings, sshInput(), {
        runKeyscan: async () => { scanned = true; return keyscanOutput },
        runSsh: async () => ({ stdout: 'DSH_MOBILE_DEPLOYMENT_OK\n', stderr: '' }),
      })).rejects.toThrow(serverAddress.includes(':') ? 'vps_ipv6_ssh_not_supported' : 'vps_server_not_public')
      expect(scanned).toBe(false)
      await expect(fetchVpsHostKeys(serverAddress, { sshUser: 'root', sshPort: 22 }, {
        runKeyscan: async () => { scanned = true; return keyscanOutput },
      })).rejects.toThrow(serverAddress.includes(':') ? 'vps_ipv6_ssh_not_supported' : 'vps_server_not_public')
      await expect(uninstallVps(serverAddress, { serverPort: 7000 }, sshInput(), {
        runKeyscan: async () => { scanned = true; return keyscanOutput },
        runRemoteScript: async () => ({ stdout: 'DSH_MOBILE_UNINSTALL_OK\n', stderr: '' }),
      })).rejects.toThrow(serverAddress.includes(':') ? 'vps_ipv6_ssh_not_supported' : 'vps_server_not_public')
      expect(scanned).toBe(false)
    }
  })

  it('fetches host keys with OpenSSH-style fingerprints for user confirmation', async () => {
    const keys = await fetchVpsHostKeys('frp.example.com', { sshUser: 'root', sshPort: 22 }, {
      runKeyscan: async () => keyscanOutput,
    })
    expect(keys).toEqual([
      { keyType: 'ssh-ed25519', fingerprint: fingerprintA },
      { keyType: 'ssh-ed25519', fingerprint: fingerprintB },
    ])
    await expect(fetchVpsHostKeys('frp.example.com', { sshUser: 'root', sshPort: 22 }, {
      runKeyscan: async () => '# nothing here\n',
    })).rejects.toThrow('vps_host_key_unavailable')
  })

  it('fails scan errors, empty and malformed output before any authenticated operation', async () => {
    sshFixture.enabled=true
    for (const scan of [async () => {throw new Error('old keyscan')}, async () => '', async () => '# no keys\n', async () => 'malformed key', async () => 'host ssh-ed25519 bad']) {
      let connected = false
      const options = {runKeyscan: scan, runSsh: async () => {connected=true; return {stdout:'DSH_MOBILE_DEPLOYMENT_OK',stderr:''}}, runRemoteScript: async () => {connected=true;return {stdout:'DSH_MOBILE_UNINSTALL_OK',stderr:''}}}
      await expect(fetchVpsHostKeys('frp.example.com', {sshUser:'root',sshPort:22,sshKeyPath:keyFixture}, options)).rejects.toThrow(/vps_host_key_(?:unavailable|invalid)/u)
      await expect(deployVps(settings, sshInput(), options)).rejects.toThrow(/vps_host_key_(?:unavailable|invalid)/u)
      await expect(uninstallVps('frp.example.com', {serverPort:7000}, sshInput(), options)).rejects.toThrow(/vps_host_key_(?:unavailable|invalid)/u)
      expect(connected).toBe(false)
      expect(sshFixture.calls).toEqual([])
    }
  })

  it('pins the confirmed host identity in the actual SSH argv before server cleanup',async()=>{
    sshFixture.enabled=true
    const result=await uninstallVps('frp.example.com',{serverPort:7000},sshInput(),{runKeyscan:async()=>keyscanOutput})
    expect(result.removed).toBe(true)
    expect(sshFixture.calls).toHaveLength(1)
    const call=sshFixture.calls[0]!
    expect(call.args).toContain('StrictHostKeyChecking=yes')
    expect(call.args).not.toContain('StrictHostKeyChecking=no')
    expect(call.pins).toBe(buildPinnedKnownHosts('frp.example.com',22,keyscanOutput,[fingerprintA,fingerprintB]))
  })

  it('pins only fully confirmed host keys and fails closed on rotation', () => {
    const body = buildPinnedKnownHosts('frp.example.com', 22, keyscanOutput, [fingerprintA, fingerprintB])
    expect(body).toBe(`frp.example.com ssh-ed25519 ${keyA}\nfrp.example.com ssh-ed25519 ${keyB}\n`)
    expect(buildPinnedKnownHosts('frp.example.com', 2222, keyscanOutput, [fingerprintA, fingerprintB]))
      .toContain('[frp.example.com]:2222 ssh-ed25519')
    // A newly rotated key the user never confirmed aborts the deployment.
    expect(() => buildPinnedKnownHosts('frp.example.com', 22, keyscanOutput, [fingerprintA])).toThrow('vps_host_key_mismatch')
    expect(() => buildPinnedKnownHosts('frp.example.com', 22, '# nothing here\n', [fingerprintA])).toThrow('vps_host_key_unavailable')
  })

  it.runIf(process.platform !== 'win32')('generates shell scripts that pass sh syntax check', () => {
    for (const script of [
      vpsDeploymentScriptForTesting(settings),
      vpsDeploymentScriptForTesting(parseFrpSettings({ ...settings, serverAddress: '1.2.3.4', publicOrigin: 'https://1.2.3.4' })),
      createVpsUninstallScript({ serverPort: 7000 }),
      createVpsUninstallScript({ serverPort: 7000, certName: '1.2.3.4' }),
    ]) {
      const result = spawnSync('sh', ['-n'], { input: script, encoding: 'utf8', timeout: 10_000, windowsHide: true })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
    }
  })
  it('generates a restricted, pinned server installation script', () => {
    const script = vpsDeploymentScriptForTesting(settings)
    expect(script).toContain('frp_0.70.1_linux_amd64')
    expect(script).toContain('333da23d1b9009d7c01638e9ba38cf4600f7d37d393f854e96ee1396adefa9a6')
    expect(script).toContain('proxyBindAddr = "127.0.0.1"')
    expect(script).toContain('vhostHTTPPort = 7080')
    expect(script).toContain('dsh-mobile-frps.service')
    expect(script).toContain('reverse_proxy 127.0.0.1:7080')
    expect(script).toContain('chmod 0644 /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list')
    // The main Caddyfile only gains one import line; the site lives in our snippet.
    expect(script).toContain('/etc/caddy/dsh-mobile-dsh.caddy')
    expect(script).toContain('caddy_import=')
    expect(script).not.toContain('cat > /etc/caddy/Caddyfile')
    // An existing import is rebuilt into exactly one top import: snippet globals
    // (IP-mode default_sni) must precede all site blocks after inlining.
    // Removal reuses the gate grep (never sed -i) and the count is verified.
    expect(script).toContain('Caddyfile.dsh-new')
    expect(script).toContain('grep -Ev')
    // Concurrent deploys/cleanups serialize on a lock so Caddyfile surgeries never interleave.
    expect(script).toContain('flock -n 9 || fail')
    // The account is only removed when this deployment created it.
    expect(script).toContain('/etc/dsh-mobile/.owns-account')
    // The account must exist before anything references its group: a redeploy
    // after a cleanup would otherwise fail on `install -g dsh-mobile`.
    expect(script.indexOf('useradd --system')).toBeLessThan(script.indexOf('install -d -m 0750 -o root -g dsh-mobile'))
    // A redeploy must restart frps so the new token takes effect instead of
    // leaving the previous generation running with stale credentials.
    expect(script).toContain('systemctl restart dsh-mobile-frps.service')
    expect(script).not.toContain('systemctl enable --now dsh-mobile-frps.service')
  })

  it('installs a public IP certificate and automatic renewal for an IPv4 origin', () => {
    const ipSettings = parseFrpSettings({ ...settings, serverAddress: '1.2.3.4', publicOrigin: 'https://1.2.3.4' })
    const script = vpsDeploymentScriptForTesting(ipSettings)
    expect(script).toContain('--preferred-profile shortlived --ip-address 1.2.3.4')
    expect(script).toContain('certbot==5.8.0')
    expect(script).toContain('default_sni 1.2.3.4')
    expect(script).toContain('dsh-mobile-cert-renew.timer')
    expect(script).toContain('tls /var/lib/caddy/dsh-mobile-certs/fullchain.pem')
  })

  it('returns only redacted deployment checks after the remote script succeeds', async () => {
    let capturedScript = ''
    const result = await deployVps(settings, sshInput(), {
      runKeyscan: async () => keyscanOutput,
      runSsh: async (_input, host, script) => {
        expect(host).toBe('frp.example.com')
        capturedScript = script
        return {
          stdout: 'DSH_MOBILE_CHECK os ok Ubuntu\nDSH_MOBILE_CHECK frps ok started\nDSH_MOBILE_DEPLOYMENT_OK\n',
          stderr: '',
        }
      },
    })
    expect(result.deployed).toBe(true)
    expect(result.checks).toEqual([
      { id: 'os', status: 'ok', detail: 'Ubuntu' },
      { id: 'frps', status: 'ok', detail: 'started' },
    ])
    expect(capturedScript).toContain(settings.token)
  })

  it('aborts before connecting when the server presents an unconfirmed key', async () => {
    let connected = false
    await expect(deployVps(settings, sshInput([fingerprintA]), {
      runKeyscan: async () => keyscanOutput,
      runSsh: async () => {
        connected = true
        return { stdout: 'DSH_MOBILE_DEPLOYMENT_OK\n', stderr: '' }
      },
    })).rejects.toThrow('vps_host_key_mismatch')
    expect(connected).toBe(false)
  })

  it('replaces a leftover uninstall placeholder instead of refusing to deploy', () => {
    const script = vpsDeploymentScriptForTesting(settings)
    expect(script).toContain('# DSH Mobile removed its site')
    // User content around the placeholder is kept; removal is verified by count.
    expect(script).toContain('Caddyfile.dsh-new')
  })

  it('reports the failed remote check instead of raw output on transport failure', async () => {
    await expect(deployVps(settings, sshInput(), {
      runKeyscan: async () => keyscanOutput,
      runSsh: async () => {
        throw new VpsSshError(
          'vps_deploy_failed',
          'DSH_MOBILE_CHECK os ok Ubuntu\n',
          'DSH_MOBILE_CHECK remote-command error custom failure detail\n',
        )
      },
    })).rejects.toThrow('vps_deploy_failed:custom failure detail')
  })

  it('reports the last output line when the script aborts without a check line', async () => {
    await expect(deployVps(settings, sshInput(), {
      runKeyscan: async () => keyscanOutput,
      runSsh: async () => {
        throw new VpsSshError(
          'vps_deploy_failed',
          'Reading package lists...\n',
          'Some apt noise\ninstall: invalid group \'dsh-mobile\'\n',
        )
      },
    })).rejects.toThrow('vps_deploy_failed:install: invalid group')
    await expect(deployVps(settings, sshInput(), {
      runKeyscan: async () => keyscanOutput,
      runSsh: async () => {
        throw new VpsSshError('vps_ssh_timeout', '', '')
      },
    })).rejects.toThrow(/^vps_ssh_timeout$/u)
  })

  it('relabels transport failures during uninstall and prefers check detail', async () => {
    await expect(uninstallVps('frp.example.com', { serverPort: 7000 }, sshInput(), {
      runKeyscan: async () => keyscanOutput,
      runRemoteScript: async () => {
        throw new VpsSshError(
          'vps_deploy_failed',
          'DSH_MOBILE_CHECK services ok removed\n',
          'DSH_MOBILE_CHECK remote-command error custom uninstall failure\n',
        )
      },
    })).rejects.toThrow('vps_uninstall_failed:custom uninstall failure')
  })

  it('generates a reviewable uninstall script that only touches owned artifacts', () => {
    const script = createVpsUninstallScript({ serverPort: 7000 })
    for (const owned of [
      'dsh-mobile-frps.service',
      'dsh-mobile-cert-renew.timer',
      '/etc/dsh-mobile',
      '/usr/local/libexec/dsh-mobile',
      '/opt/dsh-mobile/certbot-venv',
      '/usr/local/sbin/dsh-mobile-cert-renew',
      '/var/lib/caddy/dsh-mobile-certs',
      '/etc/caddy/dsh-mobile-dsh.caddy',
      'DSH Mobile',
      'DSH_MOBILE_UNINSTALL_OK',
    ]) expect(script).toContain(owned)
    // Never touches unrelated Caddy content, other firewall rules, or other users.
    expect(script).not.toMatch(/rm -rf \/(etc|usr|var)( |$)/u)
    expect(script).toContain('Caddyfile 非 DSH Mobile 管理，保持原样')
    // The import line is removed surgically; user content around it is kept.
    expect(script).toContain('dsh-mobile-dsh\.caddy([[:space:]]|$)')
    expect(script).toContain('flock -n 9 || fail')
    // A pre-existing account is kept; only a deployment-created one is removed.
    expect(script).toContain('.owns-account')
    expect(script).toContain('非本次部署创建，已保留')
    expect(() => createVpsUninstallScript({ serverPort: 0 })).toThrow('frp_server_port_invalid')
    expect(createVpsUninstallScript({ serverPort: 7000, certName: '1.2.3.4' })).toContain('certbot delete --cert-name')
  })

  it('removes server artifacts only after re-verifying confirmed host keys', async () => {
    let executedScript = ''
    const result = await uninstallVps('frp.example.com', { serverPort: 7000 }, sshInput(), {
      runKeyscan: async () => keyscanOutput,
      runRemoteScript: async (_input, host, script) => {
        expect(host).toBe('frp.example.com')
        executedScript = script
        return {
          stdout: 'DSH_MOBILE_CHECK services ok removed\nDSH_MOBILE_UNINSTALL_OK\n',
          stderr: '',
        }
      },
    })
    expect(result.removed).toBe(true)
    expect(result.checks).toEqual([{ id: 'services', status: 'ok', detail: 'removed' }])
    expect(executedScript).toContain('dsh-mobile-frps.service')
  })

  it('refuses server cleanup when the keys rotated after confirmation', async () => {
    let executed = false
    await expect(uninstallVps('frp.example.com', { serverPort: 7000 }, sshInput([fingerprintA]), {
      runKeyscan: async () => keyscanOutput,
      runRemoteScript: async () => {
        executed = true
        return { stdout: 'DSH_MOBILE_UNINSTALL_OK\n', stderr: '' }
      },
    })).rejects.toThrow('vps_host_key_mismatch')
    expect(executed).toBe(false)
  })

  it('redacts the token when a remote check reports it', async () => {
    await expect(deployVps(settings, sshInput(), {
      runKeyscan: async () => keyscanOutput,
      runSsh: async () => ({
        stdout: `DSH_MOBILE_CHECK remote-command error ${settings.token}\n`,
        stderr: '',
      }),
    })).rejects.toThrow('<redacted>')
  })
})
