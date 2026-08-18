import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
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

    await atomicWriteJson(target, { version: 1, state: "stopped" });
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { version: 1, state: "stopped" });
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

test("atomicWriteJson rejects non-serializable top-level undefined without a temp artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "atomic-json-undefined-"));
  try {
    const target = join(root, "state", "runtime.json");
    await assert.rejects(
      atomicWriteJson(target, undefined),
      /ATOMIC_JSON_SERIALIZATION_UNDEFINED/,
    );
    assert.deepEqual(await readdir(join(root, "state")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("atomicWriteJson applies explicit owner-only modes to a newly created state directory", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "atomic-json-mode-"));
  try {
    const directory = join(root, "nested", "state");
    const target = join(directory, "auth.json");

    await atomicWriteJson(target, { token: "redacted" }, {
      directoryMode: 0o700,
      fileMode: 0o600,
    });

    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(target)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("atomicWriteJson never chmods an existing caller-owned parent directory", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "atomic-json-existing-mode-"));
  try {
    const directory = join(root, "shared");
    const target = join(directory, "auth.json");
    await mkdir(directory, { mode: 0o755 });
    await chmod(directory, 0o755);

    await atomicWriteJson(target, { token: "redacted" }, {
      directoryMode: 0o700,
      fileMode: 0o600,
    });

    assert.equal((await stat(directory)).mode & 0o777, 0o755);
    assert.equal((await stat(target)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
