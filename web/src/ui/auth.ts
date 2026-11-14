import { ctx } from './context.ts';
import { $ } from './dom.ts';
import { go, onShow } from './router.ts';

let registering = false;

function draw(): void {
  $('#authTitle').textContent = registering ? 'Create your account' : 'Sign in to your account';
  $('#authSubmit').textContent = registering ? 'Create account' : 'Sign in';
  $('#authSwitch').textContent = registering ? 'I already have an account' : 'Create an account';
  $('#regFields').hidden = !registering;
  $<HTMLInputElement>('#au-pass').autocomplete = registering ? 'new-password' : 'current-password';
  $('#authNote').textContent = ctx.backend.mode === 'preview'
    ? 'This is a preview with no server behind it. Press the button to open the example workspace.'
    : registering ? 'Use the email your collaborators will invite you with. Passwords need at least 10 characters.' : '';
  $('#authError').textContent = '';
}

export function startAuth(): void {
  onShow('sign-in', () => { registering = false; draw(); });
  onShow('sign-up', () => { registering = true; draw(); });
  // The address follows the mode, so each form has its own link from the landing page.
  $('#authSwitch').addEventListener('click', () => { location.hash = registering ? 'sign-in' : 'sign-up'; });

  $('#authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $<HTMLInputElement>('#au-email').value, password = $<HTMLInputElement>('#au-pass').value;
    const button = $<HTMLButtonElement>('#authSubmit');
    button.disabled = true;
    try {
      ctx.user = registering
        ? await ctx.backend.register({ email, password, artistName: $<HTMLInputElement>('#au-artist').value, legalName: $<HTMLInputElement>('#au-legal').value })
        : await ctx.backend.login(email, password);
      $<HTMLInputElement>('#au-pass').value = '';
      go('dashboard');
    } catch (err) {
      $('#authError').textContent = (err as Error).message;
    } finally {
      button.disabled = false;
    }
  });

  $('#signOut').addEventListener('click', async () => {
    await ctx.backend.logout().catch(() => undefined);
    ctx.user = null;
    ctx.workId = null;
    go('home');
  });
}
