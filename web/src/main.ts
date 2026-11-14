import { httpBackend, serverAvailable } from './core/backendHttp.ts';
import { startAuth } from './ui/auth.ts';
import { ctx } from './ui/context.ts';
import { startDashboard } from './ui/dashboard.ts';
import { $ } from './ui/dom.ts';
import { startIdentify } from './ui/identify.ts';
import { startMessages } from './ui/messages.ts';
import { startMisc } from './ui/misc.ts';
import { startProfile } from './ui/profile.ts';
import { startReceipt } from './ui/receipt.ts';
import { startRouter } from './ui/router.ts';
import { startSheet } from './ui/sheet.ts';
import { startVerify } from './ui/verify.ts';

async function boot(): Promise<void> {
  // Served by the Split Tracker server: real accounts. Opened on its own: the in-page preview.
  if (await serverAvailable()) {
    ctx.backend = httpBackend;
    ctx.user = await httpBackend.me();
  }
  $('#previewBanner').hidden = ctx.backend.mode !== 'preview';

  startMisc();
  startAuth();
  startDashboard();
  startReceipt();
  startSheet();
  startMessages();
  startProfile();
  startVerify();
  void startIdentify();
  startRouter();
}

/**
 * On a phone every table is drawn as a stack of cards (see the max-width:640px rules in styles.css),
 * and each cell shows its column's heading beside it. This copies the headings onto the cells,
 * whenever a screen redraws a table.
 */
function labelTables(): void {
  for (const table of document.querySelectorAll('table')) {
    const heads = Array.from(table.querySelectorAll('thead th')).map((th) => th.textContent?.trim() ?? '');
    if (heads.length === 0) continue;
    for (const row of table.querySelectorAll('tbody tr')) {
      let col = 0;
      for (const cell of row.children) {
        const td = cell as HTMLTableCellElement;
        if (td.colSpan === 1 && td.dataset.label !== heads[col]) td.dataset.label = heads[col] ?? '';
        col += td.colSpan;
      }
    }
  }
}
let labelling = false;
new MutationObserver(() => {
  if (labelling) return;
  labelling = true;
  requestAnimationFrame(() => { labelTables(); labelling = false; });
}).observe(document.body, { childList: true, subtree: true });

void boot();
