import net from 'node:net';

/**
 * IP-и воқеии мизоҷ дар паси Render (32, 39). Render ба X-Forwarded-For танҳо илова мекунад
 * (сарлавҳаи мизоҷро пок намекунад) ва трафик метавонад аз Cloudflare гузарад — шумораи hop-ҳо
 * кафолат дода нашудааст. Бинобар ин аз рост ба чап меравем: ба проксии бевоситаи сокет,
 * шабакаҳои дохилӣ ва IP-ҳои Cloudflare бовар мекунем; аввалин IP-и дигар — мизоҷ.
 * Қисми қалбакие, ки мизоҷ худаш дар чап менависад, ҳеҷ гоҳ ба ин нуқта намерасад.
 */
const PRIVATE_V4 = [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['127.0.0.0', 8],
  ['100.64.0.0', 10],
  ['169.254.0.0', 16],
];
const PRIVATE_V6 = [
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
];
// https://www.cloudflare.com/ips/
const CLOUDFLARE_V4 = [
  ['173.245.48.0', 20],
  ['103.21.244.0', 22],
  ['103.22.200.0', 22],
  ['103.31.4.0', 22],
  ['141.101.64.0', 18],
  ['108.162.192.0', 18],
  ['190.93.240.0', 20],
  ['188.114.96.0', 20],
  ['197.234.240.0', 22],
  ['198.41.128.0', 17],
  ['162.158.0.0', 15],
  ['104.16.0.0', 13],
  ['104.24.0.0', 14],
  ['172.64.0.0', 13],
  ['131.0.72.0', 22],
];
const CLOUDFLARE_V6 = [
  ['2400:cb00::', 32],
  ['2606:4700::', 32],
  ['2803:f800::', 32],
  ['2405:b500::', 32],
  ['2405:8100::', 32],
  ['2a06:98c0::', 29],
  ['2c0f:f248::', 32],
];

const trusted = new net.BlockList();
for (const [address, prefix] of [...PRIVATE_V4, ...CLOUDFLARE_V4]) trusted.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [...PRIVATE_V6, ...CLOUDFLARE_V6]) trusted.addSubnet(address, prefix, 'ipv6');

export function isTrustedProxyAddress(raw) {
  const address = String(raw ?? '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
  const family = net.isIP(address);
  if (family === 0) return false;
  return trusted.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * Қимати trustProxy барои Fastify: "render" (пешфарз) — проксии бевосита + дохилӣ + Cloudflare;
 * "true" — ба ҳама (хатарнок); "false" — ба ҳеҷ кас (сервер бе прокси); рақам — N hop.
 */
export function trustProxyOption(mode) {
  if (mode === false) return false;
  if (mode === true) return true;
  if (typeof mode === 'number') return (address, hop) => hop < mode;
  if (mode === 'render' || mode === undefined || mode === null || mode === '') {
    return (address, hop) => hop === 0 || isTrustedProxyAddress(address);
  }
  return mode; // рӯйхати IP/CIDR барои proxy-addr
}
