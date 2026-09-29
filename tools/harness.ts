// A fake omp host that runs the *real* extension (src/bunny.ts) and records everything it does.
// Used by the test-suite and by tools/capture.ts, so the README images show true widget output.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type * as Bunny from "../src/bunny.ts";

export type BunnyModule = typeof Bunny & { default: (pi: ExtensionAPI) => void };

export interface Notice {
  message: string;
  level: string | undefined;
}

export interface HarnessOptions {
  /** Terminal width the extension sees through `process.stdout.columns`. */
  columns?: number;
  hasUI?: boolean;
  /** Pre-hatched bunny to write to the state file. Omit for a fresh install (no bunny yet). */
  state?: { id: string; name: string; hidden?: boolean; muted?: boolean };
  /** Run with NO_COLOR set (default: unset, so colour escapes are emitted whatever the parent shell says). */
  noColor?: boolean;
  /** Value forced into `randomUUID()` so a first hatch is reproducible. */
  hatchId?: string;
  /** Seed for `Math.random`, which picks reaction lines and pet lines. */
  randomSeed?: number;
  /** Start of the fake clock (ms since epoch). */
  startTime?: number;
}

let importCounter = 0;
// The extension does `import { randomUUID } from "node:crypto"`. ESM namespaces are read-only and Bun binds
// the named import when the extension is first evaluated, so the builtin is wrapped once, here, at load
// time: import this module *before* src/bunny.ts (tools/capture.ts asserts the forced id took effect).
const nodeCrypto = createRequire(import.meta.url)("node:crypto") as { randomUUID: () => string };
const realRandomUUID = nodeCrypto.randomUUID;
let forcedUUID: string | undefined;
nodeCrypto.randomUUID = () => forcedUUID ?? realRandomUUID();

/**
 * Boot patches globals (Date.now, Math.random, process.stdout.columns, env), so harnesses must be disposed
 * in reverse order of creation; interleaving several live ones shares the most recent fake clock.
 */
export class Harness {
  readonly dir: string;
  readonly stateFile: string;
  readonly notices: Notice[] = [];
  /** Every `setWidget("bunny", lines)` call, in order; `null` = widget removed. */
  readonly widgets: Array<string[] | null> = [];
  /** `options.placement` of every widget call, parallel to `widgets`. */
  readonly placements: Array<string | undefined> = [];
  readonly handlers = new Map<string, Array<(...args: never[]) => unknown>>();
  mod!: BunnyModule;
  command!: { handler: (args: string, ctx: ExtensionContext) => Promise<void>; getArgumentCompletions?: (p: string) => unknown };
  now: number;
  readonly ctx: ExtensionContext;
  private intervals = new Map<number, () => void>();
  private nextTimer = 1;
  private saved: { now: typeof Date.now; random: typeof Math.random; columns: PropertyDescriptor | undefined; env?: string; noColor?: string };

  private constructor(readonly options: HarnessOptions) {
    this.dir = mkdtempSync(join(tmpdir(), "bunny-harness-"));
    this.stateFile = join(this.dir, "bunny.json");
    this.now = options.startTime ?? Date.UTC(2026, 3, 1, 12, 0, 0);
    const self = this;
    this.ctx = {
      hasUI: options.hasUI ?? true,
      ui: {
        setWidget: (key: string, content: unknown, options?: { placement?: string }) => {
          if (key !== "bunny") return;
          self.widgets.push(content === undefined ? null : [...(content as string[])]);
          self.placements.push(options?.placement);
        },
        notify: (message: string, level?: string) => {
          self.notices.push({ message, level });
        },
      },
      setInterval: (cb: () => void) => {
        const id = self.nextTimer++;
        self.intervals.set(id, cb);
        return id;
      },
      clearTimer: (id: number) => {
        self.intervals.delete(id);
      },
    } as unknown as ExtensionContext;
    this.saved = undefined as never;
  }

  static async boot(options: HarnessOptions = {}): Promise<Harness> {
    const h = new Harness(options);
    h.saved = {
      now: Date.now,
      random: Math.random,
      columns: Object.getOwnPropertyDescriptor(process.stdout, "columns"),
      env: process.env.PI_CODING_AGENT_DIR,
      noColor: process.env.NO_COLOR,
    };
    Date.now = () => h.now;
    if (options.noColor) process.env.NO_COLOR = "1";
    else delete process.env.NO_COLOR;
    if (options.randomSeed !== undefined) {
      let a = options.randomSeed >>> 0;
      Math.random = () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    Object.defineProperty(process.stdout, "columns", { value: options.columns ?? 100, configurable: true, writable: true });
    process.env.PI_CODING_AGENT_DIR = h.dir;
    forcedUUID = options.hatchId;
    if (options.state) {
      // The state file stores what a real hatch would: identity + soul, never the bones.
      const mod = (await import("../src/bunny.ts")) as BunnyModule;
      const { id, name, hidden = false, muted = false } = options.state;
      mkdirSync(h.dir, { recursive: true });
      writeFileSync(
        h.stateFile,
        JSON.stringify({ id, name, personality: mod.PERSONALITY[mod.peakStat(mod.rollBones(id))], hatchedAt: h.now, hidden, muted }),
      );
    }
    // Fresh module instance per boot: the extension keeps its state in module-level variables.
    h.mod = (await import(`../src/bunny.ts?boot=${++importCounter}`)) as BunnyModule;
    const pi = {
      registerCommand: (name: string, spec: Harness["command"]) => {
        if (name === "bunny") h.command = spec;
      },
      on: (event: string, fn: (...args: never[]) => unknown) => {
        h.handlers.set(event, [...(h.handlers.get(event) ?? []), fn]);
      },
    } as unknown as ExtensionAPI;
    h.mod.default(pi);
    return h;
  }

  /** Run `/bunny <args>`. */
  async run(args = ""): Promise<void> {
    await this.command.handler(args, this.ctx);
  }

  async emit(event: string, payload: object = {}): Promise<void> {
    for (const fn of this.handlers.get(event) ?? []) await (fn as (e: object, c: ExtensionContext) => unknown)(payload, this.ctx);
  }

  /** Advance the fake clock by `ms` and fire the extension's 500 ms interval once per elapsed tick. */
  advance(ms: number): void {
    const ticks = Math.round(ms / 500);
    for (let i = 0; i < ticks; i++) {
      this.now += 500;
      for (const cb of [...this.intervals.values()]) cb();
    }
  }

  get activeTimers(): number {
    return this.intervals.size;
  }

  get lastWidget(): string[] | null | undefined {
    return this.widgets[this.widgets.length - 1];
  }

  readState(): Record<string, unknown> {
    return JSON.parse(readFileSync(this.stateFile, "utf8"));
  }

  dispose(): void {
    Date.now = this.saved.now;
    Math.random = this.saved.random;
    forcedUUID = undefined;
    if (this.saved.columns) Object.defineProperty(process.stdout, "columns", this.saved.columns);
    else delete (process.stdout as { columns?: number }).columns;
    if (this.saved.env === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = this.saved.env;
    if (this.saved.noColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = this.saved.noColor;
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** Strip the SGR colour escapes the extension emits. */
export const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");
