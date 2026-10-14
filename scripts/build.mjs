import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['src/plugin/controller.ts'], bundle: true, target: 'es2017', outfile: 'dist/code.js', minify: true });
const ui = await build({ entryPoints: ['src/app/ui.ts'], bundle: true, target: 'es2017', write: false, minify: true });
const template = await readFile('src/app/ui.html', 'utf8');
const css = await readFile('src/app/ui.css', 'utf8');
await writeFile('dist/ui.html', template.replace('/* INLINE_CSS */', css).replace('/* INLINE_JS */', ui.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')));
console.log('已构建 dist/code.js 与 dist/ui.html');
