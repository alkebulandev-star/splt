import type { Evidence, PersonInput, WorkDetail } from '../core/api.ts';
import { formatLength } from '../core/library.ts';
import { ROLES } from '../core/roles.ts';
import { sendProblem, total, type Person, type PersonStatus } from '../core/splits.ts';
import { COLOURS, ctx, initials, STATUS_TAG, when } from './context.ts';
import { byAlbum } from './dashboard.ts';
import { $, esc, toast } from './dom.ts';
import { go, onShow } from './router.ts';

const PERSON_TAG: Record<PersonStatus, [string, string]> = {
  approved: ['ok', 'Approved'], pending: ['wait', 'Pending'], declined: ['bad', 'Declined'], draft: ['idle', 'Not sent'], credit: ['idle', 'Credit only'],
};

let work: WorkDetail | null = null;
let rows: Person[] = [];
let dirty = false;

const canEdit = (): boolean => !!work && work.isOwner && work.status !== 'signed';
// Everything a row carries goes back with it (registration details, deal notes), so a website edit keeps them.
const inputs = (): PersonInput[] => rows.map(({ status: _s, hasAccount: _h, ...r }) => r);

function drawRows(): void {
  const off = canEdit() ? '' : ' disabled';
  $('#sheet tbody').innerHTML = rows.map((p, i) => `
    <tr>
      <td><span class="name"><span class="av" style="background:var(${COLOURS[i % COLOURS.length]})">${esc(initials(p.artistName))}</span>
        <input id="sa${i}" data-i="${i}" data-k="artistName" value="${esc(p.artistName)}" aria-label="Artist name" maxlength="80"${off}></span></td>
      <td><input id="sl${i}" data-i="${i}" data-k="legalName" value="${esc(p.legalName)}" placeholder="Add legal name" aria-label="Legal name" maxlength="120"${off}></td>
      <td><input id="se${i}" data-i="${i}" data-k="email" type="email" value="${esc(p.email)}" placeholder="Their email" aria-label="Email" maxlength="254"${off}></td>
      <td><select id="sr${i}" data-i="${i}" data-k="role" aria-label="Role"${off}>${[...new Set([...ROLES, p.role])].map((r) => `<option${r === p.role ? ' selected' : ''}>${esc(r)}</option>`).join('')}</select></td>
      <td class="num"><input id="sw${i}" class="share" data-i="${i}" data-k="writerShare" inputmode="decimal" value="${p.writerShare}" aria-label="Writer share percent"${off}></td>
      <td class="num"><input id="sm${i}" class="share" data-i="${i}" data-k="masterShare" inputmode="decimal" value="${p.masterShare}" aria-label="Master share percent"${off}></td>
      <td><span class="st ${PERSON_TAG[p.status][0]}">${PERSON_TAG[p.status][1]}</span>${p.hasAccount === false && (p.writerShare > 0 || p.masterShare > 0) ? ' <span class="st bad" title="They need to sign up with this email before the sheet can be sent">Not signed up</span>' : ''}</td>
      <td>${canEdit() && rows.length > 1 ? `<button type="button" class="x" data-drop="${i}">Remove</button>` : ''}</td>
    </tr>`).join('');
}

function drawActions(): void {
  if (!work) return;
  $('#sumW').textContent = String(total(rows, 'writerShare'));
  $('#sumM').textContent = String(total(rows, 'masterShare'));
  const problem = canEdit() ? sendProblem(rows) : '';
  $('#why').textContent = problem;

  const box = $('#sheetActions');
  const hint = (t: string) => `<span class="hint">${t}</span>`;
  if (work.status === 'signed') {
    box.innerHTML = hint('Signed by everyone with a share. This sheet can no longer be changed.');
  } else if (work.isOwner && work.status === 'draft') {
    box.innerHTML = `<button class="btn line" type="button" data-act="save"${dirty ? '' : ' disabled'}>Save</button>
      <button class="btn dark" type="button" data-act="send"${problem ? ' disabled' : ''}>Send for approval</button>
      ${hint('Everyone with a share gets it on their Overview when they sign in with the email you entered.')}`;
  } else if (work.isOwner) {
    box.innerHTML = (dirty ? '<button class="btn line" type="button" data-act="save">Save changes</button>' : '') +
      hint(`Sent. Waiting for ${work.awaiting} ${work.awaiting === 1 ? 'person' : 'people'}. Changing anything withdraws the approvals given so far.`);
  } else if (work.status === 'sent' && work.yourDecision === 'none') {
    box.innerHTML = `<button class="btn ok" type="button" data-act="approved">Approve my share</button>
      <button class="btn no" type="button" data-act="declined">Decline</button>${hint('Check your legal name and both shares first.')}`;
  } else if (work.status === 'sent') {
    box.innerHTML = hint(work.yourDecision === 'approved' ? 'You approved this split. Waiting for the others.' : work.yourDecision === 'declined' ? 'You declined this split. Message the owner to agree a change.' : 'Waiting for the people with a share to approve.');
  } else {
    box.innerHTML = hint('The owner is still working on this split.');
  }
}

