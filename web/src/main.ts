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

void boot();
