'use strict';

/* ==========================================================================
 * PPT 背景
 *
 * - 导入 .pptx → 走 Rust 命令 convert_pptx_to_pdf（本地 LibreOffice 转换 + 缓存）
 * - 导入 .pdf → 直接渲染
 * - pdfjs-dist 自托管在 src/vendor/pdfjs（worker 不走 CDN）
 * - 全屏 canvas 在 z-index: 0，计时器 UI 在 z-index: 10，中间是遮罩层
 * - ← / → 翻页，点击左 / 右半区也能翻
 * ========================================================================== */

import { open } from './vendor/dialog.js';
import { readFile } from './vendor/fs.js';
import { invoke } from './vendor/tauri/core.js';
import { getDocument, GlobalWorkerOptions } from './vendor/pdfjs/pdf.mjs';

GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.mjs', import.meta.url).href;
const CMAP_URL = new URL('./vendor/pdfjs/cmaps/', import.meta.url).href;
const FONT_URL = new URL('./vendor/pdfjs/standard_fonts/', import.meta.url).href;

const LIBREOFFICE_HINT = 'LibreOffice';

export function initPpt({ state, persist, notify }) {
  const canvas = document.getElementById('pptCanvas');
  const pager = document.getElementById('pptPager');
  const pageLabel = document.getElementById('pptPageLabel');
  const loading = document.getElementById('pptLoading');
  const overlay = document.getElementById('bgOverlay');
  const slider = document.getElementById('bgDim');
  const dimValue = document.getElementById('bgDimValue');
  const strokeGroup = document.getElementById('bgStroke');
  const removeBtn = document.getElementById('bgRemove');

  const ctx = canvas.getContext('2d', { alpha: false });

  let pdf = null;
  let pageNum = 1;
  let loadToken = 0;
  let renderToken = 0;
  let resizeTimer = 0;

  function config() {
    if (!state.bgConfig) state.bgConfig = { dim: 15, stroke: 'black' };
    return state.bgConfig;
  }

  function applyConfig() {
    const conf = config();
    const dim = Math.min(60, Math.max(0, Number(conf.dim) || 0));
    document.documentElement.style.setProperty('--ppt-dim', String(dim / 100));
    document.body.dataset.stroke = conf.stroke === 'white' ? 'white' : 'black';
    if (slider) slider.value = String(dim);
    if (dimValue) dimValue.textContent = `${dim}%`;
    if (strokeGroup) {
      for (const btn of strokeGroup.querySelectorAll('button[data-stroke]')) {
        btn.classList.toggle('is-active', btn.dataset.stroke === conf.stroke);
      }
    }
  }

  function setLoading(text) {
    if (!loading) return;
    if (!text) {
      loading.hidden = true;
      loading.textContent = '';
      return;
    }
    loading.hidden = false;
    loading.textContent = text;
  }

  async function renderPage() {
    if (!pdf) return;
    const token = ++renderToken;
    const page = await pdf.getPage(pageNum);
    if (token !== renderToken) return;

    const base = page.getViewport({ scale: 1 });
    const fit = Math.min(
      window.innerWidth / base.width,
      window.innerHeight / base.height,
    );
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const viewport = page.getViewport({ scale: fit * dpr });

    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    canvas.style.width = `${Math.floor(base.width * fit)}px`;
    canvas.style.height = `${Math.floor(base.height * fit)}px`;

    ctx.fillStyle = '#05070d';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvasContext: ctx, viewport }).promise;
    if (token !== renderToken) return;

    if (pageLabel) pageLabel.textContent = `${pageNum} / ${pdf.numPages}`;
  }

  async function openPdf(bytes) {
    const token = ++loadToken;

    if (pdf) {
      try {
        await pdf.destroy();
      } catch {
        /* 忽略销毁失败 */
      }
      pdf = null;
    }

    const task = getDocument({
      data: bytes,
      cMapUrl: CMAP_URL,
      cMapPacked: true,
      standardFontDataUrl: FONT_URL,
    });

    const next = await task.promise;
    if (token !== loadToken) {
      void next.destroy();
      return;
    }

    pdf = next;
    pageNum = 1;
    document.body.classList.add('has-background');
    if (pager) pager.hidden = false;
    await renderPage();
  }

  async function importFile() {
    let path;
    try {
      path = await open({
        title: 'PPT / PDF 背景',
        multiple: false,
        directory: false,
        filters: [{ name: 'PPT / PDF', extensions: ['pptx', 'pdf'] }],
      });
    } catch {
      notify('无法打开文件选择框');
      return;
    }

    if (!path) return;
    if (Array.isArray(path)) path = path[0];

    try {
      if (/\.pdf$/i.test(path)) {
        setLoading('正在读取 PDF…');
        const bytes = await readFile(path);
        setLoading('正在渲染…');
        await openPdf(bytes);
      } else {
        setLoading('正在转换 PPT（首次需要几秒）…');
        const raw = await invoke('convert_pptx_to_pdf', { pptxPath: path });
        setLoading('正在渲染…');
        await openPdf(new Uint8Array(raw));
      }
      notify('背景已加载，可用 ← → 翻页');
    } catch (err) {
      const message = typeof err === 'string' ? err : (err && err.message) || '';
      notify(
        message.includes(LIBREOFFICE_HINT)
          ? message
          : `导入背景失败：${message || '未知错误'}`,
      );
    } finally {
      setLoading('');
    }
  }

  function removeBackground() {
    loadToken += 1;
    renderToken += 1;
    if (pdf) {
      void pdf.destroy().catch(() => {});
      pdf = null;
    }
    document.body.classList.remove('has-background');
    if (pager) pager.hidden = true;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    canvas.width = 1;
    canvas.height = 1;
    notify('已移除背景');
  }

  function go(delta) {
    if (!pdf) return;
    const next = Math.min(pdf.numPages, Math.max(1, pageNum + delta));
    if (next === pageNum) return;
    pageNum = next;
    void renderPage();
  }

  /* ---------------- 背景设置面板 ---------------- */

  function openSettings() {
    applyConfig();
    if (removeBtn) removeBtn.disabled = !pdf;
    overlay.hidden = false;
    document.body.classList.add('modal-open');
  }

  function closeSettings() {
    overlay.hidden = true;
    document.body.classList.remove('modal-open');
  }

  slider.addEventListener('input', () => {
    const conf = config();
    conf.dim = Number(slider.value);
    applyConfig();
  });
  slider.addEventListener('change', () => {
    void persist();
  });

  strokeGroup.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-stroke]');
    if (!btn) return;
    config().stroke = btn.dataset.stroke;
    applyConfig();
    void persist();
  });

  removeBtn.addEventListener('click', () => {
    removeBackground();
    closeSettings();
  });

  document.getElementById('bgClose').addEventListener('click', closeSettings);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closeSettings();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !overlay.hidden) {
      closeSettings();
      return;
    }
    if (!pdf) return;
    if (document.body.dataset.screen !== 'main') return;
    if (document.body.classList.contains('modal-open')) return;
    const target = event.target;
    if (
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable)
    ) {
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      go(-1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      go(1);
    }
  });

  // canvas 在 UI 层下面，所以用文档级点击判断左 / 右半区
  document.addEventListener('click', (event) => {
    if (!pdf) return;
    if (document.body.dataset.screen !== 'main') return;
    if (document.body.classList.contains('modal-open')) return;
    if (
      event.target.closest(
        'button, a, input, textarea, select, .overlay, .ai-modal-wrap, .topbar, .controls, .ppt-pager, .toast',
      )
    ) {
      return;
    }
    if (event.clientX < window.innerWidth / 2) go(-1);
    else go(1);
  });

  window.addEventListener('resize', () => {
    if (!pdf) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      void renderPage();
    }, 180);
  });

  applyConfig();

  return {
    importFile,
    openSettings,
    applyConfig,
    removeBackground,
    hasBackground: () => Boolean(pdf),
    go,
  };
}
