// China-direct egress: on a host whose system route is a TUN in global proxy mode, Chinese sources
// (which refuse or misbehave through a foreign exit) are dialled from a chosen local address (the
// physical NIC) so the socket bypasses the TUN. Names are resolved over DNS-over-HTTPS from the same
// local address (the system resolver would hand out fake 198.18/15 answers), every answer is checked
// with isBlockedAddress, and TLS keeps the original host name for SNI and certificate validation.
// MAFI_CN_DIRECT_LOCAL_ADDRESS: an explicit IPv4 overrides; "auto" (the default when unset) picks the
// physical NIC's IPv4 at runtime (pickLocalAddress) so DHCP changes don't break it; "off" disables.
import net from "node:net";
import os from "node:os";
import { Agent, request, type Dispatcher } from "undici";
import { isBlockedAddress } from "./url.ts";

const CN_DIRECT_SUFFIXES = ["nmpa.gov.cn", "pbc.gov.cn", "stats.gov.cn", "csrc.gov.cn", "safe.gov.cn", "shfe.com.cn", "smpaa.cn", "nhsa.gov.cn", "stcn.com", "cnpharm.com"];

/** *.cn and the listed Chinese source domains (with their subdomains). */
export function isCnDirectHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (net.isIP(h) !== 0) return false;
  return h.endsWith(".cn") || CN_DIRECT_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`));
}

type Iface = { address: string; family: string | number; internal: boolean };

const VIRTUAL_IFACE = /flclash|meta|tun|wintun|tap|vethernet|vmware|virtualbox|vbox|loopback|docker|wsl|hyper-v|tailscale|zerotier|bluetooth|蓝牙|npcap|utun|bridge|br-|veth/i;
const WIFI_IFACE = /wlan|wi-?fi|wireless|无线|^wl/i;
const ETHERNET_IFACE = /ethernet|以太网|^eth|^en/i;

function usableIpv4(a: Iface): boolean {
  if (a.internal || (a.family !== "IPv4" && a.family !== 4) || net.isIP(a.address) !== 4) return false;
  const [x, y] = a.address.split(".").map(Number) as [number, number];
  if (x === 127 || x === 0 || (x === 169 && y === 254) || (x === 198 && (y === 18 || y === 19))) return false;
  return true;
}

/** The physical NIC's IPv4: Wi-Fi first, then Ethernet, then any other non-virtual adapter; null if none. */
export function pickLocalAddress(ifaces: NodeJS.Dict<Iface[]> = os.networkInterfaces()): { name: string; address: string } | null {
  const candidates: Array<{ name: string; address: string; rank: number }> = [];
  for (const [name, list] of Object.entries(ifaces)) {
    if (!list || VIRTUAL_IFACE.test(name)) continue;
    const rank = WIFI_IFACE.test(name) ? 0 : ETHERNET_IFACE.test(name) ? 1 : 2;
    for (const a of list) if (usableIpv4(a)) candidates.push({ name, address: a.address, rank });
  }
  candidates.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  return candidates[0] ? { name: candidates[0].name, address: candidates[0].address } : null;
}

/** Connect errors that mean the bound local address is stale (DHCP change, adapter down). */
export function isStaleLocalAddressError(err: unknown): boolean {
  for (let e = err as { code?: string; cause?: unknown } | undefined, i = 0; e && i < 5; e = e.cause as typeof e, i++) {
    if (e.code && ["EADDRNOTAVAIL", "ENETUNREACH", "EHOSTUNREACH", "EINVAL", "ENETDOWN"].includes(e.code)) return true;
  }
  return false;
}

type DohAnswer = { type: number; data: string; TTL?: number };

/** A records from a DoH JSON answer; refuses the whole answer if any address is private or fake-IP. */
export function publicAddressesFrom(answer: DohAnswer[] | undefined, host: string): { addresses: string[]; ttl: number } {
  const records = (answer ?? []).filter((a) => a.type === 1 && net.isIP(a.data) === 4);
  const addresses = records.map((r) => r.data);
  if (!addresses.length) throw new Error(`No address for ${host}`);
  if (addresses.some(isBlockedAddress)) throw new Error(`Blocked private address for ${host}`);
  return { addresses, ttl: Math.max(0, Math.min(300, ...records.map((r) => r.TTL || 0))) };
}

export function createCnDirect(localAddress: string, dohUrl: string, outbound: object, factory?: (origin: string | URL, options: object) => Dispatcher) {
  const dohAgent = new Agent({ ...outbound, localAddress, maxResponseSize: 64 * 1024 });
  const cache = new Map<string, { addresses: string[]; until: number }>();
  const pending = new Map<string, Promise<string[]>>();
  const resolve = (host: string): Promise<string[]> => {
    const key = host.toLowerCase();
    const hit = cache.get(key);
    if (hit && hit.until > Date.now()) return Promise.resolve(hit.addresses);
    let work = pending.get(key);
    if (!work) {
      work = (async () => {
        const url = new URL(dohUrl);
        url.searchParams.set("name", key);
        url.searchParams.set("type", "A");
        const res = await request(url, { dispatcher: dohAgent, signal: AbortSignal.timeout(5_000), headers: { accept: "application/dns-json" } });
        if (res.statusCode !== 200) { await res.body.dump(); throw new Error(`CN DoH upstream ${res.statusCode}`); }
        const data = await res.body.json() as { Status?: number; Answer?: DohAnswer[] };
        if (data.Status !== undefined && data.Status !== 0) throw new Error(`DNS lookup failed for ${key}`);
        const { addresses, ttl } = publicAddressesFrom(data.Answer, key);
        if (cache.size >= 256) cache.delete(cache.keys().next().value!);
        cache.set(key, { addresses, until: Date.now() + Math.max(30, ttl) * 1000 });
        return addresses;
      })().finally(() => pending.delete(key));
      pending.set(key, work);
    }
    return work;
  };
  type Cb = (err: Error | null, address: string | Array<{ address: string; family: number }>, family?: number) => void;
  const lookup = (hostname: string, options: { all?: boolean } | number, callback: Cb) => {
    const all = typeof options === "object" && options?.all;
    resolve(hostname).then(
      (list) => all ? callback(null, list.map((address) => ({ address, family: 4 }))) : callback(null, list[0]!, 4),
      (err: Error) => callback(Object.assign(err, { code: (err as { code?: string }).code ?? "EBLOCKED" }), all ? [] : "", 0),
    );
  };
  // undici takes localAddress as a client option; inside `connect` it is overridden and ignored.
  const agent = new Agent({ ...outbound, localAddress, factory: factory as never, connect: { lookup: lookup as never } });
  return { agent, resolve };
}