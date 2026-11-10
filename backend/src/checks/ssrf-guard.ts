/**
 * SSRF guard: stop Sentinel from visiting "inside" addresses.
 *
 * Sentinel visits any URL a user gives it. Without this guard, someone could
 * register http://localhost:5432 or http://169.254.169.254 and make Sentinel
 * poke at our own machine or private network on their behalf.
 */
import dns from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";

// Address ranges that are "inside" (private, this machine, or special-purpose).
const blocked = new BlockList();
blocked.addSubnet("0.0.0.0", 8); // "this network"
blocked.addSubnet("10.0.0.0", 8); // private network
blocked.addSubnet("100.64.0.0", 10); // shared ISP network
blocked.addSubnet("127.0.0.0", 8); // this machine (localhost)
blocked.addSubnet("169.254.0.0", 16); // link-local, includes cloud metadata 169.254.169.254
blocked.addSubnet("172.16.0.0", 12); // private network
blocked.addSubnet("192.168.0.0", 16); // private network (home Wi-Fi)
blocked.addSubnet("224.0.0.0", 4); // multicast
blocked.addSubnet("240.0.0.0", 4); // reserved + broadcast
blocked.addAddress("::", "ipv6"); // IPv6 "no address"
blocked.addAddress("::1", "ipv6"); // IPv6 localhost
// Note: no rule for "::ffff:..." (IPv4 written as IPv6, e.g. ::ffff:127.0.0.1).
// BlockList already checks those against the IPv4 rules above, and a ::ffff rule
// would wrongly match EVERY IPv4 address.
blocked.addSubnet("fc00::", 7, "ipv6"); // IPv6 private network
blocked.addSubnet("fe80::", 10, "ipv6"); // IPv6 link-local
blocked.addSubnet("ff00::", 8, "ipv6"); // IPv6 multicast

/** true if `ip` is an inside address we must not visit (or is not an IP at all). */
export function isBlockedAddress(ip: string): boolean {
  const version = isIP(ip); // 4, 6, or 0 if not an IP
  if (version === 0) return true;
  return blocked.check(ip, version === 4 ? "ipv4" : "ipv6");
}

/**
 * A replacement for Node's normal DNS lookup (name → IP address).
 * It does the normal lookup, then refuses if the answer is an inside address.
 * We plug it into the HTTP client, so the check happens at the exact moment
 * of connecting. A trick DNS server can't give one answer when we check and
 * a different one when we connect.
 */
export const safeLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return callback(err, address, family);
    // Depending on options, Node asks for one address or a list of them.
    const ips = Array.isArray(address) ? address.map((a) => a.address) : [address];
    const bad = ips.find(isBlockedAddress);
    if (bad) {
      const error: NodeJS.ErrnoException = new Error(
        `${hostname} points to a private/internal address (${bad})`,
      );
      error.code = "SSRF_BLOCKED";
      return callback(error, address, family);
    }
    callback(null, address, family);
  });
};
