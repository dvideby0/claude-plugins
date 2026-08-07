const { access, mkdir, mkdtemp, readdir, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

const ARCH_NAMES = new Map([
  [0, "ia32"],
  [1, "x64"],
  [2, "armv7l"],
  [3, "arm64"],
  [4, "universal"],
]);

const NATIVE_BY_TARGET = new Map([
  ["darwin-arm64", "scan-core.darwin-arm64.node"],
  ["darwin-x64", "scan-core.darwin-x64.node"],
  ["win32-x64", "scan-core.win32-x64-msvc.node"],
  ["linux-x64", "scan-core.linux-x64-gnu.node"],
  ["linux-arm64", "scan-core.linux-arm64-gnu.node"],
]);

function packagedAppDir(context) {
  const platform = context.electronPlatformName;
  if (platform === "darwin") {
    return join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
      "Contents",
      "Resources",
      "app",
    );
  }
  return join(context.appOutDir, "resources", "app");
}

async function removeIfPresent(path) {
  await rm(path, { recursive: true, force: true });
}

async function requirePath(path) {
  try {
    await access(path);
  } catch {
    throw new Error(`Desktop package is missing required runtime path: ${path}`);
  }
}

async function verifyTypedAnalysis(app) {
  const fixture = await mkdtemp(join(tmpdir(), "sdlc-packaged-types-"));
  try {
    const source = join(fixture, "src");
    await mkdir(source);
    await Promise.all([
      writeFile(join(fixture, "package.json"), JSON.stringify({ type: "module" })),
      writeFile(
        join(fixture, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "Bundler",
            strict: true,
          },
          include: ["src/**/*"],
        }),
      ),
      writeFile(join(source, "store.ts"), "export class Store { run() { return 1; } }\n"),
      writeFile(
        join(source, "app.ts"),
        'import { Store } from "./store.js";\nconst values: Store[] = [];\nvalues.map(value => value.run());\n',
      ),
    ]);

    const typedModule = pathToFileURL(
      join(app, "node_modules", "@sdlc", "engine", "dist", "graph", "typed.js"),
    ).href;
    const { analyseTypes } = await import(typedModule);
    const analysis = analyseTypes(fixture);
    const resolvedRun = analysis.references.some(
      (reference) => reference.name === "run" && reference.dst === "src/store.ts",
    );
    if (!analysis.ran || !resolvedRun) {
      throw new Error(
        "Packaged TypeScript analysis could not resolve a method through Array.map; runtime declarations are incomplete.",
      );
    }
  } finally {
    await removeIfPresent(fixture);
  }
}

module.exports = async function afterPack(context) {
  const app = packagedAppDir(context);
  const packages = join(app, "node_modules", "@sdlc");

  const developmentOnly = {
    engine: ["src", "tsconfig.json", "vitest.config.ts"],
    protocol: ["src", "tsconfig.json"],
    "mcp-bridge": ["src", "tsconfig.json"],
    "scan-core": [
      ".cargo",
      "src",
      "target",
      "Cargo.lock",
      "Cargo.toml",
      "build.mjs",
      "build.rs",
    ],
  };

  for (const [name, entries] of Object.entries(developmentOnly)) {
    for (const entry of entries) {
      await removeIfPresent(join(packages, name, entry));
    }
  }

  const required = [
    join(packages, "engine", "dist", "daemon", "main.js"),
    join(packages, "engine", "content"),
    join(packages, "engine", "ui", "index.html"),
    join(packages, "protocol", "dist", "index.js"),
    join(packages, "mcp-bridge", "dist", "index.js"),
    join(packages, "scan-core", "index.js"),
    join(app, "node_modules", "@sourcegraph", "scip-typescript", "dist", "src", "main.js"),
    // Typed resolution runs from the packaged compiler. Removing declarations
    // makes ordinary built-ins such as Array.map opaque only after packaging.
    join(app, "node_modules", "typescript", "lib", "lib.d.ts"),
  ];
  await Promise.all(required.map(requirePath));

  const nativeDir = join(packages, "scan-core");
  const nativeFiles = (await readdir(nativeDir)).filter((name) =>
    name.endsWith(".node"),
  );
  const arch = ARCH_NAMES.get(context.arch);
  const expectedNative = NATIVE_BY_TARGET.get(`${context.electronPlatformName}-${arch}`);
  if (!expectedNative) {
    throw new Error(
      `Desktop packaging does not define a scan-core artifact for ${context.electronPlatformName}-${arch}.`,
    );
  }
  await requirePath(join(nativeDir, expectedNative));

  // A release job downloads all native artifacts before packaging. Each app
  // keeps only its own architecture: this both avoids signing foreign binary
  // formats and proves the exact module its generated loader will require is
  // present, instead of accepting an arbitrary host build.
  await Promise.all(
    nativeFiles
      .filter((name) => name !== expectedNative)
      .map((name) => removeIfPresent(join(nativeDir, name))),
  );

  await verifyTypedAnalysis(app);
};
