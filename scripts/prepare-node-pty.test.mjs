import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pinnedNodePtyVersion, stageNodePty, targetsFor, verifyNodePtyTree } from "./prepare-node-pty.mjs";

const PIN = "9.9.9";
const temporaryDirectories = [];
const unix = process.platform !== "win32";

function temporary(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function write(file, content = "x", mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
  fs.chmodSync(file, mode);
}

/** A node_modules holding a node-pty package that carries prebuilds for several platforms, as the npm tarball does. */
function install({ version = PIN, release = false } = {}) {
  const root = temporary("omb-node-pty-root-");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { "node-pty": PIN } }));
  const pkg = path.join(root, "node_modules", "node-pty");
  write(path.join(pkg, "package.json"), JSON.stringify({ name: "node-pty", version }));
  write(path.join(pkg, "LICENSE"), "license");
  for (const name of ["index.js", "utils.js", "unixTerminal.js", "windowsTerminal.js", "terminal.test.js", "index.js.map"]) write(path.join(pkg, "lib", name));
  write(path.join(pkg, "lib", "shared", "conout.js"));
  const prebuilds = path.join(pkg, "prebuilds");
  for (const target of ["darwin-arm64", "darwin-x64"]) {
    write(path.join(prebuilds, target, "pty.node"));
    write(path.join(prebuilds, target, "spawn-helper"));
  }
  for (const target of ["win32-x64", "win32-arm64"]) {
    for (const name of ["pty.node", "conpty.node", "conpty_console_list.node", "pty.pdb", "winpty.dll"]) write(path.join(prebuilds, target, name));
    for (const name of ["conpty.dll", "OpenConsole.exe"]) write(path.join(prebuilds, target, "conpty", name));
  }
  if (release) write(path.join(pkg, "build", "Release", "pty.node"), "built", 0o755);
  return { root, nodeModules: path.join(root, "node_modules") };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("the installer", () => {
  it("copies the node_modules directory itself: electron-builder drops a root-level node_modules from any tree it copies", () => {
    const yml = fs.readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const entries = [...yml.matchAll(/from: (dist-native\/node-pty\/[^\n]+)\n\s+to: ([^\n]+)/g)].map((m) => [m[1], m[2]]);
    expect(entries.map(([from]) => from.split("/")[2].replace("${arch}", "arch")).sort()).toEqual(["darwin-arch", "linux-x64", "win32-x64"]);
    for (const [from, to] of entries) {
      expect(from, from).toMatch(/\/node_modules$/);
      expect(to).toBe("node-pty/node_modules");
    }
  });
});

describe("the pin", () => {
  it("requires an exact x.y.z version of node-pty", () => {
    const { root } = install();
    expect(pinnedNodePtyVersion(root)).toBe(PIN);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { "node-pty": "^9.9.9" } }));
    expect(() => pinnedNodePtyVersion(root)).toThrow(/exact x\.y\.z version/);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: {} }));
    expect(() => pinnedNodePtyVersion(root)).toThrow(/found nothing/);
  });

  it("stages both mac arches and x64 elsewhere", () => {
    expect(targetsFor("darwin", {})).toEqual([{ platform: "darwin", arch: "arm64" }, { platform: "darwin", arch: "x64" }]);
    expect(targetsFor("linux", {})).toEqual([{ platform: "linux", arch: "x64" }]);
    expect(targetsFor("linux", { OMB_NODE_PTY_ARCH: "arm64" })).toEqual([{ platform: "linux", arch: "arm64" }]);
    expect(() => targetsFor("linux", { OMB_NODE_PTY_ARCH: "amd64" })).toThrow(/OMB_NODE_PTY_ARCH/);
    expect(targetsFor("win32", {})).toEqual([{ platform: "win32", arch: "x64" }]);
  });
});

