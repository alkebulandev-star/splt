/**
 * Uploading an offline receipt: the file the plugin saves when it cannot reach this website.
 * The file is read and checked in the browser, shown to the person, and only then sent.
 */
import type { ReceiptFile, ReceiptOptions } from '../core/api.ts';
import { sha256Hex } from '../core/hash.ts';
import { ctx, when } from './context.ts';
import { $, esc, toast } from './dom.ts';
import { go, onShow } from './router.ts';

interface Payload {
  title?: string; songCode?: string; ownerArtistId?: string; splitsConfirmed?: boolean;
  contributors?: { artistName?: string; role?: string; writerShare?: number; masterShare?: number; artistId?: string }[];
  takes?: unknown[]; bounces?: { stems?: unknown[] }[]; log?: { entries?: unknown[] };
}

let chosen: { receipt: ReceiptFile; payload: Payload } | null = null;

/** Reads a receipt file and checks it is whole. Throws with a plain reason if it is not. */
export async function readReceipt(text: string): Promise<{ receipt: ReceiptFile; payload: Payload }> {
  let receipt: ReceiptFile;
  try { receipt = JSON.parse(text) as ReceiptFile; } catch { throw new Error('That file is not an offline receipt. In the plugin: Evidence tab, "Save offline receipt".'); }
  if (receipt?.format !== 'split-tracker-receipt' || typeof receipt.payload !== 'string')
    throw new Error('That file is not an offline receipt. In the plugin: Evidence tab, "Save offline receipt".');
  if ((await sha256Hex(new TextEncoder().encode(receipt.payload))) !== receipt.payloadSha256)
    throw new Error('This receipt is damaged, or was changed after the plugin saved it. Ask for it to be saved and sent again.');
  return { receipt, payload: JSON.parse(receipt.payload) as Payload };
}

async function show(file: File): Promise<void> {
  const box = $('#rcPreview');
  try {
    chosen = await readReceipt(await file.text());
  } catch (err) { chosen = null; box.hidden = true; toast((err as Error).message); return; }
  const { receipt, payload } = chosen;
  const people = payload.contributors ?? [];
  const stems = (payload.bounces ?? []).reduce((t, b) => t + (b.stems?.length ?? 0), 0);
  const works = (await ctx.backend.works()).filter((w) => w.isOwner);
  const named = (payload.ownerArtistId ?? '').trim();

  $('#rcSummary').innerHTML = `
    <div><b>${esc(payload.title || 'Untitled')}</b> <span class="st ok">File is whole</span> ${payload.splitsConfirmed ? '<span class="st ok">Split locked in the plugin</span>' : '<span class="st idle">Split not locked</span>'}</div>
    <div style="color:var(--mute);font-size:13px;margin:4px 0 10px">Saved ${esc(when(receipt.madeAt))} on ${esc(receipt.computer || 'an unnamed computer')}${receipt.madeBy ? `, linked as ${esc(receipt.madeBy)}` : ', not linked to an account'}.
      ${(payload.takes ?? []).length} takes, ${(payload.bounces ?? []).length} bounces, ${stems} stems, ${Object.keys(receipt.fingerprints ?? {}).length} fingerprints, ${(payload.log?.entries ?? []).length} log entries. No audio.</div>
    ${people.length === 0 ? '<div style="color:var(--mute)">No split in this receipt.</div>' : `<div class="scroll"><table>
      <thead><tr><th>Artist name</th><th>Role</th><th>Artist ID</th><th class="num">Writer %</th><th class="num">Master %</th></tr></thead>
      <tbody>${people.map((p) => `<tr><td>${esc(p.artistName ?? '')}</td><td>${esc(p.role ?? '')}</td><td>${esc(p.artistId || 'not signed up')}</td><td class="num">${esc(p.writerShare ?? 0)}</td><td class="num">${esc(p.masterShare ?? 0)}</td></tr>`).join('')}</tbody>
    </table></div>`}`;

  $('#rcOwnerNamed').textContent = named
    ? `The receipt names the owner: ${named}. That account becomes the owner.`
    : 'The receipt does not name an owner. Nothing is assumed: tick the box if it is you, or set the owner later on the song\'s page.';
  $('#rcOwnerWrap').hidden = !!named;
  $<HTMLInputElement>('#rcIAmOwner').checked = false;
  $<HTMLInputElement>('#rcUseSplit').checked = false;
  $<HTMLSelectElement>('#rcWork').innerHTML = works.map((w) => `<option value="${esc(w.id)}">${esc(w.title)}${w.status === 'draft' ? '' : ` (${esc(w.status)})`}</option>`).join('');
  $<HTMLInputElement>('#rcModeAdd').disabled = works.length === 0;
  $('#rcNoSongs').hidden = works.length > 0;
  $<HTMLInputElement>('#rcModeNew').checked = true;
  sync();
  box.hidden = false;
}

function sync(): void {
  const add = $<HTMLInputElement>('#rcModeAdd').checked;
  $('#rcNewOpts').hidden = add;
  $('#rcAddOpts').hidden = !add;
  $('#rcGo').textContent = add ? 'Upload and add to this song' : 'Upload and register the song';
}

export function startReceipt(): void {
  onShow('dashboard', () => { $('#rcOffline').hidden = ctx.backend.mode !== 'preview'; });
  const input = $<HTMLInputElement>('#rcFile');
  input.addEventListener('change', () => { const f = input.files?.[0]; input.value = ''; if (f) void show(f); });
  $('#rcPick').addEventListener('click', () => input.click());
  const zone = $('#rcZone');
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('over'); const f = e.dataTransfer?.files?.[0]; if (f) void show(f); });
  $('#rcModeNew').addEventListener('change', sync);
  $('#rcModeAdd').addEventListener('change', sync);
  $('#rcCancel').addEventListener('click', () => { chosen = null; $('#rcPreview').hidden = true; });

  $('#rcGo').addEventListener('click', async () => {
    if (!chosen) return;
    const add = $<HTMLInputElement>('#rcModeAdd').checked;
    const options: ReceiptOptions = add
      ? { mode: 'add', workId: $<HTMLSelectElement>('#rcWork').value, useSplit: $<HTMLInputElement>('#rcUseSplit').checked }
      : { mode: 'new', iAmOwner: $<HTMLInputElement>('#rcIAmOwner').checked };
    const button = $<HTMLButtonElement>('#rcGo');
    button.disabled = true;
    try {
      const r = await ctx.backend.uploadReceipt(chosen.receipt, options);
      chosen = null;
      $('#rcPreview').hidden = true;
      toast(`${r.created ? 'Registered' : 'Added to'} "${r.title}". ${r.fingerprints} fingerprints stored${r.fingerprintsMissing ? `, ${r.fingerprintsMissing} were not in the file` : ''}.${r.logIntact ? '' : ' Warning: the plugin log in this receipt does not match its own chain.'}`);
      ctx.workId = r.workId;
      go('collaborate');
    } catch (err) { toast((err as Error).message); }
    button.disabled = false;
  });
}
