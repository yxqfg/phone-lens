import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** How an uploaded photo reaches the user (user-selected in the web UI settings). */
export type SaveMode = "composer" | "folder" | "both";

export const SAVE_MODES: readonly SaveMode[] = ["composer", "folder", "both"];

export interface AppSettings {
  /** composer = stage into the chat box draft; folder = save to saveDir; both = both. */
  saveMode: SaveMode;
  /** Absolute target folder for folder/both modes. Empty = built-in default. */
  saveDir: string;
}

/**
 * User-facing capture settings, persisted as JSON under the plugin data dir.
 * Stored host-side on purpose: the folder save happens on this machine, and
 * every loopback view (overlay, /view.html) must see the same mode.
 */
export class AppSettingsStore {
  private data: AppSettings;

  constructor(
    /** e.g. ~/.dsh/phone-lens/settings.json */
    private readonly file: string,
    /** Built-in default folder when saveDir is empty. */
    private readonly defaultSaveDir: string,
  ) {
    this.data = { saveMode: "composer", saveDir: "" };
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<AppSettings>;
      if (SAVE_MODES.includes(raw.saveMode as SaveMode)) this.data.saveMode = raw.saveMode as SaveMode;
      if (typeof raw.saveDir === "string") this.data.saveDir = raw.saveDir;
    } catch {
      // corrupt settings file: start with defaults rather than refuse to boot
    }
  }

  get(): AppSettings {
    return { ...this.data };
  }

  /** Effective absolute folder (resolved default when unset). */
  effectiveSaveDir(): string {
    return this.data.saveDir.trim() || this.defaultSaveDir;
  }

  set(patch: Partial<AppSettings>): AppSettings {
    if (patch.saveMode && SAVE_MODES.includes(patch.saveMode)) this.data.saveMode = patch.saveMode;
    if (typeof patch.saveDir === "string") {
      // strip wrapping quotes (right-click "copy path" often adds them)
      this.data.saveDir = patch.saveDir.replace(/^["']|["']$/g, "").trim();
    }
    this.persist();
    return this.get();
  }

  private persist(): void {
    try {
      mkdirSync(join(this.file, ".."), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
      renameSync(tmp, this.file);
    } catch {
      // persistence is best-effort; runtime keeps working with in-memory values
    }
  }
}
