/** SHA-256 as lowercase hex, the way the plugin prints it on receipts. */
export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface FileHash { path: string; sha: string }

/**
 * Signature of a project that is a folder (for example a Logic .logicx package), as the
 * plugin computes it: hash every file except .DS_Store, then hash the sorted list of
 * "relative/path = hash" lines joined by newlines.
 */
export async function manifestHash(files: FileHash[]): Promise<string> {
  const kept = files.filter((f) => f.path.split('/').pop() !== '.DS_Store');
  if (kept.length === 0) throw new Error('That folder has no files in it');
  const lines = kept
    .map((f) => `${f.path.replace(/\\/g, '/')} = ${f.sha}`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256Hex(new TextEncoder().encode(lines.join('\n')));
}

export const looksLikeSha256 = (s: string): boolean => /^[0-9a-f]{64}$/i.test(s.trim());
