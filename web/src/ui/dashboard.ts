import type { PersonInput, WorkSummary } from '../core/api.ts';
import { normaliseArtistId } from '../core/artistId.ts';
import { ROLES } from '../core/roles.ts';
import { COLOURS, ctx, initials, STATUS_TAG, when } from './context.ts';
import { $, esc, toast } from './dom.ts';
import { go, onShow } from './router.ts';

/** Songs grouped by album, albums in alphabetical order and singles last. */
export function byAlbum(works: WorkSummary[]): [string, WorkSummary[]][] {
  const groups = new Map<string, WorkSummary[]>();
  for (const w of works) groups.set(w.album, [...(groups.get(w.album) ?? []), w]);
  return [...groups.entries()].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
}

function statusTag(w: WorkSummary): string {
  if (w.needsYou) return '<span class="st wait">Needs your approval</span>';
  if (w.status === 'sent') return `<span class="st wait">Awaiting ${w.awaiting}</span>`;
  const [cls, label] = STATUS_TAG[w.status];
  return `<span class="st ${cls}">${label}</span>`;
}

const roleOptions = (selected: string) => ROLES.map((r) => `<option${r === selected ? ' selected' : ''}>${esc(r)}</option>`).join('');

/**
 * Adds one person at 0% to a draft sheet; shares are then set on the split sheet.
 * `contact` is their Artist ID (their account's details are filled in) or an email address.
 */
async function addCollaborator(workId: string, person: { artistName: string; contact: string; role: string }): Promise<void> {
  const work = await ctx.backend.work(workId);
  const rows: PersonInput[] = work.rows.map(({ status: _s, hasAccount: _h, ...r }) => r);
  let added: PersonInput = { artistName: person.artistName.trim(), legalName: '', role: person.role, writerShare: 0, masterShare: 0, email: person.contact.trim() };
  const id = normaliseArtistId(person.contact);
  if (id) {
    const card = await ctx.backend.artist(id);
    added = { ...added, artistName: card.artistName, legalName: card.legalName, role: person.role || card.role, email: card.email };
  } else if (person.contact.trim() && !person.contact.includes('@')) {
    throw new Error('Enter their Artist ID (like ST-7K2Q-9FXM) or their email address');
  }
  if (!added.artistName) throw new Error('Enter their artist name or their Artist ID');
  if (added.email && rows.some((r) => r.email.toLowerCase() === added.email.toLowerCase())) throw new Error('That person is already on this song');
  rows.push(added);
  await ctx.backend.savePeople(workId, rows);
}

async function load(): Promise<void> {
  const user = ctx.user;
  if (!user) return;
  $('#hello').textContent = `Hello, ${user.artistName.split(' ')[0]}`;
  $('#meChip').innerHTML = `<span class="av" style="background:var(--p1)">${esc(initials(user.artistName))}</span>${esc(user.artistName)}`;

  const [works, activity] = await Promise.all([ctx.backend.works(), ctx.backend.activity()]);
  const kpi = (label: string, n: number, warn = false) => `<div class="kpi"><small>${label}</small><b${warn && n > 0 ? ' style="color:var(--wait)"' : ''}>${n}</b></div>`;
  $('#kpis').innerHTML =
    kpi('Songs', works.length) +
    kpi('Waiting for you', works.filter((w) => w.needsYou).length, true) +
    kpi('Waiting for others', works.filter((w) => w.status === 'sent' && !w.needsYou).length) +
    kpi('Signed split sheets', works.filter((w) => w.status === 'signed').length);

  $('#worksByAlbum').innerHTML = works.length === 0
    ? '<div class="pad" style="color:var(--mute)">No songs yet. Add your first one above.</div>'
    : byAlbum(works).map(([album, list]) => `
      <div class="album"><span>${esc(album || 'Singles')}</span><span>${list.length} ${list.length === 1 ? 'song' : 'songs'}</span></div>
      <div class="scroll"><table>
        <thead><tr><th>Title</th><th>Collaborators</th><th class="num">Your writer share</th><th>Status</th><th></th></tr></thead>
        <tbody>${list.map((w) => `
          <tr>
            <td><button type="button" class="worklink" data-open="${esc(w.id)}">${esc(w.title)}</button>${w.isOwner ? '' : ' <span style="color:var(--mute);font-size:12px">shared with you</span>'}</td>
            <td><span class="stack">${w.people.slice(0, 6).map((n, i) => `<span class="av" title="${esc(n)}" style="background:var(${COLOURS[i % COLOURS.length]})">${esc(initials(n))}</span>`).join('')}</span></td>
            <td class="num">${w.yourWriterShare === null ? '—' : `${w.yourWriterShare}%`}</td>
            <td>${statusTag(w)}</td>
            <td>${w.isOwner && w.status === 'draft' ? `<button type="button" class="x" data-collab="${esc(w.id)}">Add collaborator</button>` : ''}</td>
          </tr>`).join('')}</tbody>
      </table></div>`).join('');

  $('#albumList').innerHTML = [...new Set(works.map((w) => w.album).filter(Boolean))].map((a) => `<option value="${esc(a)}">`).join('');
  $('#nwCopy').innerHTML = '<option value="">Start with just me at 100%</option>' +
    works.filter((w) => w.isOwner).map((w) => `<option value="${esc(w.id)}">Same split as ${esc(w.title)}</option>`).join('');

  $('#nwCollabRole').innerHTML = roleOptions('Songwriter');

  $('#activity').innerHTML = activity.length === 0
    ? '<div style="color:var(--mute)">Nothing yet.</div>'
    : activity.map((a) => `<div>${esc(a.text)}<time>${esc(a.work)} · ${esc(when(a.time))}</time></div>`).join('');
}

