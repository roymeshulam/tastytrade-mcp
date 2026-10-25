/**
 * The npm package is installable and runnable as published
 * (tastytrade/tastytrade-mcp#46).
 *
 * A package that installs but whose bin has no shebang, points at a file the
 * build does not emit, or leaves out a file read at runtime fails only on the
 * user's machine. These are the properties `npm pack` cannot check for us.
 */

import { describe, expect, it } from "@jest/globals";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name: string) => readFileSync(path.join(ROOT, name), "utf8");

interface PackageJson {
  name: string;
  version: string;
  private?: boolean;
  main: string;
  bin: Record<string, string>;
  files: string[];
  mcpName?: string;
  publishConfig?: { access?: string };
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
}

const PKG = JSON.parse(read("package.json")) as PackageJson;
const MANIFEST = JSON.parse(read("server.json")) as {
  name: string;
  version: string;
  packages?: Array<{
    registryType: string;
    identifier: string;
    version: string;
    transport: { type: string };
  }>;
};

/** dist/x.js is emitted from src/x.ts. */
function sourceOf(distPath: string): string {
  return distPath.replace(/^dist\//, "src/").replace(/\.js$/, ".ts");
}

describe("package.json is publishable", () => {
  it("is not marked private and publishes its scoped name publicly", () => {
    expect(PKG.private).toBeUndefined();
    expect(PKG.name.startsWith("@")).toBe(true);
    expect(PKG.publishConfig?.access).toBe("public");
  });

  it.each(Object.entries(PKG.bin))(
    "bin %s points at a built entrypoint with a node shebang",
    (_name, target) => {
      expect(target).toMatch(/^dist\/.+\.js$/);
      const src = sourceOf(target);
      expect(existsSync(path.join(ROOT, src))).toBe(true);
      // tsc keeps a leading shebang; without one npm's bin shim cannot run it.
      expect(read(src).startsWith("#!/usr/bin/env node\n")).toBe(true);
    },
  );

  it("ships the server and the doctor as commands", () => {
    expect(PKG.bin["tastytrade-mcp"]).toBe(PKG.main);
    expect(PKG.bin["tastytrade-mcp-doctor"]).toBe("dist/doctor.js");
  });

  it("ships every file read at runtime, and the licence grant for the docs", () => {
    // version.ts reads package.json (always packed); the vendored docs are read
    // at module load; NOTICE is what licenses redistributing those docs.
    for (const entry of [
      "dist",
      "tastytrade-llms-txt-docs",
      "LICENSE",
      "NOTICE",
      "README.md",
    ]) {
      expect(PKG.files).toContain(entry);
    }
  });

  it("builds from a clean dist/ when packed, so no stale module ships", () => {
    expect(PKG.scripts.prepack).toMatch(/clean/);
    expect(PKG.scripts.prepack).toMatch(/build/);
  });

  it("does not let a fresh install resolve an SDK with a known HIGH advisory", () => {
    // npm consumers get no lockfile: the range floor is what they resolve.
    expect(PKG.dependencies["@modelcontextprotocol/sdk"]).toBe("^1.32.2");
  });
});

describe("server.json describes the npm package", () => {
  it("names the registry identity package.json claims", () => {
    expect(PKG.mcpName).toBe(MANIFEST.name);
  });

  it("lists exactly this package, at this version, over stdio", () => {
    expect(MANIFEST.packages).toEqual([
      expect.objectContaining({
        registryType: "npm",
        identifier: PKG.name,
        version: PKG.version,
        transport: { type: "stdio" },
      }),
    ]);
  });
});
