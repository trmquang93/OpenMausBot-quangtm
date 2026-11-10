// Stage node-pty (the built-in terminal's PTY, server/terminal/pty.ts) outside
// ASAR, one tree per platform and CPU:
//
//   node scripts/prepare-node-pty.mjs     # run by `pnpm build:node-pty`, part of package:prepare
//
// writes dist-native/node-pty/<platform>-<arch>/node_modules/node-pty/. The
// server requires it from <Resources>/node-pty/node_modules (OMB_RESOURCES_PATH,
// or OMB_NODE_PTY_DIR for a directory holding such a node_modules).
//
// node-pty 1.x is a Node-API addon, so one binary loads in system Node (Vitest,
// dev) and in Electron's Node (the packaged server under ELECTRON_RUN_AS_NODE):
// nothing is rebuilt per Electron ABI. Its npm package ships prebuilds for
// darwin-arm64, darwin-x64, win32-x64 and win32-arm64. Linux has none: install
// compiles build/Release/pty.node with node-gyp (pnpm-workspace.yaml allows the
// build script), and this script copies that.
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, chmodSync } from "node:fs";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { resolveCuaMacArches } from "./cua-mac-arches.mjs";
import { LIPO_ARCH, isMachO, machOArchs } from "./mac-thin.mjs";

const run = promisify(execFile);
export const PACKAGE = "node-pty";
const WIN_NATIVE = ["pty.node", "conpty.node", "conpty_console_list.node"];
const WIN_CONPTY = ["conpty.dll", "OpenConsole.exe"];

/** The exact x.y.z package.json pins; a range could let the staged tree and the tested one drift apart. */
export function pinnedNodePtyVersion(root) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const pin = manifest.dependencies?.[PACKAGE];
  if (!pin || !/^\d+\.\d+\.\d+$/.test(pin)) {
    throw new Error(`package.json must pin ${PACKAGE} to an exact x.y.z version; found ${pin ?? "nothing"}`);
  }
  return pin;
}

function packageVersion(directory) {
  return JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).version;
}

/** Both mac arches on macOS (each app is single-arch), x64 elsewhere, matching electron-builder.yml. */
export function targetsFor(platform = process.platform, env = process.env) {
  if (platform === "darwin") return resolveCuaMacArches(env).map((arch) => ({ platform, arch }));
  const arch = (platform === "linux" && env.OMB_NODE_PTY_ARCH) || "x64";
  if (arch !== "x64" && arch !== "arm64") throw new Error(`OMB_NODE_PTY_ARCH must be x64 or arm64; found ${arch}`);
  return [{ platform, arch }];
}

function requireRegularFile(file) {
  let details;
  try {
    details = lstatSync(file);
  } catch {
    throw new Error(`node-pty resource is missing: ${file}`);
  }
  if (!details.isFile() || details.isSymbolicLink()) throw new Error(`node-pty resource must be a regular file: ${file}`);
}

function requireExecutable(file) {
  requireRegularFile(file);
  if (process.platform !== "win32" && (statSync(file).mode & 0o111) !== 0o111) {
    throw new Error(`node-pty resource must be executable: ${file}`);
  }
}

/** The native files a platform needs beside lib/, relative to the package directory. */
export function nativeFiles(platform, arch) {
  const prebuild = `prebuilds/${platform}-${arch}`;
  if (platform === "darwin") return { addons: [`${prebuild}/pty.node`], helpers: [`${prebuild}/spawn-helper`], files: [] };
  if (platform === "win32") {
    return { addons: [], helpers: [], files: [...WIN_NATIVE.map((name) => `${prebuild}/${name}`), ...WIN_CONPTY.map((name) => `${prebuild}/conpty/${name}`)] };
  }
  return { addons: ["build/Release/pty.node"], helpers: [], files: [] };
}

