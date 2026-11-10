import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * M23: only DbService touches the raw pool/client. Nothing outside `src/db/`
 * may import the DB tokens, and the service keeps them private so tenant
 * queries always flow through `withTenant`.
 */
function srcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...srcFiles(path));
    else if (path.endsWith(".ts")) out.push(path);
  }
  return out;
}

describe("db encapsulation (M23)", () => {
  const src = join(__dirname, "..", "..", "src");

  it("exports only DbService from DbModule", () => {
    const module = readFileSync(join(src, "db", "db.module.ts"), "utf8");
    expect(module).toContain("exports: [DbService]");
    expect(module).not.toMatch(/exports:.*DB_POOL/);
  });

  it("keeps the pool and client private on DbService", () => {
    const service = readFileSync(join(src, "db", "db.service.ts"), "utf8");
    expect(service).toContain("private readonly pool");
    expect(service).toContain("private readonly db");
  });

  it("has no non-db importer of the db tokens", () => {
    const dbDir = join(src, "db");
    const offenders: string[] = [];
    for (const path of srcFiles(src)) {
      if (path.startsWith(`${dbDir}/`)) continue;
      const content = readFileSync(path, "utf8");
      // The DB tokens (DB_POOL / the DB symbol) must never leak out of src/db.
      // AppModule legitimately imports the DbModule class itself.
      const stripped = content.replace(/import\s*{\s*DbModule\s*}\s*from\s*["'][^"']+["'];?/g, "");
      if (/DB_POOL/.test(stripped) || /from ["']\.\.?\/.*db\.module["']/.test(stripped)) {
        offenders.push(path.replace(`${src}/`, ""));
      }
    }
    expect(offenders).toEqual([]);
  });
});
