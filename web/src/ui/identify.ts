import { compare, fingerprintResampled, isMatch, isStrong, parseFingerprintFile, toTargetRate, type Match } from '../core/fingerprint.ts';
import { sha256Hex } from '../core/hash.ts';
import { describeFingerprintFile, formatLength, type LibraryItem } from '../core/library.ts';
import { compareMelody, isMelodyMatch, isMelodyStrong, MELODY_UNTESTED, melodyProfile, type MelodyMatch } from '../core/melody.ts';
import { ctx, when } from './context.ts';
import { $, breathe, dropZone, esc } from './dom.ts';
import { onShow } from './router.ts';
import { clearLibrary, loadLibrary, removeItem, saveItem } from './store.ts';

let library: LibraryItem[] = [];

/** Decodes any audio the browser can play and returns it mono at 11025 Hz. */
async function decode(file: File): Promise<Float32Array> {
  const Ctx = window.OfflineAudioContext ?? (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  const audio = await new Ctx(1, 1, 44100).decodeAudioData(await file.arrayBuffer());
  const channels: Float32Array[] = [];
  for (let c = 0; c < audio.numberOfChannels; c++) channels.push(audio.getChannelData(c));
  return toTargetRate(channels, audio.sampleRate);
}

const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function status(sel: string, text: string, error = false): void {
  const el = $(sel);
  el.textContent = text;
  el.classList.toggle('err', error);
}

function drawLibrary(): void {
  $('#libTable tbody').innerHTML = library.length === 0
    ? '<tr><td colspan="5" style="color:var(--mute)">Nothing here yet. Add the fingerprint files from a bounce, or your own audio.</td></tr>'
    : library.map((it) => `
      <tr>
        <td><button type="button" class="rowlink" data-detail="${esc(it.id)}">${esc(it.name)}</button></td>
        <td><span class="st ${it.kind === 'Audio' ? 'idle' : 'ok'}">${it.kind}</span></td>
        <td class="num">${formatLength(it.seconds)}</td>
        <td>${it.fromSong ? 'Plugin sync' : it.melody ? 'Audio, with melody' : 'Fingerprint file'}</td>
        <td>${it.fromSong ? '' : `<button type="button" class="x" data-remove="${esc(it.id)}">Remove</button>`}</td>
      </tr>`).join('');
}

async function addToLibrary(files: File[]): Promise<void> {
  let added = 0;
  const failed: string[] = [];
  for (const file of files) {
    status('#libStatus', `Reading ${file.name}…`);
    await breathe();
    try {
      let item: LibraryItem;
      if (/\.fingerprint$/i.test(file.name)) {
        const fp = parseFingerprintFile(await file.arrayBuffer());
        if (!fp) throw new Error('not a Split Tracker fingerprint');
        const d = describeFingerprintFile(file.name);
        item = { id: newId(), name: d.name, kind: d.kind, seconds: fp.frames.length * fp.secondsPerFrame, frames: fp.frames, secondsPerFrame: fp.secondsPerFrame };
      } else {
        const x = await decode(file);
        const fp = fingerprintResampled(x);
        item = { id: newId(), name: file.name, kind: 'Audio', seconds: x.length / 11025, frames: fp.frames, secondsPerFrame: fp.secondsPerFrame, melody: melodyProfile(x) };
      }
      library.push(item);
      await saveItem(item);
      added++;
      drawLibrary();
    } catch {
      failed.push(file.name);
    }
  }
  status('#libStatus', failed.length ? `Added ${added}. Could not read: ${failed.join(', ')}` : `Added ${added} ${added === 1 ? 'item' : 'items'}.`, failed.length > 0);
}

/** `melody` is the verdict after ranking: only the best candidate may be called a possible match. */
interface Row { item: LibraryItem; rec: Match; mel: MelodyMatch | null; rank: number; melody: 'strong' | 'possible' | 'none' }

function verdict(r: Row): string {
  if (isStrong(r.rec)) return '<span class="st ok">Same recording</span>';
  if (isMatch(r.rec)) return '<span class="st wait">Shares material</span>';
  if (r.melody === 'strong') return '<span class="st mel">Same melody</span>';
  if (r.melody === 'possible') return '<span class="st mel soft">Possibly the same melody</span>';
  return '<span class="st idle">No match</span>';
}

/**
 * How much a result can carry. Only an exact-recording match is evidence on its own; everything
 * else is a lead that someone has to listen to and follow up.
 */
function weight(r: Row): string {
  if (isStrong(r.rec)) return '<span class="wt ev" title="The recording itself matches">Evidence</span>';
  if (r.melody === 'strong') return '<span class="wt sl" title="Notes match on real-song tests with no false matches, but it is not the same recording">Strong lead</span>';
  if (isMatch(r.rec) || r.melody === 'possible') return '<span class="wt ld" title="Worth listening to. Not proof.">Lead</span>';
  return '';
}

function melodyCell(r: Row): string {
  if (!r.mel) return '<span style="color:var(--mute)">n/a</span>';
  const pct = `${Math.round(r.mel.similarity * 100)}%`;
  if (r.melody === 'none') return pct;
  const up = r.mel.shift <= 6 ? r.mel.shift : r.mel.shift - 12;
  return up === 0 ? `${pct}, same key` : `${pct}, ${Math.abs(up)} semitone${Math.abs(up) === 1 ? '' : 's'} ${up > 0 ? 'higher' : 'lower'}`;
}

async function identify(file: File): Promise<void> {
  const table = $('#idTable');
  table.hidden = true;
  $('#idSha').textContent = '';
  if (library.length === 0) { status('#idStatus', 'Add something to your library first.', true); return; }

  try {
    status('#idStatus', `Reading ${file.name}…`);
    await breathe();
    const x = await decode(file);
    const fp = fingerprintResampled(x);
    const mel = melodyProfile(x);
    $('#idSha').textContent = `SHA-256 ${await sha256Hex(await file.arrayBuffer())}`;

    const rows: Row[] = [];
    for (const item of library) {
      status('#idStatus', `Comparing with ${item.name}…`);
      await breathe();
      // The shorter of the two is searched for inside the longer one.
      const rec = item.frames.length >= fp.frames.length
        ? compare(item.frames, fp.frames, item.secondsPerFrame)
        : compare(fp.frames, item.frames, fp.secondsPerFrame);
      const m = item.melody ? compareMelody(item.melody, mel) : null;
      const melody = m && isMelodyStrong(m) ? 'strong' : m && isMelodyMatch(m) ? 'possible' : 'none';
      const rank = isStrong(rec) ? 4 + rec.similarity : isMatch(rec) ? 3 + rec.similarity : melody === 'strong' ? 2 + m!.similarity : melody === 'possible' ? 1 + m!.similarity : rec.similarity * rec.coverage;
      rows.push({ item, rec, mel: m, rank, melody });
    }
    // A "possible" melody match is weak evidence, so only the single best one is shown as such.
    const possible = rows.filter((r) => r.melody === 'possible').sort((a, b) => b.mel!.similarity - a.mel!.similarity);
    for (const r of possible.slice(1)) { r.melody = 'none'; r.rank = r.rec.similarity * r.rec.coverage; }
    rows.sort((a, b) => b.rank - a.rank);

    $('#idTable tbody').innerHTML = rows.map((r) => `
      <tr>
        <td><button type="button" class="rowlink" data-detail="${esc(r.item.id)}">${esc(r.item.name)}</button> <span style="color:var(--mute)">· ${r.item.kind}</span></td>
        <td>${verdict(r)}</td>
        <td>${weight(r)}</td>
        <td class="num">${r.rec.coverage > 0 ? `${Math.round(r.rec.similarity * 100)}%` : '—'}</td>
        <td class="num">${isMatch(r.rec) ? formatLength(Math.abs(r.rec.offsetSeconds)) : '—'}</td>
        <td class="num">${melodyCell(r)}</td>
      </tr>`).join('');
    table.hidden = false;

    const best = rows[0];
    status('#idStatus', best.rank >= 1
      ? `${file.name}: best match is ${best.item.name}.`
      : `${file.name}: no match in your library.`);
  } catch {
    status('#idStatus', `Could not read ${file.name} as audio.`, true);
  }
}

const cell = (label: string, value: string) => `<div><small>${label}</small><b>${value}</b></div>`;

/** Opens everything known about one master or stem, with the log lines that concern only it. */
async function showDetails(id: string): Promise<void> {
  const item = library.find((it) => it.id === id);
  if (!item) return;
  const card = $('#fpDetail');
  card.hidden = false;
  $('#fdTitle').textContent = item.name;
  $('#fdKind').innerHTML = `<span class="st ${item.kind === 'Audio' ? 'idle' : 'ok'}">${item.kind}</span>`;
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  if (!item.ref) {
    $('#fdBody').innerHTML = `<div class="evgrid">${cell('Length', formatLength(item.seconds))}${cell('Source', item.melody ? 'Audio file you added' : 'Fingerprint file you added')}${cell('Melody profile', item.melody ? 'Yes' : 'No')}${cell('Fingerprint frames', item.frames.length.toLocaleString())}</div>
      <div class="pad" style="color:var(--mute);font-size:14px">This was added by hand, so there is no session log for it. Masters and stems synced from the plugin show their takes and log here.</div>`;
    return;
  }
  $('#fdBody').innerHTML = '<div class="pad" style="color:var(--mute)">Loading…</div>';
  try {
    const d = await ctx.backend.fingerprintDetails(item.ref);
    const who = d.track ? esc(d.track.person || 'No one set') : `${d.stems.length} ${d.stems.length === 1 ? 'stem' : 'stems'}`;
    $('#fdBody').innerHTML = `
      <div class="evgrid">
        ${cell('Song', esc(d.title) + (d.album ? ` <span style="font-weight:400;color:var(--mute)">· ${esc(d.album)}</span>` : ''))}
        ${cell(d.track ? 'Artist' : 'Sealed with', who)}
        ${cell('Bounce', `${d.bounce.num}, ${esc(when(d.bounce.time))}`)}
        ${cell('Length', formatLength(d.seconds))}
      </div>
      ${d.track ? `<div class="evgrid">${cell('Track', esc(d.track.trackName))}${cell('Takes', String(d.track.takes))}${cell('Recorded', formatLength(d.track.recordSeconds))}${cell('Played', formatLength(d.track.signalSeconds))}</div>` : ''}
      <div class="pad mono" style="border-bottom:1px solid var(--rule)">Fingerprint ${esc(d.fpId)}${d.bounce.fileSha ? `<br>Sealed export ${esc(d.bounce.fileSha)}` : ''}</div>
      ${d.stems.length ? `<div class="scroll"><table><thead><tr><th>Stem in this bounce</th><th>Artist</th></tr></thead><tbody>${d.stems.map((st) => `<tr><td>${esc(st.trackName)}</td><td>${esc(st.person || 'No one set')}</td></tr>`).join('')}</tbody></table></div>` : ''}
      ${d.takes.length ? `<div class="scroll"><table><thead><tr><th>Take</th><th>Artist</th><th>When</th><th class="num">Length</th><th class="num">Starts at</th></tr></thead><tbody>${d.takes.map((t) => `<tr><td>${t.num}</td><td>${esc(t.person || 'No one set')}</td><td>${esc(when(t.time))}</td><td class="num">${formatLength(t.durationSecs)}</td><td class="num">${formatLength(t.songPos)}</td></tr>`).join('')}</tbody></table></div>` : ''}
      <div class="pad">
        <b style="font-size:14px">${d.track ? `Log for this track only (${d.log.length})` : `Song log, without per-track lines (${d.log.length})`}</b>
        <div class="loglist" style="margin-top:10px">${d.log.length === 0 ? '<span style="color:var(--mute)">No log lines yet.</span>' : [...d.log].reverse().map((l) => `<div><span class="ty">${esc(l.type)}</span>${esc(l.text)}<time>${esc(when(l.time))}</time></div>`).join('')}</div>
      </div>`;
  } catch (err) {
    $('#fdBody').innerHTML = `<div class="pad status err">${esc((err as Error).message)}</div>`;
  }
}

export async function startIdentify(): Promise<void> {
  $('#melodyUntested').textContent = MELODY_UNTESTED;
  for (const table of ['#libTable', '#idTable']) $(table).addEventListener('click', (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>('[data-detail]')?.dataset.detail;
    if (id) void showDetails(id);
  });
  $('#fdClose').addEventListener('click', () => { $('#fpDetail').hidden = true; });
  dropZone($('#libDrop'), $<HTMLInputElement>('#libFiles'), (files) => void addToLibrary(files));
  dropZone($('#idDrop'), $<HTMLInputElement>('#idFile'), (files) => { if (files[0]) void identify(files[0]); });
  $('#libTable').addEventListener('click', (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>('[data-remove]')?.dataset.remove;
    if (!id) return;
    library = library.filter((it) => it.id !== id);
    void removeItem(id);
    drawLibrary();
  });
  $('#libClear').addEventListener('click', () => {
    library = library.filter((it) => it.fromSong);
    void clearLibrary();
    drawLibrary();
    status('#libStatus', 'Removed the files you added. Fingerprints synced from the plugin stay.');
  });
  onShow('identify', loadSynced);
  drawLibrary();
  library = [...library, ...(await loadLibrary())];
  drawLibrary();
}

const loaded = new Set<string>();

/** Adds the masters and stems the plugin uploaded for your songs, so there is nothing to drag in. */
async function loadSynced(): Promise<void> {
  try {
    for (const f of await ctx.backend.fingerprints()) {
      const key = `${f.workId}/${f.fpId}/${f.bounce}/${f.name}`;
      if (loaded.has(key)) continue;
      const fp = parseFingerprintFile(await ctx.backend.fingerprintData(f));
      if (!fp) continue;
      loaded.add(key);
      library.push({
        id: key, kind: f.kind, fromSong: f.title, ref: { workId: f.workId, fpId: f.fpId, track: f.track }, frames: fp.frames, secondsPerFrame: fp.secondsPerFrame, seconds: f.seconds,
        name: f.kind === 'Master' ? `${f.title}, bounce ${f.bounce}` : `${f.name} · ${f.title}, bounce ${f.bounce}`,
      });
    }
    drawLibrary();
  } catch { /* the library still works with files added by hand */ }
}
