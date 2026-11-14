import { looksLikeSha256, manifestHash, sha256Hex, type FileHash } from '../core/hash.ts';
import type { Signature } from '../core/api.ts';
import { ctx, when } from './context.ts';
import { projectFilesInZip, readZip } from '../core/zip.ts';
import { $ } from './dom.ts';
import { onShow } from './router.ts';

let current = '';
let known: Signature[] = [];

/** Compares the chosen file with every signature the plugin uploaded, then with a pasted code if there is one. */
function compareNow(): void {
  const expected = $<HTMLInputElement>('#vfExpect').value.trim().toLowerCase();
  const box = $('#vfVerdict');
  box.className = 'verdict';
  if (!current) { box.textContent = 'Choose a file. It is checked against every signature your plugin has uploaded.'; return; }

  const hit = known.find((k) => k.sha === current);
  if (hit) {
    box.classList.add('yes');
    box.textContent = hit.kind === 'Project file'
      ? `Match. This is the project of "${hit.title}" exactly as it was saved when the plugin signed it on ${when(hit.time)}${hit.latest ? ', the latest signed version.' : '. Newer versions have been signed since.'}`
      : `Match. This is the sealed export of "${hit.title}", ${hit.label.toLowerCase()}, recorded on ${when(hit.time)}.`;
    return;
  }
  if (expected) {
    if (!looksLikeSha256(expected)) { box.textContent = 'That is not a full SHA-256 code. It should be 64 letters and digits.'; return; }
    const same = expected === current;
    box.classList.add(same ? 'yes' : 'no');
    box.textContent = same ? 'Match. This is exactly the file named on the receipt.' : 'No match. This file differs from the one on the receipt, even if only by one byte.';
    return;
  }
  if (known.length > 0) {
    box.classList.add('no');
    box.textContent = `No match. This file is not any of the ${known.length} project or export versions your plugin has signed. If it was changed and saved after the last bounce, that is expected.`;
  } else {
    box.textContent = 'Nothing from the plugin to compare with yet. Paste the code from a receipt, or sync the plugin first.';
  }
}

function status(text: string, error = false): void {
  const el = $('#vfStatus');
  el.textContent = text;
  el.classList.toggle('err', error);
}

/** A zipped project folder: unzip here and sign its files exactly as the plugin signs the folder. */
async function hashZip(file: File): Promise<void> {
  status(`Opening ${file.name}…`);
  try {
    const entries = projectFilesInZip(await readZip(await file.arrayBuffer()));
    const hashes: FileHash[] = [];
    for (let i = 0; i < entries.length; i++) {
      status(`Reading ${i + 1} of ${entries.length}…`);
      hashes.push({ path: entries[i].path, sha: await sha256Hex(await entries[i].data()) });
    }
    current = await manifestHash(hashes);
    $('#vfSha').textContent = `SHA-256 ${current}`;
    status(`${file.name.replace(/\.zip$/i, '')}, ${hashes.filter((h) => h.path.split('/').pop() !== '.DS_Store').length} files (from the zip)`);
  } catch (err) {
    current = ''; $('#vfSha').textContent = '';
    status((err as Error).message || `Could not read ${file.name}.`, true);
  }
  compareNow();
}

async function hashFile(file: File): Promise<void> {
  if (/\.zip$/i.test(file.name)) return hashZip(file);
  status(`Reading ${file.name}…`);
  try {
    current = await sha256Hex(await file.arrayBuffer());
    $('#vfSha').textContent = `SHA-256 ${current}`;
    status(`${file.name}, ${file.size.toLocaleString()} bytes`);
  } catch {
    current = ''; $('#vfSha').textContent = '';
    // A Mac project package looks like one file to the dialog but cannot be read as one.
    status(`Could not read ${file.name}. If it is a project folder such as a Logic .logicx, right-click it in Finder, choose Compress, and choose the .zip here.`, true);
  }
  compareNow();
}

/** A file with its path inside the chosen project folder, as the plugin records it. */
interface Entry { path: string; file: File }

async function hashFolder(root: string, entries: Entry[]): Promise<void> {
  if (entries.length === 0) { status(`${root} has no files in it.`, true); return; }
  const files = entries;
  try {
    const hashes: FileHash[] = [];
    for (let i = 0; i < files.length; i++) {
      status(`Reading ${i + 1} of ${files.length}…`);
      hashes.push({ path: files[i].path, sha: await sha256Hex(await files[i].file.arrayBuffer()) });
    }
    current = await manifestHash(hashes);
    $('#vfSha').textContent = `SHA-256 ${current}`;
    status(`${root}, ${files.length} files`);
  } catch {
    current = ''; $('#vfSha').textContent = '';
    status(`Could not read ${root}.`, true);
  }
  compareNow();
}

/** Every file under a dropped folder, with its path relative to that folder. */
async function readTree(dir: FileSystemDirectoryEntry, prefix: string): Promise<Entry[]> {
  const reader = dir.createReader();
  const children: FileSystemEntry[] = [];
  // readEntries hands back a batch at a time and an empty batch when it is done.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) break;
    children.push(...batch);
  }
  const out: Entry[] = [];
  for (const child of children) {
    const path = prefix + child.name;
    if (child.isDirectory) out.push(...(await readTree(child as FileSystemDirectoryEntry, `${path}/`)));
    else out.push({ path, file: await new Promise<File>((resolve, reject) => (child as FileSystemFileEntry).file(resolve, reject)) });
  }
  return out;
}

export function startVerify(): void {
  onShow('verify', async () => { known = await ctx.backend.signatures().catch(() => []); compareNow(); });
  const file = $<HTMLInputElement>('#vfFile'), folder = $<HTMLInputElement>('#vfFolder');
  file.addEventListener('change', () => { if (file.files?.[0]) void hashFile(file.files[0]); });
  folder.addEventListener('change', () => {
    const picked = Array.from(folder.files ?? []);
    if (picked.length === 0) return;
    // The browser gives "Folder/sub/file"; the plugin's paths start inside the folder.
    void hashFolder(picked[0].webkitRelativePath.split('/')[0], picked.map((f) => ({ path: f.webkitRelativePath.split('/').slice(1).join('/'), file: f })));
  });

  // Copy a file in Finder and paste it here (Cmd+V). A copied folder or project package arrives
  // as a folder where the browser allows it; otherwise the message says to zip it.
  document.addEventListener('paste', async (e) => {
    if ($('[data-view="verify"]').hidden) return;
    const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.kind === 'file');
    if (!item) return;
    e.preventDefault();
    const entry = item.webkitGetAsEntry?.();
    if (entry?.isDirectory) { status(`Listing ${entry.name}…`); void hashFolder(entry.name, await readTree(entry as FileSystemDirectoryEntry, '')); return; }
    const f = item.getAsFile();
    if (f) void hashFile(f);
  });

  // Dropping works for everything, including Mac project packages (.logicx) that a file dialog
  // shows as a single file and will not let you open as a folder.
  const zone = $('[data-view="verify"]');
  zone.addEventListener('dragover', (e) => e.preventDefault());
  zone.addEventListener('drop', async (e) => {
    e.preventDefault();
    const item = e.dataTransfer?.items?.[0];
    const entry = item?.webkitGetAsEntry?.();
    if (!entry) return;
    if (entry.isFile) { const f = e.dataTransfer?.files?.[0]; if (f) void hashFile(f); return; }
    status(`Listing ${entry.name}…`);
    void hashFolder(entry.name, await readTree(entry as FileSystemDirectoryEntry, ''));
  });
  $('#vfExpect').addEventListener('input', compareNow);
}
