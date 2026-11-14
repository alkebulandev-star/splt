/**
 * Reads a .zip in the browser, so a project that is a folder can be checked without the browser
 * having to open the folder itself. On a Mac a Logic project (.logicx) looks like one file and
 * cannot be opened as a folder in a file dialog, but "Compress" in Finder turns it into a .zip
 * that any file dialog accepts.
 *
 * Supports what Finder, `ditto` and `zip` produce: stored and deflated entries, UTF-8 names.
 * Archives over 4 GB (the zip64 format) are refused with a clear message.
 */
export interface ZipEntry { path: string; data(): Promise<Uint8Array> }

export async function readZip(buffer: ArrayBuffer): Promise<ZipEntry[]> {
  const view = new DataView(buffer), bytes = new Uint8Array(buffer);

  // The table of contents sits at the end; its end record starts with PK\x05\x06.
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--)
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('That is not a zip file');
  const count = view.getUint16(end + 10, true), size = view.getUint32(end + 12, true);
  let at = view.getUint32(end + 16, true);
  if (count === 0xffff || size === 0xffffffff || at === 0xffffffff) throw new Error('This zip is over 4 GB, which is not supported yet');

  const utf8 = new TextDecoder('utf-8'), entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('This zip is damaged');
    const method = view.getUint16(at + 10, true);
    const packed = view.getUint32(at + 20, true), unpacked = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true), extraLen = view.getUint16(at + 30, true), commentLen = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const path = utf8.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;
    if (path.endsWith('/')) continue; // a folder, not a file
    if (packed === 0xffffffff || unpacked === 0xffffffff) throw new Error('This zip is over 4 GB, which is not supported yet');

    entries.push({
      path,
      async data() {
        // The file's own header repeats the name and may carry different extra fields.
        const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
        const raw = bytes.subarray(start, start + packed);
        if (method === 0) return raw;
        if (method !== 8) throw new Error(`"${path}" uses a compression this page cannot read`);
        const stream = new Blob([raw as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      },
    });
  }
  return entries;
}

/**
 * The files of the project inside a zip, with paths as the plugin records them: relative to the
 * project folder. Finder's Compress puts everything under "<project name>/" and adds a
 * "__MACOSX/" folder of its own, so both are removed.
 */
export function projectFilesInZip(entries: ZipEntry[]): ZipEntry[] {
  const real = entries.filter((e) => !e.path.startsWith('__MACOSX/') && !e.path.includes('/__MACOSX/'));
  const first = real[0]?.path.split('/')[0];
  const wrapped = real.length > 0 && real.every((e) => e.path.includes('/') && e.path.split('/')[0] === first);
  return wrapped ? real.map((e) => ({ path: e.path.slice(first!.length + 1), data: e.data })) : real;
}
