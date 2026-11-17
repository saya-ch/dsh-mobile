import { readFile } from 'node:fs/promises'
import {
  parseManagedSetup, readManagedCa, refreshManagedServerCertificate, resolveSavedLanNetwork, saveManagedSetup,
  type LanNetwork, type ManagedSetup,
} from './managed-setup.js'
import type { MobileAccessGatewayController } from './control.js'

/** An unreadable setup is rejected before stopping the listener or replacing any file. */
export class ManagedLanConfigurationError extends Error {
  constructor(cause: unknown) {
    super('managed LAN configuration is unreadable', { cause })
    this.name = 'ManagedLanConfigurationError'
  }
}

/** Rebind an existing listener; callers serialize this call with all other setup-file writes. */
export async function rebindManagedLan(options: {
  readonly setupFile: string
  readonly controller: MobileAccessGatewayController
  readonly network: LanNetwork
  readonly publish: (setup: ManagedSetup) => void
  readonly selectPrevious?: (setup: ManagedSetup) => LanNetwork
}): Promise<{ readonly setup: ManagedSetup; readonly running: boolean }> {
  let previous: ManagedSetup
  try {
    previous = parseManagedSetup(JSON.parse(await readFile(options.setupFile, 'utf8')))
    await readManagedCa(previous.tls)
  }
  catch (error) { throw new ManagedLanConfigurationError(error) }
  const result = await options.controller.reconfigure(async () => {
    const next = Object.freeze({
      ...previous,
      networkInterface: options.network.name,
      networkAddress: options.network.address,
    })
    await refreshManagedServerCertificate(next, options.network.address)
    await saveManagedSetup(options.setupFile, next)
    options.publish(next)
    return next
  }, async () => {
    // Restore the saved selection even when the old interface is no longer reachable.
    await saveManagedSetup(options.setupFile, previous)
    options.publish(previous)
    const network = options.selectPrevious?.(previous) ?? resolveSavedLanNetwork(previous)
    await refreshManagedServerCertificate(previous, network.address)
  })
  return { setup: result.value, running: result.running }
}
