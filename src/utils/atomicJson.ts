import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export type AtomicJsonWriteOptions = {
  directoryMode?: number;
  fileMode?: number;
  pretty?: boolean;
};

/**
 * Persist JSON through a same-directory temporary file and atomic rename.
 *
 * The temporary file is fsynced before rename and, on POSIX, the containing
 * directory is fsynced afterwards so an acknowledged write survives a crash
 * at the rename boundary. directoryMode applies when the target directory is
 * created; an existing caller-owned parent directory is never chmodded.
 */
export async function atomicWriteJson(
  path: string,
  value: unknown,
  options: AtomicJsonWriteOptions = {},
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, {
    recursive: true,
    ...(options.directoryMode === undefined ? {} : { mode: options.directoryMode }),
  });

  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const serialized = JSON.stringify(value, null, options.pretty ? 2 : undefined);
    if (serialized === undefined) throw new TypeError("ATOMIC_JSON_SERIALIZATION_UNDEFINED");

    const temporaryFile = await open(temporary, "w", options.fileMode ?? 0o666);
    try {
      await temporaryFile.writeFile(serialized, "utf8");
      await temporaryFile.sync();
    } finally {
      await temporaryFile.close();
    }

    await rename(temporary, path);

    // Windows does not provide portable directory fsync semantics through
    // fs.open(). POSIX filesystems do, and persistence-sensitive runtime state
    // uses this path on Linux production hosts.
    if (process.platform !== "win32") {
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