function draw(): void {
  if (!work) return;
  $('#workTitle').textContent = work.title;
  const [cls, label] = STATUS_TAG[work.status];
  $('#sheetState').innerHTML = `<span class="st ${cls}">${label}</span>`;
  $('#addRow').hidden = !canEdit();
  drawRows();
  drawActions();

  $<HTMLInputElement>('#ffTitle').value = work.title;
  $<HTMLInputElement>('#ffAlbum').value = work.album;
  $<HTMLInputElement>('#ffIsrc').value = work.isrc;
  $<HTMLInputElement>('#ffIswc').value = work.iswc;
  for (const id of ['#ffTitle', '#ffAlbum', '#ffIsrc', '#ffIswc', '#ffSave']) $<HTMLInputElement>(id).disabled = !work.isOwner;

  // Owner and song code
  $('#ownerName').textContent = `${work.ownerName} · ${work.ownerArtistId}${work.youOwn ? ' (you)' : ''}`;
  $('#songCode').textContent = work.songCode;
  $('#ownerTag').innerHTML = work.ownerStated ? '<span class="st ok">Owner stated</span>' : '<span class="st wait">Owner not stated yet</span>';
  $('#ownerHelp').textContent = work.ownerStated
    ? 'A collaborator working in their own separate project joins this song by typing the song code and the owner\'s Artist ID into Song details in their plugin. They must already be on the split sheet.'
    : 'Nobody else can join this song until its owner is stated. Say who owns it here, or in Song details in the plugin.';
  $('#ownerForm').hidden = !(work.youOwn || (work.isOwner && !work.ownerStated)) || work.status === 'signed';
  $('#ownerMe').hidden = work.ownerStated && work.youOwn;

  // Registration details, from the plugin and from each person's profile
  const hrs = (sec: number) => (sec > 0 ? `${Math.floor(sec / 3600)}h ${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}m` : '—');
  $('#regTable tbody').innerHTML = work.rows.map((p) => `<tr><td>${esc(p.artistName)}</td><td class="mono">${esc(p.artistId || '—')}</td><td>${esc(p.pro || '—')}</td><td>${esc(p.ipi || '—')}</td>
    <td>${esc(p.publisher || '—')}</td><td>${esc(p.publisherIpi || '—')}</td><td>${esc(p.terms || '—')}</td><td class="num">${hrs(p.seconds ?? 0)}</td></tr>`).join('');

  $('#deleteForm').hidden = !work.youOwn || work.status === 'signed';
  $<HTMLInputElement>('#deleteTitle').value = '';

  $('#chain').innerHTML = ctx.backend.mode === 'preview' ? '' : work.chainIntact
    ? '<span class="st ok">History intact</span>' : '<span class="st bad">History has been altered</span>';
  drawEvidence(work.evidence, work.sources);
  $('#history').innerHTML = [...work.events].reverse().map((e) => `<div><span class="ty">${esc(e.type)}</span>${esc(e.text)}<time>${esc(when(e.time))}</time></div>`).join('');
}

