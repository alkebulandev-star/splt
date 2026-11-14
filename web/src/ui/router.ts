import { ctx } from './context.ts';
import { $, $$ } from './dom.ts';

/** Views inside the signed-in workspace. Everything else is the public site or the sign-in page. */
export const WORKSPACE_VIEWS = ['dashboard', 'collaborate', 'identify', 'verify', 'messages', 'profile'] as const;

const loaders = new Map<string, () => void | Promise<void>>();
/** Registers what a view does each time it is shown (usually: fetch and draw). */
export const onShow = (name: string, load: () => void | Promise<void>): void => void loaders.set(name, load);

const current = (): string => location.hash.replace('#', '') || 'home';

export function go(name: string): void {
  if (current() === name) show();
  else location.hash = name;
}

function show(): void {
  const name = current();
  const inWorkspace = (WORKSPACE_VIEWS as readonly string[]).includes(name);
  if (inWorkspace && !ctx.user) { location.hash = 'sign-in'; return; }
  const signIn = name === 'sign-in' || name === 'sign-up';
  if (signIn && ctx.user) { location.hash = 'dashboard'; return; }

  $('#site').hidden = inWorkspace || signIn;
  $('#signin').hidden = !signIn;
  $('#shell').hidden = !inWorkspace;
  for (const v of $$('[data-view]')) v.hidden = v.dataset.view !== name;
  for (const b of $$('.side .tab')) {
    if (b.dataset.go === name) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  window.scrollTo(0, 0);
  void loaders.get(name)?.();
}

export function startRouter(): void {
  window.addEventListener('hashchange', show);
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const link = target.closest<HTMLElement>('[data-go]');
    if (link) { go(link.dataset.go ?? 'home'); return; }
    const jump = target.closest<HTMLElement>('[data-jump]');
    if (jump) document.getElementById(jump.dataset.jump ?? '')?.scrollIntoView({ behavior: 'smooth' });
  });
  show();
}
