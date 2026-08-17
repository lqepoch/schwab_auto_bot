import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { atomicWriteJson } from "../src/utils/atomicJson.ts";

test("atomicWriteJson replaces the target without leaving temporary files", async () => {
  const root = await mkdtemp(join(tmpdir(), "atomic-json-"));
  try {
    const target = join(root, "state", "runtime.json");
    await atomicWriteJson(target, { version: 1, state: "running" }, { pretty: true });
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { version: 1, state: "running" });
    assert.equal((await readdir(join(root, "state"))).some((name) => name.endsWith(".tmp")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("atomicWriteJson removes its temporary file when the final rename fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "atomic-json-failure-"));
  try {
    const target = join(root, "collision");
    await mkdir(target);
    await assert.rejects(atomicWriteJson(target, { version: 1 }));
    const names = await readdir(root);
    assert.equal(names.some((name) => name.startsWith("collision.") && name.endsWith(".tmp")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
