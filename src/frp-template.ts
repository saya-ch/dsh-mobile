/** Loopback-only HTTP vhost port used between Caddy and frps. */
export const FRP_VHOST_HTTP_PORT = 7080

/** Caddy snippet owned entirely by DSH Mobile; the main Caddyfile only imports it. */
export const FRP_CADDY_SNIPPET_PATH = '/etc/caddy/dsh-mobile-dsh.caddy'

/** First line of the owned snippet; also the legacy whole-file marker. */
export const FRP_CADDY_SNIPPET_MARKER = '# Managed by DSH Mobile - snippet, safe to delete'

/** Exact line the main Caddyfile must contain (uncommented) for the site to load. */
export const FRP_CADDY_IMPORT_LINE = `import ${FRP_CADDY_SNIPPET_PATH}`

/** Directory holding the public-IPv4 certificates installed by certbot. */
export const FRP_CADDY_IP_CERT_DIR = '/var/lib/caddy/dsh-mobile-certs'

function publicIpv4Address(value: string): boolean {
  const parts = value.split('.')
  return parts.length === 4 && parts.every(part => /^(?:0|[1-9][0-9]{0,2})$/u.test(part)
    && Number(part) <= 255)
}

function publicDnsHostname(value: string): boolean {
  return value.length <= 253 && value.includes('.') && !/^[0-9.]+$/u.test(value)
    && !value.includes(':') && value.split('.').every(label => label.length >= 1 && label.length <= 63
      && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label))
}

function parsePublicOrigin(publicOrigin: string): string {
  let url: URL
  try { url = new URL(publicOrigin) } catch { throw new Error('frp_template_input_invalid') }
  if (url.protocol !== 'https:' || url.port !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== ''
    || url.username !== '' || url.password !== '' || (!publicIpv4Address(url.hostname) && !publicDnsHostname(url.hostname))) {
    throw new Error('frp_template_input_invalid')
  }
  return url.hostname
}

/** Build the Caddy site for one public host (without markers or import wiring). */
export function createCaddySite(publicHost: string, certDir: string = FRP_CADDY_IP_CERT_DIR): string {
  if (publicIpv4Address(publicHost)) {
    return [
      '{',
      `  default_sni ${publicHost}`,
      '}',
      '',
      `http://${publicHost} {`,
      `  redir https://${publicHost}{uri} permanent`,
      '}',
      '',
      `https://${publicHost} {`,
      `  tls ${certDir}/fullchain.pem ${certDir}/privkey.pem`,
      `  reverse_proxy 127.0.0.1:${String(FRP_VHOST_HTTP_PORT)}`,
      '}',
      '',
    ].join('\n')
  }
  if (!publicDnsHostname(publicHost)) throw new Error('frp_template_input_invalid')
  return [
    `${publicHost} {`,
    `  reverse_proxy 127.0.0.1:${String(FRP_VHOST_HTTP_PORT)}`,
    '}',
    '',
  ].join('\n')
}

/** Manual certbot steps for a public-IPv4 origin (Caddy cannot issue IP certificates itself). */
function manualIpCertificateGuide(publicHost: string): string {
  return [
    '# Public-IPv4 manual HTTPS: Caddy cannot issue IP certificates by itself.',
    '# On the VPS (Ubuntu/Debian, port 80 reachable from the internet), run once as root:',
    '#   apt-get install -y python3-venv',
    '#   python3 -m venv /opt/dsh-mobile/certbot-venv',
    "#   /opt/dsh-mobile/certbot-venv/bin/pip install 'certbot==5.8.0'",
    '#   systemctl stop caddy || true',
    `#   /opt/dsh-mobile/certbot-venv/bin/certbot certonly --standalone --preferred-profile shortlived --ip-address ${publicHost} --agree-tos --register-unsafely-without-email --non-interactive --keep-until-expiring`,
    '#   install -d -m 0750 -o caddy -g caddy /var/lib/caddy/dsh-mobile-certs',
    `#   install -m 0640 -o caddy -g caddy /etc/letsencrypt/live/${publicHost}/fullchain.pem /var/lib/caddy/dsh-mobile-certs/fullchain.pem`,
    `#   install -m 0640 -o caddy -g caddy /etc/letsencrypt/live/${publicHost}/privkey.pem /var/lib/caddy/dsh-mobile-certs/privkey.pem`,
    '#   systemctl start caddy',
    '# The site below already references those paths. Certificates last about 6 days: re-run certonly before expiry.',
    '#',
  ].join('\n')
}

/** Build the only supported frps config and Caddy snippet from validated user inputs. */
export function createRestrictedFrpServerTemplate(serverPort: number, token: string, publicOrigin: string): string {
  if (!Number.isSafeInteger(serverPort) || serverPort < 1 || serverPort > 65_535
    || token.length < 16 || token.length > 512 || /[\s\u0000-\u001f\u007f]/u.test(token)) {
    throw new Error('frp_template_input_invalid')
  }
  const publicHost = parsePublicOrigin(publicOrigin)
  const lines = [
    '# frps.toml — save as /etc/dsh-mobile/frps.toml, then start the frps service.',
    `bindPort = ${String(serverPort)}`,
    'proxyBindAddr = "127.0.0.1"',
    `vhostHTTPPort = ${String(FRP_VHOST_HTTP_PORT)}`,
    'auth.method = "token"',
    `auth.token = ${JSON.stringify(token)}`,
    '',
    `# Caddy — save the site below as ${FRP_CADDY_SNIPPET_PATH},`,
    '# then make sure your Caddyfile contains exactly this line at the TOP of the file',
    '# (create the file with just this line if needed; globals must precede sites):',
    `#   ${FRP_CADDY_IMPORT_LINE}`,
    '# finally run: caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy',
    '# Uninstall later removes only this snippet file and the import line; your own Caddy content is kept.',
    `${FRP_CADDY_SNIPPET_MARKER}`,
    createCaddySite(publicHost).trimEnd(),
    '',
  ]
  if (publicIpv4Address(publicHost)) lines.push(manualIpCertificateGuide(publicHost), '')
  return lines.join('\n')
}
