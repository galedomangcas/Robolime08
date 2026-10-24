import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, openSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * Publishes a file under a new name without ever overwriting an existing
 * file and without leaving a partial file under that name (D32).
 *
 * 1. Write the whole content to a uniquely named temporary file in the SAME
 *    folder (exclusive create), flush it to disk (fsync) and close it.
 * 2. Publish it with a hard link to the final name. Creating a link is atomic
 *    and fails with EEXIST if the name exists, so the destination is either
 *    absent or complete, and another process's file is never replaced (no
 *    check-then-write race).
 * 3. Remove the temporary name, on success and on failure.
 *
 * There is deliberately NO fallback to a direct write: if the link cannot be
 * created for any reason (permissions, a file system without hard links such
 * as FAT32/exFAT, disk full, I/O error), the export fails, the temporary file
 * is removed and nothing is published. Link error codes are not specific
 * enough to tell "hard links unsupported" apart from other failures, and the
 * target folders (NTFS on the laptop, ext4 on a Raspberry Pi) support hard
 * links.
 */
export interface FileOps {
  /** Creates `path` exclusively, writes all of `data`, flushes it to disk and closes it. */
  writeNewFile(path: string, data: string): void;
  link(existingPath: string, newPath: string): void;
  unlink(path: string): void;
}

export const nodeFileOps: FileOps = {
  writeNewFile(path, data) {
    const fd = openSync(path, 'wx');
    try {
      const bytes = Buffer.from(data, 'utf8');
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  },
  link: linkSync,
  unlink: unlinkSync,
};

export interface PublishResult {
  /** Set when the temporary file could not be removed after a successful publish. */
  leftoverTempFile: string | null;
}

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;

/** Tries to remove the temporary file we created; reports, rather than throws, a failure. */
function tryUnlink(ops: FileOps, path: string): boolean {
  try {
    ops.unlink(path);
    return true;
  } catch (error) {
    return errorCode(error) === 'ENOENT';
  }
}

/** Appends text to the original error's message, keeping the error (and its code). */
function annotate(error: unknown, note: string): unknown {
  if (error instanceof Error) error.message += note;
  return error;
}

export function publishNewFile(finalPath: string, data: string, ops: FileOps = nodeFileOps): PublishResult {
  const tempPath = join(dirname(finalPath), `.${basename(finalPath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const leftover = ` (the temporary file ${tempPath} could not be removed)`;
  try {
    ops.writeNewFile(tempPath, data);
  } catch (error) {
    // EEXIST: a file with this temporary name is not ours — leave it. Otherwise the
    // temporary file may exist partly written; the final name was never touched.
    if (errorCode(error) !== 'EEXIST' && !tryUnlink(ops, tempPath)) throw annotate(error, leftover);
    throw error;
  }

  try {
    ops.link(tempPath, finalPath);
  } catch (error) {
    const removed = tryUnlink(ops, tempPath);
    if (errorCode(error) !== 'EEXIST') {
      annotate(error, ' — nothing was written; the output folder must allow creating hard links (e.g. NTFS or ext4)');
    }
    throw removed ? error : annotate(error, leftover);
  }

  return { leftoverTempFile: tryUnlink(ops, tempPath) ? null : tempPath };
}
