import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** How an uploaded photo reaches the user. */
export type SaveMode = "composer" | "folder" | "both";

export interface AppSettings {
  /** composer = draft into the chat box; folder = save to saveDir; both = both. */
  saveMode: SaveMode;
  /** Absolute target folder for folder/both modes. Empty = built-in default. */
  saveDir: string;
  /** Debounce window (ms) after the last upload before the folder-index notice is injected. */
  indexNoticeMs: number;
}

const VALID_MODES: SaveMode[] = ["composer", "folder", "both"];

export class AppSettingsStore {
  private data: AppSettings;

  constructor(
    /** e.g. ~/.dsh/phone-lens/settings.json */
    private readonly file: string,
    /** Built-in default folder when saveDir is empty. */
    private readonly defaultSaveDir: string,
  ) {
    this.data = { saveMode: "composer", saveDir: "", indexNoticeMs: 15_000 };
    this.load();
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<AppSettings>;
      if (VALID_MODES.includes(raw.saveMode as SaveMode)) this.data.saveMode = raw.saveMode as SaveMode;
      if (typeof raw.saveDir === "string") this.data.saveDir = raw.saveDir;
      if (Number.isInteger(raw.indexNoticeMs) && (raw.indexNoticeMs as number) >= 3_000) this.data.indexNoticeMs = raw.indexNoticeMs as number;
    } catch {
      // first run / unreadable file — keep defaults
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
    if (patch.saveMode && VALID_MODES.includes(patch.saveMode)) this.data.saveMode = patch.saveMode;
    if (typeof patch.saveDir === "string") this.data.saveDir = patch.saveDir.trim();
    if (Number.isInteger(patch.indexNoticeMs) && (patch.indexNoticeMs as number) >= 3_000) this.data.indexNoticeMs = patch.indexNoticeMs;
    this.persist();
    return this.get();
  }

  private persist(): void {
    try {
      mkdirSync(join(this.file, ".."), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch {
      // persistence is best-effort; runtime keeps working with in-memory values
    }
  }
}
