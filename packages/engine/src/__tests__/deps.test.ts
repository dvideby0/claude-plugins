import { afterEach, describe, expect, it } from "vitest";
import { collectDependencies } from "../analyze/deps.js";
import { cleanup, makeProject } from "./helpers.js";

let root: string;
afterEach(async () => {
  if (root) await cleanup(root);
});

describe("dependency inventory", () => {
  it("reads npm lockfile v1 recursive dependency trees", async () => {
    root = await makeProject({
      "package-lock.json": JSON.stringify({
        name: "legacy-lock",
        lockfileVersion: 1,
        dependencies: {
          lodash: {
            version: "4.17.20",
            dependencies: { "left-pad": { version: "1.3.0" } },
          },
          "@scope/pkg": { version: "2.0.0" },
        },
      }),
    });

    const dependencies = await collectDependencies(root);
    expect(dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "lodash", version: "4.17.20", ecosystem: "npm" }),
        expect.objectContaining({ name: "left-pad", version: "1.3.0", ecosystem: "npm" }),
        expect.objectContaining({ name: "@scope/pkg", version: "2.0.0", ecosystem: "npm" }),
      ]),
    );
  });
});
