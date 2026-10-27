'use strict';

/* ==========================================================================
 * 页面切换：welcome / main / help
 *
 * - 三个屏幕都是全屏容器，用 hidden + is-active 切换，不重新加载页面
 * - 过渡只用 transform / opacity
 * - 帮助页分页用 translateX + opacity 做「左出右进」
 * - 帮助页关闭后在主界面右下角显示悬浮帮助按钮
 * ========================================================================== */

export function initScreens() {
  const screens = {
    welcome: document.getElementById('welcomeScreen'),
    main: document.getElementById('mainScreen'),
    help: document.getElementById('helpScreen'),
  };

  const fab = document.getElementById('helpFab');
  const viewport = document.getElementById('helpViewport');
  const pages = [...viewport.querySelectorAll('.help-page')];
  const progress = document.getElementById('helpProgress');
  const prevBtn = document.getElementById('helpPrev');
  const nextBtn = document.getElementById('helpNext');

  let current = 'welcome';
  let helpIndex = 0;
  let helpOrigin = 'welcome';
  let hideTimer = 0;

  function updateFab() {
    // 帮助按钮只出现在主界面右下角
    fab.hidden = current !== 'main';
  }

  function show(name) {
    if (!screens[name] || name === current) return;

    const from = screens[current];
    const to = screens[name];

    clearTimeout(hideTimer);
    to.hidden = false;
    void to.offsetWidth; // 先上屏，让过渡从初始态开始
    to.classList.add('is-active');
    from.classList.remove('is-active');

    hideTimer = setTimeout(() => {
      from.hidden = true;
    }, 420);

    current = name;
    document.body.dataset.screen = name;
    updateFab();
  }

  /* ---------------- 帮助页 ---------------- */

  function updatePager() {
    progress.textContent = `${helpIndex + 1} / ${pages.length}`;
    prevBtn.disabled = helpIndex === 0;
    nextBtn.textContent = helpIndex === pages.length - 1 ? '完成' : '下一页';
  }

  function goPage(target) {
    if (target < 0 || target >= pages.length || target === helpIndex) return;

    const dir = target > helpIndex ? 'forward' : 'back';
    const from = pages[helpIndex];
    const to = pages[target];

    viewport.dataset.dir = dir;
    from.classList.add('is-leaving');
    from.classList.remove('is-active');
    void to.offsetWidth;
    to.classList.add('is-active');
    setTimeout(() => from.classList.remove('is-leaving'), 320);

    helpIndex = target;
    updatePager();
  }

  function openHelp(origin) {
    helpOrigin = origin === 'main' ? 'main' : 'welcome';
    helpIndex = 0;
    viewport.dataset.dir = 'forward';
    pages.forEach((page, index) => {
      page.classList.toggle('is-active', index === 0);
      page.classList.remove('is-leaving');
    });
    updatePager();
    show('help');
  }

  function closeHelp() {
    show(helpOrigin);
  }

  /* ---------------- 事件 ---------------- */

  document.getElementById('btnStartApp').addEventListener('click', () => show('main'));
  document
    .getElementById('btnOpenHelpFromWelcome')
    .addEventListener('click', () => openHelp('welcome'));

  document.getElementById('helpClose').addEventListener('click', closeHelp);
  prevBtn.addEventListener('click', () => goPage(helpIndex - 1));
  nextBtn.addEventListener('click', () => {
    if (helpIndex === pages.length - 1) closeHelp();
    else goPage(helpIndex + 1);
  });
  fab.addEventListener('click', () => openHelp('main'));

  document.addEventListener('keydown', (event) => {
    if (current !== 'help') return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeHelp();
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      goPage(helpIndex - 1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      if (helpIndex === pages.length - 1) closeHelp();
      else goPage(helpIndex + 1);
    }
  });

  document.body.dataset.screen = 'welcome';
  updateFab();

  return {
    show,
    openHelp,
    closeHelp,
    get current() {
      return current;
    },
  };
}
