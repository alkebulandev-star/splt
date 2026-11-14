import { PROFILE_FIELDS, type PluginKey, type Profile } from '../core/api.ts';
import { ROLES } from '../core/roles.ts';
import { ctx, initials, when } from './context.ts';
import { $, esc, toast } from './dom.ts';
import { go, onShow } from './router.ts';

const field = (k: keyof Profile) => $<HTMLInputElement | HTMLSelectElement>(`#pf-${k}`);

let keys: PluginKey[] = [];
const shown = new Set<number>();

function drawKeys(list: PluginKey[]): void {
  keys = list;
  $('#keyTable tbody').innerHTML = keys.length === 0
    ? '<tr><td colspan="5" style="color:var(--mute)">No computers linked yet.</td></tr>'
    : keys.map((k) => `<tr><td>${esc(k.name)}</td>
        <td><code class="keycode">${shown.has(k.id) ? esc(k.key) : `${esc(k.key.slice(0, 8))}••••••••••••`}</code>
          <button type="button" class="x" data-show="${k.id}">${shown.has(k.id) ? 'Hide' : 'Show'}</button>
          <button type="button" class="x" data-copy="${k.id}">Copy</button></td>
        <td>${esc(when(k.createdAt))}</td><td>${k.lastUsedAt ? esc(when(k.lastUsedAt)) : 'Never'}</td>
        <td><button type="button" class="x" data-revoke="${k.id}">Remove</button></td></tr>`).join('');
}

function load(): void {
  $('#keyError').textContent = '';
  $('#dataError').textContent = '';
  $<HTMLTextAreaElement>('#exportOut').hidden = true; $('#exportCopy').hidden = true;
  $<HTMLInputElement>('#deletePass').value = '';
  void ctx.backend.pluginKeys().then(drawKeys).catch(() => drawKeys([]));
  const u = ctx.user;
  if (!u) return;
  $('#pf-role').innerHTML = [...new Set([...ROLES, u.role])].map((r) => `<option>${esc(r)}</option>`).join('');
  for (const k of PROFILE_FIELDS) field(k).value = u[k];
  $<HTMLInputElement>('#pf-email').value = u.email;
  $('#aidValue').textContent = u.artistId;
  $('#pfAvatar').textContent = initials(u.artistName);
  $('#pfError').textContent = '';
}

export function startProfile(): void {
  onShow('profile', load);

  $('#exportBtn').addEventListener('click', async () => {
    try {
      const out = $<HTMLTextAreaElement>('#exportOut');
      out.value = JSON.stringify(await ctx.backend.exportMyData(), null, 2);
      out.hidden = false; $('#exportCopy').hidden = false;
    } catch (err) { $('#dataError').textContent = (err as Error).message; }
  });
  $('#exportCopy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($<HTMLTextAreaElement>('#exportOut').value); toast('Copied'); } catch { $<HTMLTextAreaElement>('#exportOut').select(); }
  });
  $('#deleteAccountForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await ctx.backend.deleteAccount($<HTMLInputElement>('#deletePass').value);
      ctx.user = null; ctx.workId = null;
      toast('Your account is deleted');
      go('home');
    } catch (err) { $('#dataError').textContent = (err as Error).message; }
  });

  $('#aidCopy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#aidValue').textContent ?? ''); toast('Artist ID copied'); }
    catch { toast('Select the ID and copy it'); }
  });

  $('#keyForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const made = await ctx.backend.createPluginKey($<HTMLInputElement>('#keyName').value);
      $('#keyError').textContent = '';
      $<HTMLInputElement>('#keyName').value = '';
      const added = made.keys.find((k) => k.key === made.key);
      if (added) shown.add(added.id);
      drawKeys(made.keys);
    } catch (err) { $('#keyError').textContent = (err as Error).message; }
  });
  $('#keyTable').addEventListener('click', async (e) => {
    const data = (e.target as HTMLElement).closest<HTMLElement>('[data-show],[data-copy],[data-revoke]')?.dataset;
    if (!data) return;
    if (data.show) { const id = Number(data.show); if (shown.has(id)) shown.delete(id); else shown.add(id); drawKeys(keys); }
    if (data.copy) {
      const k = keys.find((x) => x.id === Number(data.copy));
      try { await navigator.clipboard.writeText(k?.key ?? ''); toast('Key copied'); }
      catch { shown.add(Number(data.copy)); drawKeys(keys); toast('Select the key and copy it'); }
    }
    if (data.revoke) drawKeys(await ctx.backend.revokePluginKey(Number(data.revoke)));
  });
  $('#profileForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const profile = Object.fromEntries(PROFILE_FIELDS.map((k) => [k, field(k).value])) as unknown as Profile;
    try {
      ctx.user = await ctx.backend.saveProfile(profile);
      load();
      toast('Profile saved');
    } catch (err) { $('#pfError').textContent = (err as Error).message; }
  });
}