/** A staged or packaged tree is complete, pinned, and holds only this platform's and arch's native code. */
export async function verifyNodePtyTree(directory, platform, arch, version) {
  const pkg = join(directory, "node_modules", PACKAGE);
  requireRegularFile(join(pkg, "package.json"));
  const found = packageVersion(pkg);
  if (version && found !== version) throw new Error(`${PACKAGE} in ${directory} is ${found}; package.json pins ${version}`);
  for (const file of ["lib/index.js", "lib/utils.js", "lib/unixTerminal.js", "lib/windowsTerminal.js"]) requireRegularFile(join(pkg, file));
  const { addons, helpers, files } = nativeFiles(platform, arch);
  for (const file of addons) requireExecutable(join(pkg, file));
  for (const file of helpers) requireExecutable(join(pkg, file));
  for (const file of files) requireRegularFile(join(pkg, file));
  const prebuilds = join(pkg, "prebuilds");
  if (existsSync(prebuilds)) {
    const others = readdirSync(prebuilds).filter((name) => name !== `${platform}-${arch}`);
    if (others.length) throw new Error(`${PACKAGE} in ${directory} carries other platforms' binaries: ${others.join(", ")}`);
  }
  if (platform === "darwin") {
    const wanted = LIPO_ARCH[arch];
    if (!wanted) throw new Error(`Unsupported macOS architecture for node-pty: ${arch}`);
    for (const file of [...addons, ...helpers]) {
      const path = join(pkg, file);
      if (!(await isMachO(path))) throw new Error(`${path} is not a Mach-O file`);
      const archs = await machOArchs(path);
      if (archs.join(" ") !== wanted) throw new Error(`${path} is [${archs.join(" ")}], must be exactly ${wanted}`);
    }
  }
}

const SKIPPED = /(?:\.test\.js|\.map|\.pdb)$/;

function installedPackage(nodeModules) {
  try {
    const real = realpathSync(join(nodeModules, PACKAGE));
    if (statSync(real).isDirectory()) return real;
  } catch {
  }
  return null;
}

export async function stageNodePty({
  root,
  nodeModules = join(root, "node_modules"),
  stage = join(root, "dist-native", "node-pty"),
  targets = targetsFor(),
  sign = process.platform === "darwin",
  log = console.log,
}) {
  const version = pinnedNodePtyVersion(root);
  const source = installedPackage(nodeModules);
  if (!source) throw new Error(`${PACKAGE} is not installed; run pnpm install`);
  const found = packageVersion(source);
  if (found !== version) throw new Error(`${PACKAGE} at ${source} is ${found}; package.json pins ${version}`);
  const staged = [];
  for (const { platform, arch } of targets) {
    const destination = join(stage, `${platform}-${arch}`);
    rmSync(destination, { recursive: true, force: true });
    const pkg = join(destination, "node_modules", PACKAGE);
    mkdirSync(pkg, { recursive: true });
    const keep = (path) => !SKIPPED.test(path);
    for (const file of ["package.json", "LICENSE"]) cpSync(join(source, file), join(pkg, file));
    cpSync(join(source, "lib"), join(pkg, "lib"), { recursive: true, dereference: true, filter: keep });
    const prebuild = join(source, "prebuilds", `${platform}-${arch}`);
    if (existsSync(prebuild)) {
      cpSync(prebuild, join(pkg, "prebuilds", `${platform}-${arch}`), { recursive: true, dereference: true, filter: keep });
    } else if (platform !== "linux") {
      throw new Error(`${PACKAGE} ${version} ships no prebuild for ${platform}-${arch}`);
    } else {
      const release = join(source, "build", "Release");
      if (!existsSync(join(release, "pty.node"))) {
        throw new Error(`${PACKAGE} has no Linux prebuild and ${release}/pty.node is missing. Install on Linux with a C++ toolchain, make and python3 so node-gyp can build it (pnpm install), then rerun.`);
      }
      mkdirSync(join(pkg, "build", "Release"), { recursive: true });
      for (const name of readdirSync(release)) {
        if (name.endsWith(".node")) cpSync(join(release, name), join(pkg, "build", "Release", name));
      }
    }
    if (platform !== "win32") {
      const { addons, helpers } = nativeFiles(platform, arch);
      // The npm tarball stores the macOS spawn-helper without its executable bit; posix_spawnp then fails.
      for (const file of [...addons, ...helpers]) {
        const path = join(pkg, file);
        if (existsSync(path)) chmodSync(path, 0o755);
      }
    }
    if (platform === "darwin" && sign) {
      // electron-builder re-signs these with the app's identity; a thin file needs a signature of its own to load before that.
      for (const file of [...nativeFiles(platform, arch).addons, ...nativeFiles(platform, arch).helpers]) {
        await run("/usr/bin/codesign", ["--force", "--sign", "-", join(pkg, file)]);
      }
    }
    await verifyNodePtyTree(destination, platform, arch, version);
    staged.push(destination);
    log?.(`Staged ${PACKAGE} ${version} for ${platform}-${arch} at ${destination}`);
  }
  return staged;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await stageNodePty({ root: join(dirname(fileURLToPath(import.meta.url)), "..") });
}
