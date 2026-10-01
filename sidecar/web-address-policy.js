/**
 * Public-destination address policy shared by the isolated web helper and the browser.
 *
 * Imports nothing (not even Node builtins) so the composer's URL-chip admission and the
 * helper's network boundary apply the identical rules. The helper remains the enforcing
 * boundary: it re-checks every DNS answer and redirect; the browser only uses this to avoid
 * offering a Fetch that the helper would always refuse.
 */

const IPV4_PATTERN = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function ipv4Number(address) {
  if (!IPV4_PATTERN.test(address)) return null;
  const parts = address.split('.').map(Number);
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

function inV4Range(address, base, prefix) {
  const value = ipv4Number(address);
  const baseValue = ipv4Number(base);
  if (value === null || baseValue === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (baseValue & mask);
}

function ipv6Number(address) {
  const withoutZone = address.split('%', 1)[0].toLowerCase();
  let value = withoutZone;
  const ipv4Tail = value.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4Tail) {
    const ipv4 = ipv4Number(ipv4Tail[1]);
    if (ipv4 === null) return null;
    value = `${value.slice(0, -ipv4Tail[1].length)}${(ipv4 >>> 16).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.reduce((total, group) => (total << 16n) | BigInt(`0x${group}`), 0n);
}

function inV6Range(address, base, prefix) {
  const value = ipv6Number(address);
  const baseValue = ipv6Number(base);
  if (value === null || baseValue === null) return false;
  const shift = BigInt(128 - prefix);
  return (value >> shift) === (baseValue >> shift);
}

function embeddedIpv4(address) {
  const ipv4 = Number(ipv6Number(address) & 0xffffffffn);
  return [(ipv4 >>> 24) & 0xff, (ipv4 >>> 16) & 0xff, (ipv4 >>> 8) & 0xff, ipv4 & 0xff].join('.');
}

/** 4 or 6 for a canonical IP literal (no brackets), otherwise 0. */
export function ipLiteralFamily(address) {
  if (typeof address !== 'string' || !address) return 0;
  if (ipv4Number(address) !== null) return 4;
  if (address.includes(':') && ipv6Number(address) !== null) return 6;
  return 0;
}

/** True unless `address` is an IP that can be a public destination. Non-IP input is denied. */
export function isDeniedAddress(address) {
  const family = ipLiteralFamily(address);
  if (family === 4) {
    return [
      ['0.0.0.0', 8],
      ['10.0.0.0', 8],
      ['100.64.0.0', 10],
      ['127.0.0.0', 8],
      ['169.254.0.0', 16],
      ['172.16.0.0', 12],
      ['192.0.0.0', 24],
      ['192.0.2.0', 24],
      ['192.168.0.0', 16],
      ['192.88.99.0', 24],
      ['198.18.0.0', 15],
      ['198.51.100.0', 24],
      ['203.0.113.0', 24],
      ['224.0.0.0', 4],
      ['240.0.0.0', 4],
    ].some(([base, prefix]) => inV4Range(address, base, prefix));
  }
  if (family === 6) {
    // IPv4-compatible (::/96) and IPv4-mapped (::ffff:0:0/96) addresses reach the embedded
    // IPv4 destination, so they inherit its verdict.
    if (inV6Range(address, '::', 96) || inV6Range(address, '::ffff:0:0', 96)) {
      return isDeniedAddress(embeddedIpv4(address));
    }
    // Only global unicast (2000::/3) can be a public destination; everything else
    // (reserved ::/8 and 100::/8 blocks, ULA, link-local, multicast) is refused outright.
    if (!inV6Range(address, '2000::', 3)) return true;
    return [
      ['2001::', 23],
      ['2001:db8::', 32],
      ['2002::', 16],
      ['3fff::', 20],
    ].some(([base, prefix]) => inV6Range(address, base, prefix));
  }
  return true;
}

/** Lowercase a URL hostname and drop trailing root dots ("localhost." is localhost). */
export function canonicalHostname(hostname) {
  return String(hostname ?? '').toLowerCase().replace(/\.+$/, '');
}

/** RFC 6761 reserves every *.localhost name for loopback; .local is multicast DNS. */
export function isLocalHostname(hostname) {
  const host = canonicalHostname(hostname);
  return !host
    || host === 'localhost'
    || host.endsWith('.localhost')
    || host === 'local'
    || host.endsWith('.local');
}

/**
 * Whether a parsed URL hostname could pass the helper's destination policy without DNS:
 * not a local name, and, when it is an IP literal, a public address.
 */
export function isPotentiallyPublicHostname(hostname) {
  if (isLocalHostname(hostname)) return false;
  const host = canonicalHostname(hostname);
  if (host.startsWith('[') || host.endsWith(']')) {
    const inner = host.slice(1, -1);
    return host.startsWith('[') && host.endsWith(']')
      && ipLiteralFamily(inner) === 6 && !isDeniedAddress(inner);
  }
  if (ipLiteralFamily(host)) return !isDeniedAddress(host);
  return true;
}
