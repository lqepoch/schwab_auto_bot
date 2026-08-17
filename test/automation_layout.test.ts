import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";

test("repository root source keeps SDK boundary and executable only", async () => {
  const entries = await readdir(new URL("../src/", import.meta.url), { withFileTypes: true });
  const rootTypeScriptFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(rootTypeScriptFiles, ["index.ts", "main.ts", "public.ts"]);
});
