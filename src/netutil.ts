/** Picks the Wi-Fi (or other LAN) IPv4 from `ip -4 -o addr` output; skips loopback and mobile data. */
export function pickLanIp(out: string): string | undefined {
    const rows: { iface: string; ip: string }[] = [];
    for (const line of out.split("\n")) {
        const m = /^\d+:\s+(\S+?)(?:@\S+)?\s+inet\s+(\d+\.\d+\.\d+\.\d+)/.exec(line.trim());
        if (m) rows.push({ iface: m[1], ip: m[2] });
    }
    const usable = rows.filter((r) => !/^(lo|rmnet|ccmni|dummy|tun|v4-rmnet|clat|p2p)/.test(r.iface) && !r.ip.startsWith("127.") && !r.ip.startsWith("169.254."));
    return (usable.find((r) => r.iface.startsWith("wlan")) ?? usable.find((r) => /^(eth|ap|swlan|softap)/.test(r.iface)) ?? usable[0])?.ip;
}
