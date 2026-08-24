import * as os from "node:os";
import QRCode from "qrcode";
import type { LensConfig } from "../types.js";

export interface LanAddress {
  ip: string;
  iface: string;
}

/** Enumerate LAN IPv4 candidates: private ranges first, virtual/tethering included. */
export function lanAddresses(): LanAddress[] {
  const out: LanAddress[] = [];
  for (const [iface, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      out.push({ ip: addr.address, iface });
    }
  }
  const rank = (ip: string): number => {
    if (ip.startsWith("192.168.")) return 0; // typical Wi-Fi + Android USB tethering
    if (ip.startsWith("172.")) return 1; // container/iPhone-USB ranges
    if (ip.startsWith("10.")) return 2;
    return 3;
  };
  return out.sort((a, b) => rank(a.ip) - rank(b.ip) || a.ip.localeCompare(b.ip));
}

export interface PairingQr {
  code: string;
  expiresAt: number;
  payload: string;
  urls: string[];
  pngDataUrl: string;
  ascii: string;
}

/** Build the full pairing payload + rendered QR (data URL for browsers, ASCII for terminals). */
export async function buildPairingQr(code: string, expiresAt: number, config: LensConfig, originOverride?: string): Promise<PairingQr> {
  const addrs = lanAddresses();
  const host = originOverride ?? addrs[0]?.ip ?? "127.0.0.1";
  const port = config.server.port;
  const payload = `lensmate://pair?v=1&host=${encodeURIComponent(host)}&port=${port}&code=${code}`;
  const urls = (addrs.length > 0 ? addrs : [{ ip: "127.0.0.1", iface: "loopback" }]).map((a) => `http://${a.ip}:${port}`);
  const [pngDataUrl, ascii] = await Promise.all([
    QRCode.toDataURL(payload, { errorCorrectionLevel: "M", margin: 2, width: 320 }),
    QRCode.toString(payload, { type: "terminal", small: true }),
  ]);
  return { code, expiresAt, payload, urls, pngDataUrl, ascii };
}
