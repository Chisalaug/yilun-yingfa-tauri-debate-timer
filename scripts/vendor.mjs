/**
 * 把前端用到的依赖从 node_modules 复制到 src/vendor，并把
 * `@tauri-apps/api/*` 这类裸模块名改写成相对路径。
 *
 * 这样在没有打包器的情况下，浏览器也能直接加载；同时 index.html
 * 里不再需要 import map（对 CSP 更友好）。
 *
 * 用法：npm run vendor
 */
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const fromNode = (...parts) => join(root, 'node_modules', ...parts);
const fromVendor = (...parts) => join(root, 'src', 'vendor', ...parts);

const API_MODULES = {
  '@tauri-apps/api/core': './tauri/core.js',
  '@tauri-apps/api/event': './tauri/event.js',
  '@tauri-apps/api/path': './tauri/path.js',
};

const PLUGINS = [
  { pkg: '@tauri-apps/plugin-dialog', out: 'dialog.js' },
  { pkg: '@tauri-apps/plugin-fs', out: 'fs.js' },
  { pkg: '@tauri-apps/plugin-store', out: 'store.js' },
  { pkg: '@tauri-apps/plugin-opener', out: 'opener.js' },
];

async function copyScript(source, target, rewrite) {
  let text = await readFile(source, 'utf8');
  if (rewrite) {
    for (const [specifier, replacement] of Object.entries(API_MODULES)) {
      text = text.split(`'${specifier}'`).join(`'${replacement}'`);
      text = text.split(`"${specifier}"`).join(`"${replacement}"`);
    }
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text, 'utf8');
}

async function copyDir(source, target) {
  if (!existsSync(source)) return 0;
  await mkdir(target, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    const src = join(source, entry.name);
    const dest = join(target, entry.name);
    if (entry.isDirectory()) {
      count += await copyDir(src, dest);
    } else {
      await copyFile(src, dest);
      count += 1;
    }
  }
  return count;
}

async function main() {
  const apiDir = fromNode('@tauri-apps/api');
  for (const name of ['core.js', 'event.js', 'path.js']) {
    await copyScript(join(apiDir, name), fromVendor('tauri', name), false);
  }
  await copyScript(
    join(apiDir, 'external', 'tslib', 'tslib.es6.js'),
    fromVendor('tauri', 'external', 'tslib', 'tslib.es6.js'),
    false,
  );

  for (const plugin of PLUGINS) {
    await copyScript(
      fromNode(plugin.pkg, 'dist-js', 'index.js'),
      fromVendor(plugin.out),
      true,
    );
  }

  const pdfjs = fromNode('pdfjs-dist', 'build');
  await copyScript(join(pdfjs, 'pdf.mjs'), fromVendor('pdfjs', 'pdf.mjs'), false);
  await copyScript(
    join(pdfjs, 'pdf.worker.mjs'),
    fromVendor('pdfjs', 'pdf.worker.mjs'),
    false,
  );

  // PDF.js 渲染中文 PDF 需要 cmaps，某些文件还需要标准字体数据
  const cmaps = await copyDir(fromNode('pdfjs-dist', 'cmaps'), fromVendor('pdfjs', 'cmaps'));
  const fonts = await copyDir(
    fromNode('pdfjs-dist', 'standard_fonts'),
    fromVendor('pdfjs', 'standard_fonts'),
  );

  console.log(`vendor 完成：${PLUGINS.length} 个插件、pdf.js、${cmaps} 个 cmap、${fonts} 个字体文件`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