export function startDashboard(): void {
  onShow('dashboard', load);

  $('#worksByAlbum').addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const id = target.closest<HTMLElement>('[data-open]')?.dataset.open;
    if (id) { ctx.workId = id; go('collaborate'); return; }

    // "Add collaborator" opens a small form in a row of its own under the song.
    const button = target.closest<HTMLElement>('[data-collab]');
    if (!button) return;
    const row = button.closest('tr')!;
    if (row.nextElementSibling?.classList.contains('collabform')) { row.nextElementSibling.remove(); return; }
    const form = document.createElement('tr');
    form.className = 'collabform';
    form.innerHTML = `<td colspan="5"><form data-collab-for="${esc(button.dataset.collab)}">
      <input name="contact" placeholder="Their Artist ID (or email)" aria-label="Artist ID or email" maxlength="254" required>
      <input name="artistName" placeholder="Artist name (filled in from the ID)" aria-label="Artist name" maxlength="80">
      <select name="role" aria-label="Role">${roleOptions('Songwriter')}</select>
      <button class="btn dark" type="submit">Add</button>
      <span class="soon"><button class="btn line" type="button" disabled tabindex="-1">Invite</button><em>Soon</em></span></form></td>`;
    row.after(form);
    form.querySelector<HTMLInputElement>('input')?.focus();
  });

  $('#worksByAlbum').addEventListener('submit', async (e) => {
    const form = (e.target as HTMLElement).closest<HTMLFormElement>('form[data-collab-for]');
    if (!form) return;
    e.preventDefault();
    const data = new FormData(form);
    try {
      await addCollaborator(form.dataset.collabFor!, { artistName: String(data.get('artistName') ?? ''), contact: String(data.get('contact') ?? ''), role: String(data.get('role') ?? 'Songwriter') });
      toast('Collaborator added. Set the shares on the split sheet.');
      await load();
    } catch (err) { toast((err as Error).message); }
  });

  $('#newWork').addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = $<HTMLInputElement>('#nwTitle'), album = $<HTMLInputElement>('#nwAlbum');
    try {
      const work = await ctx.backend.createWork({ title: title.value, album: album.value, copyFrom: $<HTMLSelectElement>('#nwCopy').value || undefined });
      const collab = $<HTMLInputElement>('#nwCollab'), collabEmail = $<HTMLInputElement>('#nwCollabEmail');
      if (collab.value.trim() || collabEmail.value.trim()) {
        await addCollaborator(work.id, { artistName: collab.value, contact: collabEmail.value, role: $<HTMLSelectElement>('#nwCollabRole').value });
        collab.value = ''; collabEmail.value = '';
      }
      title.value = '';
      ctx.workId = work.id;
      go('collaborate');
    } catch (err) { toast((err as Error).message); }
  });
}
