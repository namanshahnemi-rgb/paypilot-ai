// Static checks of what the production server loads, by following the
// relative imports from src/index.ts:
// - the SQLite driver (a native module used only by unit tests) is never
//   loaded in production;
// - the AI modules never import payment code, so model output has no path to
//   creating, capturing, or confirming a payment;
// - the SQLite driver is a development dependency, and the production build
//   compiles only what index.ts imports (no tests).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.dirname(fileURLToPath(import.meta.url));

function importsOf(file: string): { local: string[]; packages: string[] } {
  const source = fs.readFileSync(path.join(SRC, file), "utf8");
  const specifiers = [...source.matchAll(/^\s*(?:import|export)\b[^"']*?from\s+["']([^"']+)["']/gm)].map(
    (match) => match[1]!,
  );
  return {
    local: specifiers.filter((s) => s.startsWith("./")).map((s) => s.slice(2).replace(/\.js$/, ".ts")),
    packages: specifiers.filter((s) => !s.startsWith(".")),
  };
}

function reachableFrom(entry: string) {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const { local, packages: used } = importsOf(file);
    used.forEach((name) => packages.add(name));
    queue.push(...local);
  }
  return { files, packages };
}

test("the production server never loads the SQLite test registry or its native driver", () => {
  const { files, packages } = reachableFrom("index.ts");
  assert.ok(files.has("postgresOrderRegistry.ts"), "sanity check: the graph was followed");
  assert.ok(files.has("paymentRoutes.ts"));
  for (const testOnly of ["orderRegistry.ts", "database.ts"]) {
    assert.ok(!files.has(testOnly), `${testOnly} is reachable from index.ts`);
  }
  assert.ok(!packages.has("better-sqlite3"));
});

test("AI modules never import payment, checkout, or database code", () => {
  const forbidden = /paypal|payment|checkout|order|postgres|database/i;
  for (const aiModule of ["analysis.ts", "proposalGenerator.ts", "riskReview.ts", "localModel.ts", "proposal.ts", "proposalQuality.ts"]) {
    const { files } = reachableFrom(aiModule);
    for (const file of files) {
      assert.ok(!forbidden.test(file), `${aiModule} reaches ${file}`);
    }
  }
});

test("the SQLite driver is a development dependency, and the production build compiles only the server's imports", () => {
  const root = path.join(SRC, "..");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    scripts: Record<string, string>;
  };
  // npm prune --omit=dev (the Docker prod-deps stage) removes it from the image.
  assert.ok(!("better-sqlite3" in manifest.dependencies));
  assert.ok("better-sqlite3" in manifest.devDependencies);

  // tsconfig.build.json starts at index.ts, so tests and the SQLite registry
  // are never compiled into dist/ (tsc follows imports from "files" only).
  assert.equal(manifest.scripts.build, "tsc -p tsconfig.build.json");
  const buildConfig = fs.readFileSync(path.join(root, "tsconfig.build.json"), "utf8");
  const withoutComments = buildConfig.replace(/^\s*\/\/.*$/gm, "");
  const parsed = JSON.parse(withoutComments) as { files?: string[]; include?: string[] };
  assert.deepEqual(parsed.files, ["src/index.ts"]);
  assert.equal(parsed.include, undefined);
  for (const file of reachableFrom("index.ts").files) {
    assert.ok(!file.endsWith(".test.ts"), `${file} is a test reachable from index.ts`);
  }
});

test("every AI route requires a signed-in user, a permission and a plan check (Pro, or the monthly analysis allowance) before any AI work", () => {
  const source = fs.readFileSync(path.join(SRC, "index.ts"), "utf8").replace(/\s+/g, " ");
  // The guards come first, before the AI rate limiter and the handler.
  for (const [route, guards] of [
    ["/api/proposals/analyze", "canAnalyzeBriefs"],
    ["/api/proposals/draft", "canCreateProposals"],
    ["/api/proposals/review", "canReviewProposals"],
  ] as const) {
    assert.ok(source.includes(`app.post("${route}", ...${guards}, aiLimiter,`), route);
    assert.equal(source.split(`app.post("${route}"`).length, 2, `${route} is registered once`);
  }
  for (const [guards, permission, planCheck] of [
    ["canAnalyzeBriefs", "proposal:create", "usage.analysisQuota"],
    ["canCreateProposals", "proposal:create", "subscriptions.requireEntitlement"],
    ["canReviewProposals", "proposal:review", "subscriptions.requireEntitlement"],
  ] as const) {
    const definition = `const ${guards} = [ auth.requireUser, auth.requirePermission("${permission}"), ${planCheck}, ];`;
    assert.ok(source.includes(definition), guards);
  }
});
