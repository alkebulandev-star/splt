import type { WorkDetail } from '../core/api.ts';
import { ctx, STATUS_TAG, when } from './context.ts';
import { $, esc, toast } from './dom.ts';
import { onShow } from './router.ts';

function drawChat(work: WorkDetail): void {
  $('#threadTitle').textContent = `${work.title} · ${work.people.join(', ')}`;
  $('#chat').innerHTML = work.messages.length === 0
    ? '<div style="color:var(--mute);font-size:14px">No messages on this song yet.</div>'
    : work.messages.map((m) => `<div class="bubble${m.mine ? ' mine' : ''}"><small>${esc(m.mine ? 'You' : m.author)} · ${esc(when(m.time))}</small>${esc(m.body)}</div>`).join('');
}

async function load(): Promise<void> {
  const works = await ctx.backend.works();
  $('#chatForm').hidden = works.length === 0;
  if (works.length === 0) { $('#threads').innerHTML = '<div class="pad" style="color:var(--mute)">Messages are kept per song. Add a song first.</div>'; $('#chat').innerHTML = ''; return; }
  if (!ctx.workId || !works.some((w) => w.id === ctx.workId)) ctx.workId = works[0].id;
  $('#threads').innerHTML = works.map((w) => `
    <button class="thread" type="button" data-thread="${esc(w.id)}" aria-pressed="${w.id === ctx.workId}">
      <b>${esc(w.title)}</b><small>${esc(w.album || 'Single')}</small>
      <span class="st ${STATUS_TAG[w.status][0]}">${STATUS_TAG[w.status][1]}</span>
    </button>`).join('');
  drawChat(await ctx.backend.work(ctx.workId));
}

export function startMessages(): void {
  onShow('messages', load);
  $('#threads').addEventListener('click', (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>('[data-thread]')?.dataset.thread;
    if (id) { ctx.workId = id; void load(); }
  });
  $('#chatForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>('#chatText'), body = input.value.trim();
    if (!body || !ctx.workId) return;
    try { drawChat(await ctx.backend.postMessage(ctx.workId, body)); input.value = ''; }
    catch (err) { toast((err as Error).message); }
  });
}
