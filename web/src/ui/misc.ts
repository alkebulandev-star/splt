import { $ } from './dom.ts';

/** Landing page: the Lock button under the hero rows. */
export function startMisc(): void {
  const lock = $('#heroLock'), chip = $('#heroChip');
  lock.addEventListener('click', () => {
    const locked = lock.dataset.on !== '1';
    lock.dataset.on = locked ? '1' : '0';
    lock.textContent = locked ? 'Unlock' : 'Lock splits';
    lock.className = `pill ${locked ? 'ghost' : 'white'}`;
    chip.textContent = locked ? 'Locked' : 'Not locked';
    chip.className = `chip${locked ? ' on' : ''}`;
  });
}
