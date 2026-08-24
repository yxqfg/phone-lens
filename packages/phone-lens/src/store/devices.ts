import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeviceRecord } from "../types.js";
import { tokenHashMatches } from "./pairing.js";

/**
 * Paired-device registry, persisted as JSON under the plugin data dir.
 * Records carry token HASHES only; the raw token exists solely in the
 * pairing response and the phone's secure storage.
 */
export class DeviceStore {
  private devices = new Map<string, DeviceRecord>();
  private readonly file: string;
  private dirty = false;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, "devices.json");
    this.load();
  }

  private load() {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as { devices?: DeviceRecord[] };
      for (const d of raw.devices ?? []) {
        if (typeof d?.deviceId === "string" && typeof d?.tokenHash === "string") {
          this.devices.set(d.deviceId, { ...d, name: d.name ?? "unknown", model: d.model ?? "", firstPairedAt: d.firstPairedAt ?? Date.now(), lastSeenAt: d.lastSeenAt ?? 0 });
        }
      }
    } catch {
      // Corrupt registry: start empty rather than refuse to boot.
    }
  }

  private persist() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, devices: [...this.devices.values()] }, null, 2), "utf8");
    renameSync(tmp, this.file);
  }

  /** Register/re-register a device, uniquifying the name against others. */
  upsert(record: Omit<DeviceRecord, "firstPairedAt" | "lastSeenAt">): DeviceRecord {
    const prior = this.devices.get(record.deviceId);
    const full: DeviceRecord = {
      ...record,
      name: this.uniquifyName(record.deviceId, record.name),
      firstPairedAt: prior?.firstPairedAt ?? Date.now(),
      lastSeenAt: Date.now(),
    };
    this.devices.set(record.deviceId, full);
    this.dirty = true;
    this.persist();
    return full;
  }

  /** Make a display name unique among other devices (x, x (2), x (3), …). */
  private uniquifyName(deviceId: string, name: string): string {
    const others = [...this.devices.values()].map((d) => d.name).filter((n, i, arr) => arr.indexOf(n) === i);
    const base = name.trim() || "Android 设备";
    if (!others.includes(base)) return base;
    for (let n = 2; ; n++) {
      const candidate = `${base} (${n})`;
      if (!others.includes(candidate)) return candidate;
    }
  }

  /** Rename a device (user-editable in the web UI); returns the updated record. */
  rename(deviceId: string, name: string): DeviceRecord | null {
    const record = this.devices.get(deviceId);
    if (!record) return null;
    record.name = name.trim() || record.name;
    this.dirty = true;
    this.persist();
    return record;
  }

  /** Authenticate deviceId + token; refreshes lastSeenAt on success. */
  authenticate(deviceId: string, token: string): DeviceRecord | null {
    const record = this.devices.get(deviceId);
    if (!record) return null;
    if (!tokenHashMatches(record.tokenHash, token)) return null;
    record.lastSeenAt = Date.now();
    this.dirty = true;
    return record;
  }

  remove(deviceId: string): boolean {
    const had = this.devices.delete(deviceId);
    if (had) this.persist();
    return had;
  }

  list(): DeviceRecord[] {
    return [...this.devices.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  count(): number {
    return this.devices.size;
  }
}
