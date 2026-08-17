import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type AtomicJsonWriteOptions = {
  directoryMode?: number;
  fileMode?: number;
  pretty?: boolean;
};

/** Write JSON through a same-directory temporary file and atomic rename. */
export async function atomicWriteJson(
  path: string,
  value: unknown,
  options: AtomicJsonWriteOptions = {},
): Promise<void> {
  await mkdir(dirname(path), {
    recursive: true,
    ...(options.directoryMode === undefined ? {} : { mode: options.directoryMode }),
  });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const serialized = JSON.stringify(value, null, options.pretty ? 2 : undefined);
    await writeFile(temporary, serialized, {
      encoding: "utf8",
      ...(options.fileMode === undefined ? {} : { mode: options.fileMode }),
    });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
