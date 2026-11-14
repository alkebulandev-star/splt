// Bundles src/main.ts and inlines it, with the stylesheet, into one self-contained page.
import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const js = await build({
  entryPoints: ['src/main.ts'], bundle: true, minify: true, format: 'iife',
  target: 'es2020', write: false,
});
const css = await readFile('src/styles.css', 'utf8');
const html = await readFile('src/index.html', 'utf8');
const out = html
  .replace('/*__CSS__*/', () => css)
  .replace('/*__JS__*/', () => js.outputFiles[0].text.replace(/<\/script/g, '<\\/script'));
await mkdir('dist', { recursive: true });
await writeFile('dist/index.html', out);
console.log(`dist/index.html  ${(out.length / 1024).toFixed(1)} kB`);
