import { join } from "node:path";
import { homedir } from "node:os";
import { env } from "node:process";

/** Where pairing records + fallback uploads live (mirrors dsh-home conventions). */
export function lensDataDir(): string {
  const home = env.DSH_HOME ?? join(homedir(), ".dsh");
  return join(home, "phone-lens");
}
