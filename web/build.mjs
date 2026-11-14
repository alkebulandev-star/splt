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
// src/index.html holds head content (title, fonts, style) followed by the page body. Served on its own
// it needs a real document around it; without the viewport line a phone draws it as a shrunken desktop page.
const cut = out.indexOf('</style>') + '</style>'.length;
const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0d0d0f">
<meta name="description" content="Split Tracker records who made what in the studio, and turns it into split sheets everyone signs.">
${out.slice(0, cut).trim()}
</head>
<body>
${out.slice(cut).trim()}
</body>
</html>
`;
await mkdir('dist', { recursive: true });
await writeFile('dist/index.html', page);
console.log(`dist/index.html  ${(page.length / 1024).toFixed(1)} kB`);