describe("staging from an install", () => {
  it("keeps only the Windows files this target needs, without symbols, tests or other platforms", async () => {
    const { root } = install();
    const [tree] = await stageNodePty({ root, targets: [{ platform: "win32", arch: "x64" }], sign: false, log: null });
    const pkg = path.join(tree, "node_modules", "node-pty");
    expect(fs.readdirSync(path.join(pkg, "prebuilds"))).toEqual(["win32-x64"]);
    expect(fs.readdirSync(path.join(pkg, "prebuilds", "win32-x64")).sort()).toEqual(["conpty", "conpty.node", "conpty_console_list.node", "pty.node", "winpty.dll"]);
    expect(fs.readdirSync(path.join(pkg, "lib")).sort()).toEqual(["index.js", "shared", "unixTerminal.js", "utils.js", "windowsTerminal.js"]);
    expect(fs.readFileSync(path.join(pkg, "LICENSE"), "utf8")).toBe("license");
  });

  it.skipIf(!unix)("copies the Linux build, which has no prebuild, and makes it executable", async () => {
    const { root } = install({ release: true });
    fs.chmodSync(path.join(root, "node_modules", "node-pty", "build", "Release", "pty.node"), 0o644);
    const [tree] = await stageNodePty({ root, targets: [{ platform: "linux", arch: "x64" }], sign: false, log: null });
    const addon = path.join(tree, "node_modules", "node-pty", "build", "Release", "pty.node");
    expect(fs.readFileSync(addon, "utf8")).toBe("built");
    expect(fs.statSync(addon).mode & 0o777).toBe(0o755);
    expect(fs.existsSync(path.join(tree, "node_modules", "node-pty", "prebuilds"))).toBe(false);
  });

  it("says what to install when Linux has no build", async () => {
    const { root } = install();
    await expect(stageNodePty({ root, targets: [{ platform: "linux", arch: "x64" }], sign: false, log: null }))
      .rejects.toThrow(/no Linux prebuild .*node-gyp/);
  });

  it("refuses an installed package whose version is not the pin", async () => {
    const { root } = install({ version: "9.9.8" });
    await expect(stageNodePty({ root, targets: [{ platform: "win32", arch: "x64" }], sign: false, log: null }))
      .rejects.toThrow(/is 9\.9\.8; package\.json pins 9\.9\.9/);
  });

  it("refuses a missing install", async () => {
    const root = temporary("omb-node-pty-none-");
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { "node-pty": PIN } }));
    await expect(stageNodePty({ root, targets: [{ platform: "win32", arch: "x64" }], sign: false, log: null })).rejects.toThrow(/run pnpm install/);
  });

  it.skipIf(!unix)("rejects a tree whose addon lost its executable bit, carries another platform, or has a symlinked addon", async () => {
    const { root } = install({ release: true });
    const [tree] = await stageNodePty({ root, targets: [{ platform: "linux", arch: "x64" }], sign: false, log: null });
    const pkg = path.join(tree, "node_modules", "node-pty");
    const addon = path.join(pkg, "build", "Release", "pty.node");
    await verifyNodePtyTree(tree, "linux", "x64", PIN);
    fs.chmodSync(addon, 0o644);
    await expect(verifyNodePtyTree(tree, "linux", "x64", PIN)).rejects.toThrow(/must be executable/);
    fs.chmodSync(addon, 0o755);
    write(path.join(pkg, "prebuilds", "win32-x64", "pty.node"));
    await expect(verifyNodePtyTree(tree, "linux", "x64", PIN)).rejects.toThrow(/other platforms/);
    fs.rmSync(path.join(pkg, "prebuilds"), { recursive: true });
    fs.rmSync(addon);
    fs.symlinkSync(path.join(pkg, "package.json"), addon);
    await expect(verifyNodePtyTree(tree, "linux", "x64", PIN)).rejects.toThrow(/regular file/);
  });
});

const host = `${process.platform}-${process.arch}`;
describe.skipIf(!["darwin-arm64", "darwin-x64"].includes(host))("the real package on this Mac", () => {
  it("stages a tree that spawns a shell, although the npm tarball ships spawn-helper without its executable bit", async () => {
    const repo = path.join(import.meta.dirname, "..");
    const stage = temporary("omb-node-pty-stage-");
    const [tree] = await stageNodePty({ root: repo, stage, targets: [{ platform: "darwin", arch: process.arch }], sign: true, log: null });
    const helper = path.join(tree, "node_modules", "node-pty", "prebuilds", host, "spawn-helper");
    expect(fs.statSync(helper).mode & 0o777).toBe(0o755);
    const script = `const { createRequire } = require("node:module");
const pty = createRequire(process.argv[1] + "/node_modules/x.js")("node-pty");
const t = pty.spawn("/bin/sh", ["-c", "printf ready; exit 3"], { cols: 80, rows: 24, env: { PATH: process.env.PATH } });
let out = "";
t.onData((d) => { out += d; });
t.onExit((e) => { process.stdout.write(JSON.stringify({ out, code: e.exitCode })); process.exit(0); });`;
    const result = spawnSync(process.execPath, ["-e", script, tree], { encoding: "utf8", timeout: 20_000 });
    expect(JSON.parse(result.stdout)).toEqual({ out: "ready", code: 3 });
  });
});