const hours = (s: number): string => `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;

function drawEvidence(ev: Evidence | null, sources: WorkDetail['sources'] = []): void {
  if (!ev) {
    $('#evState').innerHTML = '<span class="st idle">Not synced</span>';
    $('#evBody').innerHTML = `<div class="pad" style="color:var(--mute);font-size:14px">Nothing from the plugin yet. Create a plugin key on your Profile page, paste it into Split Tracker's Evidence tab and press Sync. Takes, stems and bounces for this song will appear here.</div>`;
    return;
  }
  $('#evState').innerHTML = ev.logIntact ? '<span class="st ok">Plugin log intact</span>' : '<span class="st bad">Plugin log has been altered</span>';
  const stems = ev.bounces.flatMap((b) => b.stems.map((s) => ({ ...s, bounce: b.num })));
  const stemOf = (track: string) => stems.filter((s) => s.trackName === track).pop();
  $('#evBody').innerHTML = `
    <div class="evgrid">
      <div><small>Session time</small><b>${hours(ev.sessionSeconds)}</b></div>
      <div><small>Bounces</small><b>${ev.bounces.length}</b></div>
      <div><small>Splits in the plugin</small><b>${ev.splitsLocked ? 'Locked' : 'Not locked'}</b></div>
      <div><small>Last synced</small><b>${esc(when(ev.syncedAt))}</b></div>
    </div>
    ${sources.length > 1 || sources.some((x) => x.receiptUploadedBy) ? `<div class="pad" style="border-bottom:1px solid var(--rule);font-size:14px"><b>${sources.length === 1 ? 'One project feeds this song, from an offline receipt.' : `${sources.length} separate projects feed this song.`}</b> Each keeps its own record; none replaces another.<div class="feed" style="margin-top:8px">${sources.map((x) => `<div>${x.receiptUploadedBy ? `Offline receipt from ${esc(x.artistName)}, uploaded by ${esc(x.receiptUploadedBy)}` : `${esc(x.artistName)}'s project${x.isOwner ? ' (owner)' : ''}`}: ${x.tracks} tracks, ${x.takes} takes, ${x.bounces} bounces, log ${x.logIntact ? 'intact' : 'ALTERED'}<time>${x.receiptUploadedBy ? 'uploaded' : 'synced'} ${esc(when(x.syncedAt))}</time></div>`).join('')}</div></div>` : ''}
    ${ev.tracks.some((t) => !t.person) ? `<div class="pad" style="border-bottom:1px solid var(--rule);font-size:14px;color:var(--wait)"><b>${ev.tracks.filter((t) => !t.person).length} of ${ev.tracks.length} tracks have no artist set.</b> In the DAW, open Split Tag on each of those tracks and choose who performed it, then bounce again. Stems and takes are only credited to an artist when the track is tagged.</div>` : ''}
    <div class="scroll"><table>
      <thead><tr><th>Track</th><th>Artist</th><th>From</th><th class="num">Takes</th><th class="num">Recorded</th><th>Stem fingerprint</th></tr></thead>
      <tbody>${ev.tracks.length === 0 ? '<tr><td colspan="6" style="color:var(--mute)">No tagged tracks yet. Put Split Tag on every track and choose who performed it, so stems and takes are credited to the right artist.</td></tr>' : ev.tracks.map((t) => {
        const st = stemOf(t.trackName);
        return `<tr><td>${esc(t.trackName)}</td><td>${esc(t.person || 'No one set')}</td><td>${esc(t.source ? (t.source.endsWith('receipt') ? t.source : `${t.source}'s project`) : 'This project')}</td><td class="num">${t.takes}</td><td class="num">${formatLength(t.recordSeconds)}</td>
          <td class="mono">${st ? `${esc(st.fpId.slice(0, 16))}… · bounce ${st.bounce}` : '—'}</td></tr>`;
      }).join('')}</tbody>
    </table></div>
    <div class="pad mono" style="border-top:1px solid var(--rule)">
      ${ev.project ? `Project file ${esc(ev.project.fileName)}${ev.project.daw ? ` (${esc(ev.project.daw)})` : ''}, signed ${esc(when(ev.project.time))}${(ev.projects?.length ?? 0) > 1 ? `, ${ev.projects.length} versions signed so far` : ''}: ${esc(ev.project.sha)}<br>` : 'Project file: not signed yet<br>'}
      ${ev.bounces.map((b) => `Bounce ${b.num}, ${formatLength(b.durationSecs)}: ${esc(b.fpId.slice(0, 32))}…`).join('<br>')}
      ${ev.bounces.length ? '<br>' : ''}Plugin log: ${ev.logEntries} entries, head ${esc(ev.chainHead.slice(0, 32))}…
    </div>`;
}

function adopt(next: WorkDetail): void {
  work = next;
  rows = next.rows.map((r) => ({ ...r }));
  dirty = false;
  draw();
}

async function load(): Promise<void> {
  const works = await ctx.backend.works();
  $('#noWork').hidden = works.length > 0;
  $('#workBody').hidden = works.length === 0;
  $('#workPick').hidden = works.length === 0;
  if (works.length === 0) { work = null; $('#workTitle').textContent = 'Split sheets'; $('#sheetState').innerHTML = ''; return; }
  if (!ctx.workId || !works.some((w) => w.id === ctx.workId)) ctx.workId = works[0].id;

  $('#workPick').innerHTML = byAlbum(works).map(([album, list]) =>
    `<optgroup label="${esc(album || 'Singles')}">${list.map((w) => `<option value="${esc(w.id)}"${w.id === ctx.workId ? ' selected' : ''}>${esc(w.title)}</option>`).join('')}</optgroup>`).join('');
  $('#albumList').innerHTML = [...new Set(works.map((w) => w.album).filter(Boolean))].map((a) => `<option value="${esc(a)}">`).join('');
  adopt(await ctx.backend.work(ctx.workId));
}

async function act(name: string): Promise<void> {
  if (!work) return;
  try {
    if (name === 'save') { adopt(await ctx.backend.savePeople(work.id, inputs())); toast('Saved'); }
    if (name === 'send') {
      // Save first and show what the server says about each person (signed up or not), then send.
      if (dirty) adopt(await ctx.backend.savePeople(work.id, inputs()));
      adopt(await ctx.backend.send(work.id));
      toast(work.status === 'signed' ? 'Signed' : 'Sent for approval');
    }
    if (name === 'approved' || name === 'declined') {
      adopt(await ctx.backend.decide(work.id, name));
      toast(name === 'approved' ? 'Approved' : 'Declined');
    }
  } catch (err) { toast((err as Error).message); }
}

export function startSheet(): void {
  onShow('collaborate', load);

  const onEdit = (e: Event) => {
    const t = e.target as HTMLInputElement | HTMLSelectElement;
    const i = Number(t.dataset.i), key = t.dataset.k as 'artistName' | 'legalName' | 'email' | 'role' | 'writerShare' | 'masterShare' | undefined;
    if (!key || !rows[i] || !canEdit()) return;
    if (key === 'writerShare' || key === 'masterShare') rows[i][key] = parseFloat(t.value) || 0;
    else rows[i][key] = t.value;
    if (key === 'email') rows[i].hasAccount = undefined; // unknown until saved
    dirty = true;
    drawActions();
  };
  $('#sheet').addEventListener('input', onEdit);
  $('#sheet').addEventListener('change', onEdit);
  $('#sheet').addEventListener('click', (e) => {
    const drop = (e.target as HTMLElement).closest<HTMLElement>('[data-drop]')?.dataset.drop;
    if (drop === undefined || !canEdit()) return;
    rows.splice(Number(drop), 1);
    dirty = true;
    drawRows(); drawActions();
  });
  $('#addRow').addEventListener('click', () => {
    rows.push({ artistName: 'New collaborator', legalName: '', role: 'Songwriter', writerShare: 0, masterShare: 0, email: '', status: 'draft' });
    dirty = true;
    drawRows(); drawActions();
  });
  $('#sheetActions').addEventListener('click', (e) => {
    const name = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (name) void act(name);
  });
  $('#workPick').addEventListener('change', (e) => { ctx.workId = (e.target as HTMLSelectElement).value; void load(); });
  $('#fileForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!work) return;
    try {
      await ctx.backend.updateWork(work.id, { title: $<HTMLInputElement>('#ffTitle').value, album: $<HTMLInputElement>('#ffAlbum').value, isrc: $<HTMLInputElement>('#ffIsrc').value, iswc: $<HTMLInputElement>('#ffIswc').value });
      toast('Saved');
      await load();
    } catch (err) { toast((err as Error).message); }
  });

  const stateOwner = async (artistId: string) => {
    if (!work) return;
    try {
      const next = await ctx.backend.setOwner(work.id, artistId);
      // Handing a song to someone else can take it out of your own list.
      if (!next || (next as unknown as { handedOver?: boolean }).handedOver) { toast('Handed over'); ctx.workId = null; go('dashboard'); return; }
      adopt(next);
      toast('Owner set');
    } catch (err) { toast((err as Error).message); }
  };
  $('#ownerMe').addEventListener('click', () => void stateOwner(ctx.user?.artistId ?? ''));
  $('#ownerForm').addEventListener('submit', (e) => { e.preventDefault(); void stateOwner($<HTMLInputElement>('#ownerId').value); });
  $('#songCodeCopy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#songCode').textContent ?? ''); toast('Song code copied'); } catch { toast('Select the code and copy it'); }
  });
  $('#deleteForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!work) return;
    try { await ctx.backend.deleteWork(work.id, $<HTMLInputElement>('#deleteTitle').value); toast('Song deleted'); ctx.workId = null; go('dashboard'); }
    catch (err) { toast((err as Error).message); }
  });
}
