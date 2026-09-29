// install.sh against throw-away agent dirs (PI_CODING_AGENT_DIR); never the real one.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const SRC = join(REPO, "src", "bunny.ts");
let dirs: string[] = [];

function agentDir(): string {
  const d = mkdtempSync(join(tmpdir(), "bunny-install-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function install(dir: string, ...args: string[]) {
  const p = Bun.spawnSync(["bash", join(REPO, "install.sh"), ...args], {
    env: { ...process.env, PI_CODING_AGENT_DIR: dir, HOME: "/nonexistent-home" },
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}
const target = (dir: string) => join(dir, "extensions", "bunny.ts");

describe("install.sh", () => {
  test("default: symlinks the extension into <dir>/extensions and creates the directory", () => {
    const dir = agentDir();
    const r = install(dir);
    expect(r.code).toBe(0);
    expect(lstatSync(target(dir)).isSymbolicLink()).toBe(true);
    expect(readlinkSync(target(dir))).toBe(SRC);
    expect(readFileSync(target(dir), "utf8")).toBe(readFileSync(SRC, "utf8"));
  });

  test("is idempotent and leaves no temp files behind", () => {
    const dir = agentDir();
    install(dir);
    const again = install(dir);
    expect(again.code).toBe(0);
    expect(again.out).toContain("already installed");
    expect(readdirSync(join(dir, "extensions"))).toEqual(["bunny.ts"]);
  });

  test("--copy installs a regular file, and re-running reports it up to date", () => {
    const dir = agentDir();
    expect(install(dir, "--copy").code).toBe(0);
    expect(lstatSync(target(dir)).isSymbolicLink()).toBe(false);
    expect(readFileSync(target(dir), "utf8")).toBe(readFileSync(SRC, "utf8"));
    expect(install(dir, "--copy").out).toContain("up to date");
  });

  test("switching between link and copy replaces our own entry without --force", () => {
    const dir = agentDir();
    install(dir);
    expect(install(dir, "--copy").code).toBe(0);
    expect(lstatSync(target(dir)).isSymbolicLink()).toBe(false);
    expect(install(dir).code).toBe(0);
    expect(lstatSync(target(dir)).isSymbolicLink()).toBe(true);
  });

  test("an outdated copy of ours is refreshed", () => {
    const dir = agentDir();
    mkdirSync(join(dir, "extensions"));
    writeFileSync(target(dir), `${readFileSync(SRC, "utf8").split("\n")[0]}\n// old version\n`);
    expect(install(dir, "--copy").code).toBe(0);
    expect(readFileSync(target(dir), "utf8")).toBe(readFileSync(SRC, "utf8"));
  });

  test("refuses to clobber someone else's bunny.ts; --force replaces it and keeps a .bak", () => {
    const dir = agentDir();
    mkdirSync(join(dir, "extensions"));
    writeFileSync(target(dir), "export default () => {}\n");
    const refused = install(dir);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("--force");
    expect(readFileSync(target(dir), "utf8")).toBe("export default () => {}\n");

    const forced = install(dir, "--force");
    expect(forced.code).toBe(0);
    expect(lstatSync(target(dir)).isSymbolicLink()).toBe(true);
    expect(readFileSync(`${target(dir)}.bak`, "utf8")).toBe("export default () => {}\n");
  });

  test("never touches other extensions or bunny.json", () => {
    const dir = agentDir();
    mkdirSync(join(dir, "extensions"));
    writeFileSync(join(dir, "extensions", "other.ts"), "// other\n");
    writeFileSync(join(dir, "bunny.json"), '{"id":"keep-me","name":"Keep"}\n');
    install(dir);
    install(dir, "--uninstall");
    expect(readFileSync(join(dir, "extensions", "other.ts"), "utf8")).toBe("// other\n");
    expect(readFileSync(join(dir, "bunny.json"), "utf8")).toBe('{"id":"keep-me","name":"Keep"}\n');
  });

  test("--uninstall removes our link or copy, and only ours", () => {
    const dir = agentDir();
    install(dir);
    expect(install(dir, "--uninstall").code).toBe(0);
    expect(existsSync(target(dir))).toBe(false);

    install(dir, "--copy");
    install(dir, "--uninstall");
    expect(existsSync(target(dir))).toBe(false);

    writeFileSync(target(dir), "// somebody else's bunny\n");
    const r = install(dir, "--uninstall");
    expect(r.code).toBe(0);
    expect(r.out).toContain("left");
    expect(readFileSync(target(dir), "utf8")).toBe("// somebody else's bunny\n");
  });

  test("--uninstall leaves a symlink that points elsewhere", () => {
    const dir = agentDir();
    mkdirSync(join(dir, "extensions"));
    const elsewhere = join(dir, "elsewhere.ts");
    writeFileSync(elsewhere, "// elsewhere\n");
    Bun.spawnSync(["ln", "-s", elsewhere, target(dir)]);
    install(dir, "--uninstall");
    expect(readlinkSync(target(dir))).toBe(elsewhere);
  });

  test("uninstalling when nothing is installed is a no-op", () => {
    const dir = agentDir();
    const r = install(dir, "--uninstall");
    expect(r.code).toBe(0);
    expect(r.out).toContain("nothing to remove");
  });

  test("a directory in the way is never removed", () => {
    const dir = agentDir();
    mkdirSync(target(dir), { recursive: true });
    expect(install(dir, "--force").code).toBe(1);
    expect(lstatSync(target(dir)).isDirectory()).toBe(true);
  });

  test("unknown options fail with usage", () => {
    const r = install(agentDir(), "--bogus");
    expect(r.code).toBe(2);
    expect(r.err).toContain("unknown option");
  });

  test("the installed link still loads as an extension factory", async () => {
    const dir = agentDir();
    install(dir);
    const mod = await import(`${target(dir)}?probe=${Date.now()}`);
    expect(typeof mod.default).toBe("function");
  });
});
