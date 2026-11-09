import { describe, expect, it } from 'vitest'
import { windowsFirewallProbeScript } from '../src/diagnostics.js'

describe('diagnostics firewall probe script', () => {
  it('judges the same scope the managed LAN setup enforces', () => {
    const script = windowsFirewallProbeScript(3443)
    // A Domain/Private-only rule is inactive on a Public network; reporting it
    // ready would hide the rule that actually needs fixing.
    expect(script).toContain("$_.Profile -eq 'Any'")
    expect(script).toContain("$_.Enabled -eq 'True'")
    expect(script).toContain("$_.Direction -eq 'Inbound'")
    expect(script).toContain("$_.Action -eq 'Allow'")
    expect(script).toContain("LocalPort -eq '3443'")
    expect(script).toContain("'DSH Mobile HTTPS'")
    expect(script).toContain("'DSH Mobile Discovery'")
  })

  it('stays a read-only probe with no rule mutation', () => {
    const script = windowsFirewallProbeScript(3443)
    expect(script).not.toMatch(/(?:New|Set|Remove|Enable|Disable|Rename|Copy)-NetFirewall/u)
    expect(script).not.toContain('Remove-NetFirewallRule')
  })
})
