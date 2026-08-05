const { access, readdir, rm } = require("node:fs/promises");
const { join } = require("node:path");

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
  ];
  await Promise.all(required.map(requirePath));

  const nativeFiles = (await readdir(join(packages, "scan-core"))).filter((name) =>
    name.endsWith(".node"),
  );
  if (nativeFiles.length === 0) {
    throw new Error("Desktop package is missing the platform scan-core native module.");
  }
};
