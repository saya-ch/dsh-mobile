import { describe, expect, it } from 'vitest'
import { isGloballyRoutableIpv4 } from '../src/network.js'

describe('globally routable IPv4', () => {
  it.each([
    '1.2.3.4',
    '8.8.8.8',
    '47.242.55.71',
    '100.63.255.255',
    '100.128.0.1',
    '172.15.255.255',
    '172.32.0.1',
    '192.167.255.255',
    '192.169.0.1',
    '198.17.255.255',
    '198.20.0.1',
  ])('accepts globally routable %s', address => {
    expect(isGloballyRoutableIpv4(address)).toBe(true)
  })

  it.each([
    // Private, shared, loopback, link-local, "this network".
    '10.0.0.8',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.20',
    '100.64.0.8',
    '100.127.255.255',
    '127.0.0.1',
    '169.254.10.20',
    '0.0.0.0',
    // Documentation TEST-NET-1/2/3 must never become a VPS endpoint.
    '192.0.2.1',
    '198.51.100.7',
    '203.0.113.10',
    // Other IETF special-purpose and benchmark ranges.
    '192.0.0.1',
    '192.31.196.1',
    '192.52.193.1',
    '192.88.99.1',
    '192.175.48.1',
    '198.18.0.1',
    '198.19.255.255',
    // Multicast, reserved, broadcast.
    '224.0.0.1',
    '233.252.0.1',
    '240.0.0.1',
    '255.255.255.255',
    // Malformed input.
    '',
    'not-an-ip',
    '1.2.3',
    '1.2.3.4.5',
    '256.1.1.1',
    '01.2.3.4',
    '1.02.3.4',
    '::1',
  ])('rejects %s', address => {
    expect(isGloballyRoutableIpv4(address)).toBe(false)
  })
})
