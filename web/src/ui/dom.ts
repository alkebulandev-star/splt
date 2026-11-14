export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T => {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`Missing element ${sel}`);
  return el;
};
export const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T[] =>
  Array.from(root.querySelectorAll<T>(sel));

export const esc = (s: unknown): string =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

let timer: number | undefined;
export function toast(message: string): void {
  const t = $('#toast');
  t.textContent = message;
  t.hidden = false;
  clearTimeout(timer);
  timer = window.setTimeout(() => (t.hidden = true), 2600);
}

/** Lets the page repaint between heavy steps. */
export const breathe = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Wires a drop zone: highlights on drag and hands dropped files to `onFiles`. */
export function dropZone(zone: HTMLElement, input: HTMLInputElement, onFiles: (files: File[]) => void): void {
  input.addEventListener('change', () => { onFiles(Array.from(input.files ?? [])); input.value = ''; });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    onFiles(Array.from(e.dataTransfer?.files ?? []));
  });
}
