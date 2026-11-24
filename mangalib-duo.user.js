// ==UserScript==
// @name         MangaLib Duo
// @namespace    https://github.com/kakosina/mangalib-duo
// @version      2.9.1
// @description  Double-Page Reader for Mangalib
// @author       kakosina
// @match        https://mangalib.org/*
// @match        https://*.mangalib.org/*
// @match        https://mangalib.me/*
// @match        https://*.mangalib.me/*
// @match        https://*.lib.social/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @grant        unsafeWindow
// @homepageURL  https://github.com/kakosina/mangalib-duo
// @downloadURL  https://raw.githubusercontent.com/kakosina/mangalib-duo/main/mangalib-duo.user.js
// @updateURL    https://raw.githubusercontent.com/kakosina/mangalib-duo/main/mangalib-duo.user.js
// ==/UserScript==


(function () {
  'use strict';

  const STORAGE_KEY = 'mangalib_duo_settings_v291';

  const DEFAULT_SETTINGS = {
    enabled: true,           // Двустраничный режим (Alt+D)
    firstPageSide: 'right',  // 'right' (манга: 2 | 1) | 'left' (комикс: 1 | 2)
    rtlNav: true,            // Листать справа налево (левая сторона / ← = вперёд)
    flipAnimation: true,     // Интерактивное 3D-перелистывание книги
    coverAlone: false,       // Обложка отдельно (сдвиг парности, Alt+S)
    autoWide: true,          // Широкие сканы целиком
    cleanScreen: true        // Скрывать верхнее и нижнее меню при открытии главы
  };

  function loadSettings() {
    try {
      let raw = null;
      if (typeof GM_getValue === 'function') {
        raw = GM_getValue(STORAGE_KEY, null);
      }
      if (!raw) raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...DEFAULT_SETTINGS };
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return { ...DEFAULT_SETTINGS, ...parsed };
    } catch (_) {
      return { ...DEFAULT_SETTINGS };
    }
  }

  function saveSettings(patch) {
    const prevEnabled = settings.enabled;
    settings = { ...settings, ...patch };
    try {
      const serialized = JSON.stringify(settings);
      if (typeof GM_setValue === 'function') GM_setValue(STORAGE_KEY, serialized);
      localStorage.setItem(STORAGE_KEY, serialized);
    } catch (_) {}

    syncAllSettingsUI();

    if (prevEnabled !== settings.enabled) {
      if (!settings.enabled) {
        cleanupDuoStage();
      } else {
        applyCleanScreenState(settings.cleanScreen);
      }
    } else if ('cleanScreen' in patch && isReaderPage() && settings.enabled) {
      applyCleanScreenState(settings.cleanScreen);
    }

    scheduleRender();
  }

  let settings = loadSettings();

  // Состояние главы
  let chapterPages = [];          // [{ index, url, image, fullUrl, width, height }]
  let pagesFromApi = false;
  let chapterKey = '';
  let cdnOrigin = '';             // Определяется из реально загруженных картинок сайта
  let fallbackServers = [
    'https://img33.imgslib.link',
    'https://img3.imgslib.link',
    'https://img2.imgslib.link',
    'https://img2.mixlib.me'
  ];

  let currentSpreadIndex = 0;
  let openAtLastSpread = false;
  let lastSpreadChangeAt = 0;
  let apiFetchInFlightFor = '';
  let renderRaf = null;
  let animTimer = null;
  let currentUrl = location.href;
  let hiddenNativeContainer = null;
  let uiHidden = settings.cleanScreen;

  // Состояние интерактивного перелистывания (мышь + палец)
  const drag = {
    active: false,
    pointerId: null,
    isDragging: false,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastTime: 0,
    vx: 0,
    side: 'left',       // 'left' | 'right' — с какой половины схватили
    turnDir: 'l2r',     // 'l2r' (лист слева направо) | 'r2l' (лист справа налево)
    stepDelta: 1,       // +1 (вперёд) | -1 (назад)
    targetIndex: 0,
    isBoundary: false,  // Край главы (переход на соседнюю главу)
    is3D: true,
    progress: 0,
    nodes: null         // DOM-ссылки на элементы текущего переворота
  };

  let isAnimatingFinish = false;

  // =========================================================================
  // 1. МАРШРУТЫ, ЗАГРУЗКА СТРАНИЦ БЕЗ ПЕРЕХВАТА FETCH/XHR И СБОРКА URL
  // =========================================================================

  function parseChapterRoute(pathname = location.pathname) {
    const m = pathname.match(/(?:\/[a-z]{2})?(?:\/manga)?\/([^/]+)\/(?:read\/)?v([^/]+)\/c([^/?#]+)/i);
    if (!m) return null;
    return {
      slug: m[1],
      volume: m[2],
      number: m[3],
      key: `${m[1]}_${m[2]}_${m[3]}`
    };
  }

  function isReaderPage(pathname = location.pathname) {
    return Boolean(parseChapterRoute(pathname));
  }

  // Отличаем реальный URL с доменом (https://... или //img3.imgslib.link/...) от пути //manga/...
  function isRealFullUrl(u) {
    if (!u || typeof u !== 'string') return false;
    if (/^https?:\/\//i.test(u)) return true;
    return /^\/\/[^/]+\.[^/]+\//.test(u);
  }

  function normalizeFullUrl(u) {
    return u.startsWith('//') ? 'https:' + u : u;
  }

  function buildImageUrl(page, serverOverride = '', singleSlash = false) {
    if (!page) return '';
    if (!serverOverride && page.fullUrl && isRealFullUrl(page.fullUrl)) {
      return normalizeFullUrl(page.fullUrl);
    }

    const rawUrl = page.url || '';
    if (!serverOverride && isRealFullUrl(rawUrl)) {
      return normalizeFullUrl(rawUrl);
    }

    const host = (serverOverride || cdnOrigin || fallbackServers[0] || '').replace(/\/+$/, '');
    if (!host) return '';

    if (rawUrl) {
      let path = rawUrl;
      if (isRealFullUrl(rawUrl)) {
        try {
          path = new URL(normalizeFullUrl(rawUrl)).pathname;
        } catch (_) {}
      }
      if (singleSlash) {
        return host + '/' + path.replace(/^\/+/, '');
      }
      return host + (path.startsWith('/') ? path : '/' + path);
    }

    if (page.image) {
      return host + '/' + page.image.replace(/^\/+/, '');
    }
    return '';
  }

  function getMangaLibAuthToken() {
    try {
      const raw = localStorage.getItem('auth');
      if (!raw) return '';
      const parsed = JSON.parse(raw);
      return parsed?.token?.access_token || parsed?.access_token || '';
    } catch (_) {
      return '';
    }
  }

  function detectCdnFromBrowser() {
    const nativeImgs = getNativeReaderImages();
    for (const img of nativeImgs) {
      const src = img.currentSrc || img.src || '';
      if (!isRealFullUrl(src)) continue;
      if (img.complete && img.naturalWidth > 100) {
        try {
          const origin = new URL(normalizeFullUrl(src)).origin;
          if (origin && origin !== location.origin) {
            cdnOrigin = origin;
            if (!fallbackServers.includes(origin)) fallbackServers.unshift(origin);
            return origin;
          }
        } catch (_) {}
      }
    }

    // Проверяем также журнал загруженных ресурсов браузера (без модификации fetch/XHR)
    try {
      const entries = performance.getEntriesByType('resource');
      for (let i = entries.length - 1; i >= 0; i--) {
        const name = entries[i].name || '';
        if (/\/manga\/.+\.(jpe?g|png|webp|avif|gif)/i.test(name) || /imgslib|mixlib|cdnlibs/i.test(name)) {
          if (/\.(jpe?g|png|webp|avif|gif)(\?|$)/i.test(name)) {
            const origin = new URL(name).origin;
            if (origin && origin !== location.origin) {
              cdnOrigin = origin;
              if (!fallbackServers.includes(origin)) fallbackServers.unshift(origin);
              return origin;
            }
          }
        }
      }
    } catch (_) {}

    return cdnOrigin;
  }

  function findChapterApiUrlFromPerformance(route) {
    try {
      const entries = performance.getEntriesByType('resource');
      for (let i = entries.length - 1; i >= 0; i--) {
        const name = entries[i].name || '';
        if (!name.includes('/api/manga/') || !name.includes('/chapter')) continue;
        if (name.includes(`number=${encodeURIComponent(route.number)}`) || name.includes(`number=${route.number}`)) {
          return name;
        }
      }
    } catch (_) {}
    return '';
  }

  async function loadChapterFromApi() {
    const route = parseChapterRoute();
    if (!route) return;
    if (pagesFromApi && chapterKey === route.key && chapterPages.length > 0) return;
    if (apiFetchInFlightFor === route.key) return;
    apiFetchInFlightFor = route.key;

    const search = new URLSearchParams(location.search);
    const branchId = search.get('bid') || search.get('branch_id') || '';
    const qs = new URLSearchParams({ number: route.number, volume: route.volume });
    if (branchId) qs.set('branch_id', branchId);

    const perfUrl = findChapterApiUrlFromPerformance(route);
    const candidateUrls = Array.from(new Set([
      perfUrl,
      `https://api.cdnlibs.org/api/manga/${encodeURIComponent(route.slug)}/chapter?${qs.toString()}`,
      `${location.origin}/api/manga/${encodeURIComponent(route.slug)}/chapter?${qs.toString()}`
    ].filter(Boolean)));

    const headers = { Accept: 'application/json', 'Site-Id': '1' };
    const token = getMangaLibAuthToken();
    if (token) headers.Authorization = `Bearer ${token}`;

    for (const url of candidateUrls) {
      try {
        const res = await fetch(url, { headers, credentials: 'omit' });
        if (!res.ok) continue;
        const json = await res.json();
        const data = json?.data || json;
        if (!data || !Array.isArray(data.pages) || !data.pages.length) continue;

        // Проверяем, что пользователь ещё на той же главе
        const nowRoute = parseChapterRoute();
        if (!nowRoute || nowRoute.key !== route.key) return;

        applyPagesList(data.pages, route.key, true);
        return;
      } catch (_) {}
    }

    // Если API не ответил — пробуем ещё раз чуть позже (если пользователь остался на главе)
    if (apiFetchInFlightFor === route.key) {
      apiFetchInFlightFor = '';
    }
  }

  function applyPagesList(rawPages, key, fromApi) {
    const isSame = key === chapterKey && pagesFromApi === fromApi && chapterPages.length === rawPages.length;
    chapterKey = key;
    pagesFromApi = fromApi;

    chapterPages = rawPages.map((p, idx) => {
      const u = p.url || '';
      return {
        index: idx,
        url: u,
        image: p.image || '',
        fullUrl: isRealFullUrl(u) ? normalizeFullUrl(u) : (p.fullUrl || ''),
        width: Number(p.width) || 0,
        height: Number(p.height) || 0
      };
    });

    if (!isSame) {
      const groups = computeSpreadGroups(chapterPages);
      if (openAtLastSpread) {
        currentSpreadIndex = Math.max(0, groups.length - 1);
        openAtLastSpread = false;
      } else {
        const pParam = Number(new URLSearchParams(location.search).get('p'));
        if (pParam > 1) {
          const found = groups.findIndex(g => g.pages.includes(pParam - 1));
          currentSpreadIndex = found >= 0 ? found : 0;
        } else {
          currentSpreadIndex = 0;
        }
      }
      lastSpreadChangeAt = Date.now();
    }

    scheduleRender();
  }

  // =========================================================================
  // 2. СТИЛИ (НАТИВНОЕ МЕНЮ + ИНТЕРАКТИВНАЯ 3D-КНИГА + ЧИСТЫЙ ЭКРАН)
  // =========================================================================

  const STYLES = `
    html.ml-duo-active,
    html.ml-duo-active body {
      overflow: hidden !important;
      height: 100% !important;
      overscroll-behavior: none !important;
    }

    /* Чистый экран: прячем и показываем родные панели MangaLib */
    [data-ml-duo-chrome="top"],
    [data-ml-duo-chrome="bottom"] {
      z-index: 60 !important;
      transition: opacity 0.18s ease, transform 0.18s ease !important;
    }

    html.ml-duo-ui-hidden [data-ml-duo-chrome="top"] {
      opacity: 0 !important;
      pointer-events: none !important;
      transform: translateY(-100%) !important;
    }

    html.ml-duo-ui-hidden [data-ml-duo-chrome="bottom"] {
      opacity: 0 !important;
      pointer-events: none !important;
      transform: translateY(100%) !important;
    }

    /* Аккуратное скрытие штатной ленты (без удаления узлов React/Vue) */
    .ml-duo-native-masked {
      visibility: hidden !important;
      pointer-events: none !important;
      max-height: 100vh !important;
      overflow: hidden !important;
    }

    /* --- СЦЕНА ИНТЕРАКТИВНОЙ КНИГИ --- */
    #ml-duo-stage {
      position: fixed;
      inset: 0;
      width: 100vw;
      height: 100vh;
      z-index: 15;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      user-select: none;
      -webkit-user-select: none;
      touch-action: none;
      cursor: grab;
      background: var(--ml-duo-bg, #141414);
    }

    #ml-duo-stage.is-dragging {
      cursor: grabbing;
    }

    .ml-duo-viewport {
      position: relative;
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      perspective: 2400px;
      perspective-origin: 50% 50%;
    }

    .ml-duo-spread {
      position: relative;
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      transform-style: preserve-3d;
      will-change: transform;
    }

    .ml-duo-slot {
      position: relative;
      width: 50%;
      height: 100%;
      display: flex;
      align-items: center;
      min-width: 0;
      box-sizing: border-box;
    }

    .ml-duo-slot.is-left  { justify-content: flex-end; }
    .ml-duo-slot.is-right { justify-content: flex-start; }

    .ml-duo-solo-slot {
      position: relative;
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .ml-duo-sheet {
      position: relative;
      display: inline-flex;
      max-width: 100%;
      max-height: 100%;
      overflow: hidden;
    }

    .ml-duo-sheet > img {
      display: block;
      max-height: 100vh;
      width: auto;
      height: auto;
      object-fit: contain;
      pointer-events: none;
      -webkit-user-drag: none;
    }

    .ml-duo-slot .ml-duo-sheet > img      { max-width: 50vw; }
    .ml-duo-solo-slot .ml-duo-sheet > img { max-width: 100vw; }

    /* Тень сгиба у корешка книги */
    #ml-duo-stage.ml-book-fx .ml-duo-sheet.is-left-page::after {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
      background: linear-gradient(
        to left,
        rgba(0, 0, 0, 0.30) 0%,
        rgba(0, 0, 0, 0.10) 10px,
        transparent 34px
      );
    }

    #ml-duo-stage.ml-book-fx .ml-duo-sheet.is-right-page::after {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
      background: linear-gradient(
        to right,
        rgba(0, 0, 0, 0.30) 0%,
        rgba(0, 0, 0, 0.10) 10px,
        transparent 34px
      );
    }

    /* 3D-лист, который тянет пользователь пальцем или мышкой */
    .ml-duo-flipper {
      position: absolute;
      top: 0;
      height: 100%;
      width: 50%;
      transform-style: preserve-3d;
      z-index: 6;
      pointer-events: none;
      will-change: transform;
    }

    .ml-duo-flipper.turn-l2r {
      left: 0;
      transform-origin: right center;
    }

    .ml-duo-flipper.turn-r2l {
      left: 50%;
      transform-origin: left center;
    }

    .ml-duo-face {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      backface-visibility: hidden;
      -webkit-backface-visibility: hidden;
    }

    .ml-duo-flipper.turn-l2r .ml-duo-face.is-front { justify-content: flex-end; }
    .ml-duo-flipper.turn-l2r .ml-duo-face.is-back  { justify-content: flex-start; transform: rotateY(180deg); }
    .ml-duo-flipper.turn-r2l .ml-duo-face.is-front { justify-content: flex-start; }
    .ml-duo-flipper.turn-r2l .ml-duo-face.is-back  { justify-content: flex-end; transform: rotateY(180deg); }

    .ml-duo-shade,
    .ml-duo-under {
      position: absolute;
      inset: 0;
      pointer-events: none;
      background: #000;
      opacity: 0;
    }

    .ml-duo-under { z-index: 2; }

    /* Блик бумажного края на переворачиваемом листе */
    .ml-duo-face .ml-duo-sheet {
      box-shadow: 0 0 28px rgba(0, 0, 0, 0.42);
    }

    /* --- НАТИВНАЯ СЕКЦИЯ НАСТРОЕК ВНУТРИ ПАНЕЛИ MANGALIB --- */
    #ml-duo-settings-section,
    [data-ml-duo-settings="1"] {
      margin-top: 14px;
      padding-top: 14px;
      border-top: 1px solid rgba(128, 128, 128, 0.22);
      font-family: inherit;
      font-size: 14px;
      color: inherit;
    }

    .ml-duo-sec-title {
      font-size: 13px;
      font-weight: 600;
      opacity: 0.72;
      margin-bottom: 8px;
    }

    .ml-duo-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      min-height: 34px;
      padding: 4px 0;
    }

    .ml-duo-col {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 6px 0;
    }

    .ml-duo-label {
      font-size: 14px;
      line-height: 1.3;
    }

    .ml-duo-hint {
      font-size: 11px;
      opacity: 0.55;
      margin-left: 6px;
    }

    .ml-duo-switch {
      position: relative;
      display: inline-block;
      width: 36px;
      height: 20px;
      flex-shrink: 0;
      cursor: pointer;
    }

    .ml-duo-switch input {
      position: absolute;
      opacity: 0;
      width: 0;
      height: 0;
    }

    .ml-duo-slider {
      position: absolute;
      inset: 0;
      border-radius: 999px;
      background: rgba(128, 128, 128, 0.35);
      transition: background 0.18s ease;
    }

    .ml-duo-slider::before {
      content: "";
      position: absolute;
      width: 14px;
      height: 14px;
      left: 3px;
      top: 3px;
      border-radius: 50%;
      background: #fff;
      transition: transform 0.18s ease;
    }

    .ml-duo-switch input:checked + .ml-duo-slider { background: #f59e0b; }
    .ml-duo-switch input:checked + .ml-duo-slider::before { transform: translateX(16px); }

    .ml-duo-seg {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 4px;
      padding: 2px;
      border-radius: 6px;
      background: rgba(128, 128, 128, 0.14);
    }

    .ml-duo-seg-btn {
      border: none;
      background: transparent;
      color: inherit;
      font: inherit;
      font-size: 13px;
      padding: 5px 8px;
      border-radius: 4px;
      cursor: pointer;
      opacity: 0.78;
    }

    .ml-duo-seg-btn.is-active {
      background: rgba(128, 128, 128, 0.28);
      opacity: 1;
      font-weight: 600;
    }

    .ml-duo-disabled {
      opacity: 0.42;
      pointer-events: none;
    }

    #ml-duo-fallback-backdrop {
      position: fixed;
      inset: 0;
      z-index: 999999;
      background: rgba(0, 0, 0, 0.55);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
    }

    #ml-duo-fallback-modal {
      width: 100%;
      max-width: 360px;
      background: #1c1c1f;
      color: #f4f4f5;
      border-radius: 10px;
      padding: 16px;
      border: 1px solid rgba(255, 255, 255, 0.1);
    }

    .ml-duo-modal-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-weight: 600;
      font-size: 15px;
    }

    .ml-duo-modal-close {
      background: transparent;
      border: none;
      color: inherit;
      font-size: 20px;
      line-height: 1;
      cursor: pointer;
      opacity: 0.7;
    }
  `;

  function injectStyles() {
    try {
      if (typeof GM_addStyle === 'function') {
        GM_addStyle(STYLES);
        return;
      }
    } catch (_) {}
    const style = document.createElement('style');
    style.textContent = STYLES;
    (document.head || document.documentElement).appendChild(style);
  }

  // =========================================================================
  // 3. ЧИСТЫЙ ЭКРАН И ПОЛНОЭКРАННЫЙ РЕЖИМ
  // =========================================================================

  function isFullscreen() {
    return Boolean(document.fullscreenElement || document.webkitFullscreenElement);
  }

  function toggleFullscreen() {
    if (isFullscreen()) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) Promise.resolve(exit.call(document)).catch(() => {});
    } else {
      const el = document.documentElement;
      const req = el.requestFullscreen || el.webkitRequestFullscreen;
      if (req) Promise.resolve(req.call(el)).catch(() => {});
    }
  }

  function tagNativeReaderChrome() {
    if (!isReaderPage()) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const candidates = document.querySelectorAll('header, footer, nav, body > div div');
    for (const el of candidates) {
      if (
        el.id === 'ml-duo-stage' ||
        el.closest('#ml-duo-stage, #ml-duo-fallback-backdrop, [role="dialog"], [class*="modal"], [class*="drawer"], [class*="popup"], [class*="popover"]')
      ) {
        continue;
      }
      if (el.dataset.mlDuoChrome) continue;

      const style = getComputedStyle(el);
      if (style.position !== 'fixed' && style.position !== 'sticky') continue;

      const rect = el.getBoundingClientRect();
      if (rect.width < vw * 0.45 || rect.height < 28 || rect.height > 140) continue;

      if (rect.top <= 12) {
        el.dataset.mlDuoChrome = 'top';
      } else if (rect.bottom >= vh - 12) {
        el.dataset.mlDuoChrome = 'bottom';
      }
    }
  }

  function applyCleanScreenState(hidden) {
    uiHidden = Boolean(hidden);
    if (!isReaderPage() || !settings.enabled) {
      document.documentElement.classList.remove('ml-duo-ui-hidden');
      return;
    }
    tagNativeReaderChrome();
    document.documentElement.classList.toggle('ml-duo-ui-hidden', uiHidden);
  }

  function toggleReaderChrome() {
    applyCleanScreenState(!uiHidden);
  }

  // =========================================================================
  // 4. ПОИСК КАРТИНОК И РАЗБИЕНИЕ НА РАЗВОРОТЫ
  // =========================================================================

  function isLikelyMangaImage(img) {
    if (!img || img.closest('#ml-duo-stage, #ml-duo-settings-section, #ml-duo-fallback-backdrop')) return false;
    if (img.closest('header, nav, footer, [role="dialog"]')) return false;
    const src = img.currentSrc || img.src || img.getAttribute('data-src') || '';
    if (!src) return false;
    if (/avatar|logo|icon|emoji|sticker|badge|cover/i.test(src) && !/\/chapters?\//i.test(src)) return false;
    if (img.closest('[data-p], [data-page], [data-media-id]')) return true;
    if (/\/chapters?\/|imgslib|cdnlibs|mixlib/i.test(src)) return true;
    return img.naturalWidth >= 350 || img.clientWidth >= 300;
  }

  function getNativeReaderImages() {
    const root = document.querySelector('main') || document.body;
    if (!root) return [];
    return Array.from(root.querySelectorAll('img')).filter(isLikelyMangaImage);
  }

  function findNativeContainer(images) {
    if (!images.length) return null;
    if (images.length === 1) {
      const p = images[0].closest('[data-p], [data-page]')?.parentElement || images[0].parentElement;
      if (p && p !== document.body && p.id !== 'app' && p.id !== 'root') return p;
      return null;
    }

    const getAncestors = (el) => {
      const list = [];
      let cur = el.parentElement;
      while (cur && cur !== document.body && cur.id !== 'app' && cur.id !== 'root') {
        list.push(cur);
        cur = cur.parentElement;
      }
      return list;
    };

    const firstAncestors = getAncestors(images[0]);
    for (const candidate of firstAncestors) {
      if (images.every(el => candidate.contains(el))) {
        return candidate;
      }
    }
    return null;
  }

  function collectDomPagesFallback(nativeImgs) {
    if (pagesFromApi || nativeImgs.length < 2) return;
    const route = parseChapterRoute();
    const key = route ? route.key : 'dom';
    const list = nativeImgs
      .map(img => ({
        url: img.currentSrc || img.src || img.getAttribute('data-src') || '',
        image: '',
        width: img.naturalWidth || 0,
        height: img.naturalHeight || 0
      }))
      .filter(p => isRealFullUrl(p.url));

    if (list.length >= 2) {
      applyPagesList(list, key, false);
    }
  }

  function isWidePage(meta) {
    if (!settings.autoWide || !meta) return false;
    return meta.width > 0 && meta.height > 0 && meta.width > meta.height * 1.15;
  }

  function computeSpreadGroups(pages) {
    const groups = [];
    let current = [];

    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      const isCover = settings.coverAlone && i === 0;
      const isWide = isWidePage(p);

      if (isCover || isWide) {
        if (current.length) {
          groups.push({ pages: current, solo: false });
          current = [];
        }
        groups.push({ pages: [i], solo: true });
      } else {
        current.push(i);
        if (current.length === 2) {
          groups.push({ pages: current, solo: false });
          current = [];
        }
      }
    }

    if (current.length) groups.push({ pages: current, solo: false });
    return groups;
  }

  function mapGroupToSlots(group) {
    if (!group) return { left: null, right: null, solo: null };
    if (group.solo) {
      return { left: null, right: null, solo: chapterPages[group.pages[0]] || null };
    }
    const p1 = chapterPages[group.pages[0]] || null;
    const p2 = chapterPages[group.pages[1]] || null;
    return settings.firstPageSide === 'right'
      ? { left: p2, right: p1, solo: null }
      : { left: p1, right: p2, solo: null };
  }

  // =========================================================================
  // 5. ОТРИСОВКА ЛИСТОВ И ИНТЕРАКТИВНОЕ 3D-ПЕРЕЛИСТЫВАНИЕ (ПАЛЕЦ / МЫШЬ)
  // =========================================================================

  function createPageSheet(pageMeta, sideClass) {
    if (!pageMeta) return null;
    const url = buildImageUrl(pageMeta);
    if (!url) return null;

    const sheet = document.createElement('div');
    sheet.className = `ml-duo-sheet ${sideClass}`;

    const img = document.createElement('img');
    img.referrerPolicy = 'strict-origin-when-cross-origin';
    img.src = url;
    img.alt = '';
    img.draggable = false;

    // Умный перебор (одинарный слеш + резервные серверы), чтобы никогда не было [?]
    const attempts = [];
    const primarySingle = buildImageUrl(pageMeta, '', true);
    if (primarySingle && primarySingle !== url) attempts.push({ u: primarySingle, s: cdnOrigin });
    for (const srv of fallbackServers) {
      const u1 = buildImageUrl(pageMeta, srv, false);
      const u2 = buildImageUrl(pageMeta, srv, true);
      if (u1 && u1 !== url) attempts.push({ u: u1, s: srv });
      if (u2 && u2 !== url && u2 !== u1) attempts.push({ u: u2, s: srv });
    }
    let attemptIdx = 0;

    img.addEventListener('error', () => {
      if (attemptIdx < attempts.length) {
        const next = attempts[attemptIdx++];
        img.src = next.u;
        img.dataset.mlTryServer = next.s || '';
      }
    });

    img.addEventListener('load', () => {
      if (img.dataset.mlTryServer) {
        cdnOrigin = img.dataset.mlTryServer;
      }
      if (!pageMeta.width || !pageMeta.height) {
        const wasWide = isWidePage(pageMeta);
        pageMeta.width = img.naturalWidth;
        pageMeta.height = img.naturalHeight;
        if (settings.autoWide && !wasWide && isWidePage(pageMeta) && !drag.isDragging) {
          renderStaticCurrentSpread();
        }
      }
    }, { once: true });

    sheet.appendChild(img);
    return sheet;
  }

  function preloadSpread(groups, idx) {
    const g = groups[idx];
    if (!g) return;
    for (const pageIdx of g.pages) {
      const meta = chapterPages[pageIdx];
      const url = buildImageUrl(meta);
      if (!url || meta._preloaded) continue;
      meta._preloaded = true;
      const pre = new Image();
      pre.referrerPolicy = 'strict-origin-when-cross-origin';
      pre.onload = () => {
        if (!meta.width || !meta.height) {
          meta.width = pre.naturalWidth;
          meta.height = pre.naturalHeight;
        }
      };
      pre.src = url;
    }
  }

  function renderStaticSpreadInto(spreadEl, slots) {
    spreadEl.style.transition = '';
    spreadEl.style.transform = '';
    spreadEl.innerHTML = '';

    if (slots.solo) {
      const wrap = document.createElement('div');
      wrap.className = 'ml-duo-solo-slot';
      const sheet = createPageSheet(slots.solo, 'is-solo-page');
      if (sheet) wrap.appendChild(sheet);
      spreadEl.appendChild(wrap);
      return;
    }

    const leftSlot = document.createElement('div');
    leftSlot.className = 'ml-duo-slot is-left';
    const leftSheet = createPageSheet(slots.left, 'is-left-page');
    if (leftSheet) leftSlot.appendChild(leftSheet);

    const rightSlot = document.createElement('div');
    rightSlot.className = 'ml-duo-slot is-right';
    const rightSheet = createPageSheet(slots.right, 'is-right-page');
    if (rightSheet) rightSlot.appendChild(rightSheet);

    spreadEl.appendChild(leftSlot);
    spreadEl.appendChild(rightSlot);
  }

  function renderStaticCurrentSpread() {
    const stage = document.getElementById('ml-duo-stage');
    if (!stage || !chapterPages.length) return;
    const groups = computeSpreadGroups(chapterPages);
    if (!groups.length) return;

    currentSpreadIndex = Math.max(0, Math.min(currentSpreadIndex, groups.length - 1));
    stage.classList.toggle('ml-book-fx', settings.flipAnimation);

    const spreadEl = stage.querySelector('.ml-duo-spread');
    const group = groups[currentSpreadIndex];
    renderStaticSpreadInto(spreadEl, mapGroupToSlots(group));

    // Обновляем параметр ?p= в адресной строке
    try {
      const firstPageNum = group.pages[0] + 1;
      const u = new URL(location.href);
      if (u.searchParams.get('p') !== String(firstPageNum)) {
        u.searchParams.set('p', String(firstPageNum));
        window.history.replaceState(window.history.state, '', u.toString());
        currentUrl = u.toString();
      }
    } catch (_) {}

    preloadSpread(groups, currentSpreadIndex + 1);
    preloadSpread(groups, currentSpreadIndex + 2);
    preloadSpread(groups, currentSpreadIndex - 1);
  }

  // Строит сцену для живого 3D-перелистывания (управляемого прогрессом p от 0 до 1)
  function buildInteractiveFlipDOM(spreadEl, oldSlots, newSlots, turnDir) {
    spreadEl.style.transition = '';
    spreadEl.style.transform = '';
    spreadEl.innerHTML = '';

    // 1. Левая базовая страница (под листом)
    const leftSlot = document.createElement('div');
    leftSlot.className = 'ml-duo-slot is-left';
    const baseLeftSheet = createPageSheet(turnDir === 'l2r' ? newSlots.left : oldSlots.left, 'is-left-page');
    let leftUnder = null;
    if (baseLeftSheet) {
      leftUnder = document.createElement('div');
      leftUnder.className = 'ml-duo-under';
      baseLeftSheet.appendChild(leftUnder);
      leftSlot.appendChild(baseLeftSheet);
    }

    // 2. Правая базовая страница (под листом)
    const rightSlot = document.createElement('div');
    rightSlot.className = 'ml-duo-slot is-right';
    const baseRightSheet = createPageSheet(turnDir === 'l2r' ? oldSlots.right : newSlots.right, 'is-right-page');
    let rightUnder = null;
    if (baseRightSheet) {
      rightUnder = document.createElement('div');
      rightUnder.className = 'ml-duo-under';
      baseRightSheet.appendChild(rightUnder);
      rightSlot.appendChild(baseRightSheet);
    }

    // 3. Переворачиваемый 3D-лист (лицевая + оборотная стороны)
    const flipper = document.createElement('div');
    flipper.className = `ml-duo-flipper ${turnDir === 'l2r' ? 'turn-l2r' : 'turn-r2l'}`;

    const frontFace = document.createElement('div');
    frontFace.className = 'ml-duo-face is-front';
    const frontSheet = createPageSheet(
      turnDir === 'l2r' ? oldSlots.left : oldSlots.right,
      turnDir === 'l2r' ? 'is-left-page' : 'is-right-page'
    );
    let frontShade = null;
    if (frontSheet) {
      frontShade = document.createElement('div');
      frontShade.className = 'ml-duo-shade';
      frontSheet.appendChild(frontShade);
      frontFace.appendChild(frontSheet);
    }

    const backFace = document.createElement('div');
    backFace.className = 'ml-duo-face is-back';
    const backSheet = createPageSheet(
      turnDir === 'l2r' ? newSlots.right : newSlots.left,
      turnDir === 'l2r' ? 'is-right-page' : 'is-left-page'
    );
    let backShade = null;
    if (backSheet) {
      backShade = document.createElement('div');
      backShade.className = 'ml-duo-shade';
      backSheet.appendChild(backShade);
      backFace.appendChild(backSheet);
    }

    flipper.appendChild(frontFace);
    flipper.appendChild(backFace);

    spreadEl.appendChild(leftSlot);
    spreadEl.appendChild(rightSlot);
    spreadEl.appendChild(flipper);

    return { spreadEl, flipper, frontShade, backShade, leftUnder, rightUnder, turnDir };
  }

  // Применяет угол поворота и тени для конкретного прогресса p (0..1)
  function setFlipProgress(nodes, p, withTransitionMs = 0) {
    if (!nodes) return;
    const clamped = Math.max(0, Math.min(1, p));
    const angle = nodes.turnDir === 'l2r' ? clamped * 180 : -clamped * 180;
    const tr = withTransitionMs > 0 ? `transform ${withTransitionMs}ms cubic-bezier(0.22, 1, 0.36, 1)` : 'none';
    const opTr = withTransitionMs > 0 ? `opacity ${withTransitionMs}ms ease` : 'none';

    nodes.flipper.style.transition = tr;
    nodes.flipper.style.transform = `rotateY(${angle.toFixed(2)}deg)`;

    const midShade = Math.sin(clamped * Math.PI) * 0.42;
    if (nodes.frontShade) {
      nodes.frontShade.style.transition = opTr;
      nodes.frontShade.style.opacity = String(Math.min(0.55, midShade + clamped * 0.12).toFixed(3));
    }
    if (nodes.backShade) {
      nodes.backShade.style.transition = opTr;
      nodes.backShade.style.opacity = String(Math.min(0.55, midShade + (1 - clamped) * 0.12).toFixed(3));
    }

    const revealOpacity = (1 - clamped) * 0.45;
    const coverOpacity = clamped * 0.45;
    if (nodes.leftUnder) {
      nodes.leftUnder.style.transition = opTr;
      nodes.leftUnder.style.opacity = String((nodes.turnDir === 'l2r' ? revealOpacity : coverOpacity).toFixed(3));
    }
    if (nodes.rightUnder) {
      nodes.rightUnder.style.transition = opTr;
      nodes.rightUnder.style.opacity = String((nodes.turnDir === 'l2r' ? coverOpacity : revealOpacity).toFixed(3));
    }
  }

  // Анимация полного переворота по клику или клавише (0 -> 1)
  function animateTurnToSpread(delta) {
    if (!chapterPages.length) {
      loadChapterFromApi();
      return;
    }

    const groups = computeSpreadGroups(chapterPages);
    if (!groups.length) return;

    if (isAnimatingFinish) {
      clearTimeout(animTimer);
      isAnimatingFinish = false;
      renderStaticCurrentSpread();
    }

    const nextIdx = currentSpreadIndex + delta;
    if (nextIdx >= groups.length || nextIdx < 0) {
      if (!pagesFromApi && chapterPages.length < 2) {
        loadChapterFromApi();
        return;
      }
      if (Date.now() - lastSpreadChangeAt < 300) return;
      goToAdjacentChapter(nextIdx >= groups.length ? 1 : -1);
      return;
    }

    const stage = document.getElementById('ml-duo-stage');
    if (!stage) return;
    const spreadEl = stage.querySelector('.ml-duo-spread');

    const oldGroup = groups[currentSpreadIndex];
    const newGroup = groups[nextIdx];
    const turnDir = (settings.firstPageSide === 'right')
      ? (delta > 0 ? 'l2r' : 'r2l')
      : (delta > 0 ? 'r2l' : 'l2r');

    currentSpreadIndex = nextIdx;
    lastSpreadChangeAt = Date.now();

    if (settings.flipAnimation && !oldGroup.solo && !newGroup.solo) {
      const nodes = buildInteractiveFlipDOM(
        spreadEl,
        mapGroupToSlots(oldGroup),
        mapGroupToSlots(newGroup),
        turnDir
      );
      setFlipProgress(nodes, 0, 0);
      // Принудительный reflow перед запуском плавного переворота
      void nodes.flipper.offsetWidth;
      isAnimatingFinish = true;
      setFlipProgress(nodes, 1, 380);
      animTimer = setTimeout(() => {
        isAnimatingFinish = false;
        renderStaticCurrentSpread();
      }, 395);
    } else {
      // Мягкий боковой сдвиг для одиночных широких сканов или при выключенном 3D
      renderStaticCurrentSpread();
      spreadEl.style.transition = 'none';
      spreadEl.style.transform = `translateX(${turnDir === 'l2r' ? '-36px' : '36px'})`;
      void spreadEl.offsetWidth;
      spreadEl.style.transition = 'transform 200ms cubic-bezier(0.22, 1, 0.36, 1)';
      spreadEl.style.transform = 'translateX(0)';
    }
  }

  // --- Интерактивное управление жестом перелистывания (Pointer Events) ---
  function onStagePointerDown(e) {
    if (isAnyModalOpen()) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (drag.active) return;

    e.stopPropagation();

    if (isAnimatingFinish) {
      clearTimeout(animTimer);
      isAnimatingFinish = false;
      renderStaticCurrentSpread();
    }

    const vw = window.innerWidth || 1;
    drag.active = true;
    drag.pointerId = e.pointerId;
    drag.isDragging = false;
    drag.startX = e.clientX;
    drag.startY = e.clientY;
    drag.lastX = e.clientX;
    drag.lastTime = performance.now();
    drag.vx = 0;
    drag.progress = 0;
    drag.nodes = null;
    drag.side = e.clientX < vw * 0.5 ? 'left' : 'right';

    window.addEventListener('pointermove', onWindowPointerMove, { passive: false });
    window.addEventListener('pointerup', onWindowPointerUp);
    window.addEventListener('pointercancel', onWindowPointerCancel);
  }

  function startInteractiveDrag(dx) {
    const groups = computeSpreadGroups(chapterPages);
    if (!groups.length) return false;

    const stage = document.getElementById('ml-duo-stage');
    if (!stage) return false;
    const spreadEl = stage.querySelector('.ml-duo-spread');

    // Направление физического движения пальца/мыши:
    // Тянем вправо (dx > 0) -> перекидываем ЛЕВЫЙ лист направо (l2r)
    // Тянем влево (dx < 0)  -> перекидываем ПРАВЫЙ лист налево (r2l)
    drag.turnDir = dx > 0 ? 'l2r' : 'r2l';

    // Какой это шаг по страницам в зависимости от направления чтения (манга RTL или комикс LTR)
    if (settings.rtlNav) {
      drag.stepDelta = drag.turnDir === 'l2r' ? 1 : -1;
    } else {
      drag.stepDelta = drag.turnDir === 'r2l' ? 1 : -1;
    }

    drag.targetIndex = currentSpreadIndex + drag.stepDelta;
    drag.isBoundary = drag.targetIndex < 0 || drag.targetIndex >= groups.length;

    const oldGroup = groups[currentSpreadIndex];
    const newGroup = !drag.isBoundary ? groups[drag.targetIndex] : null;

    drag.is3D = settings.flipAnimation && !drag.isBoundary && !oldGroup.solo && newGroup && !newGroup.solo;
    drag.isDragging = true;
    stage.classList.add('is-dragging');

    if (drag.is3D) {
      drag.nodes = buildInteractiveFlipDOM(
        spreadEl,
        mapGroupToSlots(oldGroup),
        mapGroupToSlots(newGroup),
        drag.turnDir
      );
      setFlipProgress(drag.nodes, 0, 0);
    } else {
      drag.nodes = { spreadEl };
    }
    return true;
  }

  function onWindowPointerMove(e) {
    if (!drag.active || e.pointerId !== drag.pointerId) return;

    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    const now = performance.now();
    const dt = Math.max(1, now - drag.lastTime);
    drag.vx = (e.clientX - drag.lastX) / dt;
    drag.lastX = e.clientX;
    drag.lastTime = now;

    if (!drag.isDragging) {
      if (Math.hypot(dx, dy) < 8) return;
      if (Math.abs(dy) > Math.abs(dx) * 1.4) {
        cleanupDragListeners();
        drag.active = false;
        return;
      }
      if (!startInteractiveDrag(dx)) {
        cleanupDragListeners();
        drag.active = false;
        return;
      }
    }

    e.preventDefault();

    const vw = window.innerWidth || 1;
    // Дистанция полного переворота ~60% ширины экрана — удобно и на большом мониторе, и на планшете
    const signedDx = drag.turnDir === 'l2r' ? dx : -dx;
    const rawProgress = Math.max(0, Math.min(1, signedDx / (vw * 0.6)));
    drag.progress = rawProgress;

    if (drag.is3D && drag.nodes) {
      setFlipProgress(drag.nodes, rawProgress, 0);
    } else if (drag.nodes?.spreadEl) {
      const resist = drag.isBoundary ? 0.25 : 0.65;
      drag.nodes.spreadEl.style.transition = 'none';
      drag.nodes.spreadEl.style.transform = `translateX(${(dx * resist).toFixed(1)}px)`;
    }
  }

  function finishInteractiveDrag(cancelled = false) {
    const stage = document.getElementById('ml-duo-stage');
    if (stage) stage.classList.remove('is-dragging');

    // Если палец/мышь почти не двигались — обрабатываем как обычный клик/тап
    if (!drag.isDragging) {
      if (!cancelled) {
        const vw = window.innerWidth || 1;
        const ratio = drag.startX / vw;
        if (ratio < 0.35) {
          animateTurnToSpread(settings.rtlNav ? 1 : -1);
        } else if (ratio > 0.65) {
          animateTurnToSpread(settings.rtlNav ? -1 : 1);
        } else {
          toggleReaderChrome();
        }
      }
      return;
    }

    // Проверяем, дотянул ли пользователь страницу или сделал быстрый смах
    const directedVel = drag.turnDir === 'l2r' ? drag.vx : -drag.vx;
    const shouldCommit = !cancelled && (
      drag.progress > 0.28 ||
      (directedVel > 0.35 && drag.progress > 0.06)
    );

    if (drag.isBoundary) {
      // Возвращаем сдвиг и при уверенном жесте переходим на соседнюю главу
      if (drag.nodes?.spreadEl) {
        drag.nodes.spreadEl.style.transition = 'transform 180ms ease';
        drag.nodes.spreadEl.style.transform = 'translateX(0)';
      }
      if (shouldCommit && (pagesFromApi || chapterPages.length >= 2)) {
        goToAdjacentChapter(drag.stepDelta);
      }
      return;
    }

    if (drag.is3D && drag.nodes) {
      const nodes = drag.nodes;
      const targetP = shouldCommit ? 1 : 0;
      const dist = Math.abs(targetP - drag.progress);
      const duration = Math.max(120, Math.min(340, Math.round(dist * 360)));

      if (shouldCommit) {
        currentSpreadIndex = drag.targetIndex;
        lastSpreadChangeAt = Date.now();
      }

      isAnimatingFinish = true;
      setFlipProgress(nodes, targetP, duration);
      animTimer = setTimeout(() => {
        isAnimatingFinish = false;
        renderStaticCurrentSpread();
      }, duration + 20);
      return;
    }

    // Горизонтальный сдвиг (для одиночных/широких сканов или при выключенном 3D)
    const spreadEl = drag.nodes?.spreadEl;
    if (shouldCommit) {
      currentSpreadIndex = drag.targetIndex;
      lastSpreadChangeAt = Date.now();
      if (spreadEl) {
        const exitX = drag.turnDir === 'l2r' ? '140px' : '-140px';
        spreadEl.style.transition = 'transform 140ms ease-in';
        spreadEl.style.transform = `translateX(${exitX})`;
        isAnimatingFinish = true;
        animTimer = setTimeout(() => {
          isAnimatingFinish = false;
          renderStaticCurrentSpread();
        }, 145);
      } else {
        renderStaticCurrentSpread();
      }
    } else if (spreadEl) {
      spreadEl.style.transition = 'transform 180ms ease';
      spreadEl.style.transform = 'translateX(0)';
    }
  }

  function cleanupDragListeners() {
    window.removeEventListener('pointermove', onWindowPointerMove);
    window.removeEventListener('pointerup', onWindowPointerUp);
    window.removeEventListener('pointercancel', onWindowPointerCancel);
  }

  function onWindowPointerUp(e) {
    if (!drag.active || e.pointerId !== drag.pointerId) return;
    cleanupDragListeners();
    drag.active = false;
    finishInteractiveDrag(false);
  }

  function onWindowPointerCancel(e) {
    if (!drag.active || e.pointerId !== drag.pointerId) return;
    cleanupDragListeners();
    drag.active = false;
    finishInteractiveDrag(true);
  }

  function ensureStage() {
    let stage = document.getElementById('ml-duo-stage');
    if (stage) return stage;

    stage = document.createElement('div');
    stage.id = 'ml-duo-stage';

    // Подстраиваем фон сцены под текущую тему MangaLib
    const bodyBg = getComputedStyle(document.body).backgroundColor;
    if (bodyBg && bodyBg !== 'rgba(0, 0, 0, 0)' && bodyBg !== 'transparent') {
      stage.style.setProperty('--ml-duo-bg', bodyBg);
    }

    stage.innerHTML = `
      <div class="ml-duo-viewport">
        <div class="ml-duo-spread"></div>
      </div>
    `;

    stage.addEventListener('pointerdown', onStagePointerDown);
    // Глушим обычные click, чтобы читалка MangaLib под сценой не перелистывала главы сама
    stage.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    document.body.appendChild(stage);
    return stage;
  }

  // =========================================================================
  // 6. ПЕРЕХОД НА СОСЕДНЮЮ ГЛАВУ И ДИСПЕТЧЕР ОТРИСОВКИ
  // =========================================================================

  function compareChapterOrder(a, b) {
    const va = parseFloat(a.volume) || 0;
    const vb = parseFloat(b.volume) || 0;
    if (va !== vb) return va - vb;
    return (parseFloat(a.number) || 0) - (parseFloat(b.number) || 0);
  }

  function goToAdjacentChapter(direction) {
    const curRoute = parseChapterRoute();
    const links = Array.from(document.querySelectorAll('a[href]')).filter(a => {
      if (a.closest('#ml-duo-stage, #ml-duo-settings-section, #ml-duo-fallback-backdrop')) return false;
      try {
        const u = new URL(a.href, location.origin);
        if (u.pathname === location.pathname) return false;
        const r = parseChapterRoute(u.pathname);
        if (!r) return false;
        if (curRoute && r.slug !== curRoute.slug) return false;
        return true;
      } catch (_) {
        return false;
      }
    });

    const rx = direction > 0 ? /следующ|next|впер[её]д/i : /предыдущ|prev|назад/i;
    let target = links.find(a => rx.test(`${a.textContent || ''} ${a.title || ''} ${a.getAttribute('aria-label') || ''}`));

    if (!target && curRoute) {
      const sorted = links
        .map(a => ({ a, route: parseChapterRoute(new URL(a.href, location.origin).pathname) }))
        .filter(item => item.route && (direction > 0
          ? compareChapterOrder(item.route, curRoute) > 0
          : compareChapterOrder(item.route, curRoute) < 0))
        .sort((x, y) => direction > 0
          ? compareChapterOrder(x.route, y.route)
          : compareChapterOrder(y.route, x.route));

      if (sorted.length) target = sorted[0].a;
    }

    if (target) {
      openAtLastSpread = direction < 0;
      lastSpreadChangeAt = Date.now();
      target.click();
    }
  }

  function restoreNativeContainer() {
    if (hiddenNativeContainer) {
      hiddenNativeContainer.classList.remove('ml-duo-native-masked');
      hiddenNativeContainer = null;
    }
  }

  function cleanupDuoStage() {
    clearTimeout(animTimer);
    cleanupDragListeners();
    drag.active = false;
    drag.isDragging = false;
    isAnimatingFinish = false;

    const stage = document.getElementById('ml-duo-stage');
    if (stage) stage.remove();

    restoreNativeContainer();
    document.documentElement.classList.remove('ml-duo-active', 'ml-duo-ui-hidden');
  }

  function getLayoutSig() {
    return `${chapterKey}|${chapterPages.length}|${cdnOrigin}|${settings.firstPageSide}|${settings.rtlNav}|${settings.flipAnimation}|${settings.coverAlone}|${settings.autoWide}`;
  }

  function applyDuoLayout() {
    if (!isReaderPage() || !settings.enabled) {
      cleanupDuoStage();
      return;
    }

    const nativeImgs = getNativeReaderImages();
    detectCdnFromBrowser();
    collectDomPagesFallback(nativeImgs);

    if (!pagesFromApi) {
      loadChapterFromApi();
    }

    // Не перекрываем сайт, пока не получены страницы и реальный хост картинок (чтобы не было пустого экрана или [?])
    if (!chapterPages.length) return;
    if (!cdnOrigin && !chapterPages[0].fullUrl && !isRealFullUrl(chapterPages[0].url)) {
      return;
    }

    document.documentElement.classList.add('ml-duo-active');
    applyCleanScreenState(uiHidden);

    const nativeContainer = findNativeContainer(nativeImgs);
    if (nativeContainer && nativeContainer !== hiddenNativeContainer) {
      restoreNativeContainer();
      hiddenNativeContainer = nativeContainer;
    }
    if (hiddenNativeContainer) {
      hiddenNativeContainer.classList.add('ml-duo-native-masked');
    }

    const stage = ensureStage();
    const sig = getLayoutSig();
    if (!drag.isDragging && !isAnimatingFinish && (stage.dataset.sig !== sig || !stage.querySelector('.ml-duo-spread')?.children.length)) {
      stage.dataset.sig = sig;
      renderStaticCurrentSpread();
    }
  }

  function scheduleRender() {
    if (renderRaf) cancelAnimationFrame(renderRaf);
    renderRaf = requestAnimationFrame(() => {
      renderRaf = null;
      applyDuoLayout();
    });
  }

  // =========================================================================
  // 7. НАТИВНАЯ СЕКЦИЯ НАСТРОЕК ВНУТРИ МЕНЮ MANGALIB
  // =========================================================================

  function createSettingsSection(suffix = '') {
    const sec = document.createElement('div');
    sec.id = suffix ? `ml-duo-settings-section-${suffix}` : 'ml-duo-settings-section';
    sec.dataset.mlDuoSettings = '1';

    sec.innerHTML = `
      <div class="ml-duo-sec-title">Двустраничный режим (Duo)</div>

      <div class="ml-duo-row">
        <span class="ml-duo-label">Разворот (2 страницы)<span class="ml-duo-hint">Alt+D</span></span>
        <label class="ml-duo-switch">
          <input type="checkbox" data-setting="enabled">
          <span class="ml-duo-slider"></span>
        </label>
      </div>

      <div class="ml-duo-sub">
        <div class="ml-duo-col">
          <span class="ml-duo-label">Первая страница</span>
          <div class="ml-duo-seg">
            <button type="button" class="ml-duo-seg-btn" data-side="right">Справа (манга)</button>
            <button type="button" class="ml-duo-seg-btn" data-side="left">Слева (комикс)</button>
          </div>
        </div>

        <div class="ml-duo-row">
          <span class="ml-duo-label">Листать справа налево</span>
          <label class="ml-duo-switch">
            <input type="checkbox" data-setting="rtlNav">
            <span class="ml-duo-slider"></span>
          </label>
        </div>

        <div class="ml-duo-row">
          <span class="ml-duo-label">Перелистывание книги (3D)</span>
          <label class="ml-duo-switch">
            <input type="checkbox" data-setting="flipAnimation">
            <span class="ml-duo-slider"></span>
          </label>
        </div>

        <div class="ml-duo-row">
          <span class="ml-duo-label">Обложка отдельно<span class="ml-duo-hint">Alt+S</span></span>
          <label class="ml-duo-switch">
            <input type="checkbox" data-setting="coverAlone">
            <span class="ml-duo-slider"></span>
          </label>
        </div>

        <div class="ml-duo-row">
          <span class="ml-duo-label">Широкие сканы целиком</span>
          <label class="ml-duo-switch">
            <input type="checkbox" data-setting="autoWide">
            <span class="ml-duo-slider"></span>
          </label>
        </div>

        <div class="ml-duo-row">
          <span class="ml-duo-label">Скрывать меню при открытии</span>
          <label class="ml-duo-switch">
            <input type="checkbox" data-setting="cleanScreen">
            <span class="ml-duo-slider"></span>
          </label>
        </div>

        <div class="ml-duo-row">
          <span class="ml-duo-label">На весь экран<span class="ml-duo-hint">F</span></span>
          <label class="ml-duo-switch">
            <input type="checkbox" data-action="fullscreen">
            <span class="ml-duo-slider"></span>
          </label>
        </div>
      </div>
    `;

    sec.querySelectorAll('input[data-setting]').forEach(input => {
      input.addEventListener('change', () => {
        saveSettings({ [input.dataset.setting]: input.checked });
      });
    });

    const fsInput = sec.querySelector('input[data-action="fullscreen"]');
    if (fsInput) fsInput.addEventListener('change', toggleFullscreen);

    sec.querySelectorAll('button[data-side]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const side = btn.dataset.side;
        saveSettings({ firstPageSide: side, rtlNav: side === 'right' });
      });
    });

    syncSectionUI(sec);
    return sec;
  }

  function syncSectionUI(sec) {
    sec.querySelectorAll('input[data-setting]').forEach(input => {
      input.checked = Boolean(settings[input.dataset.setting]);
    });

    const fsInput = sec.querySelector('input[data-action="fullscreen"]');
    if (fsInput) fsInput.checked = isFullscreen();

    sec.querySelectorAll('button[data-side]').forEach(btn => {
      btn.classList.toggle('is-active', btn.dataset.side === settings.firstPageSide);
    });

    const sub = sec.querySelector('.ml-duo-sub');
    if (sub) sub.classList.toggle('ml-duo-disabled', !settings.enabled);
  }

  function syncAllSettingsUI() {
    document.querySelectorAll('[data-ml-duo-settings="1"]').forEach(syncSectionUI);
  }

  function tryInjectIntoNativeSettings() {
    if (!isReaderPage()) return;
    if (document.getElementById('ml-duo-settings-section')) return;

    const keywords = [
      'Режим чтения',
      'Настройки читалки',
      'Ширина контейнера',
      'Область переключения',
      'Reading mode',
      'Reader settings'
    ];

    const candidates = document.querySelectorAll(
      '[role="dialog"], [class*="modal"], [class*="drawer"], [class*="popup"], [class*="settings"], aside'
    );

    for (const container of candidates) {
      if (container.offsetParent === null) continue;
      const text = container.textContent || '';
      if (!keywords.some(k => text.includes(k))) continue;

      const allNodes = container.querySelectorAll('div, section, label, span, h3, h4, p');
      let anchor = null;

      for (const node of allNodes) {
        if (node.children.length > 3) continue;
        const t = (node.textContent || '').trim();
        if (t === 'Режим чтения' || t === 'Reading mode' || t === 'Ширина контейнера') {
          anchor = node.parentElement;
          if (anchor && anchor.parentElement && anchor.parentElement !== container && anchor.textContent.trim() === t) {
            anchor = anchor.parentElement;
          }
          break;
        }
      }

      const sec = createSettingsSection();
      if (anchor && anchor.parentElement) {
        anchor.insertAdjacentElement('afterend', sec);
      } else {
        const body = container.querySelector('[class*="body"], [class*="content"]') || container;
        body.appendChild(sec);
      }
      return;
    }
  }

  function openFallbackModal() {
    const existing = document.getElementById('ml-duo-fallback-backdrop');
    if (existing) existing.remove();

    const backdrop = document.createElement('div');
    backdrop.id = 'ml-duo-fallback-backdrop';

    const modal = document.createElement('div');
    modal.id = 'ml-duo-fallback-modal';
    modal.innerHTML = `
      <div class="ml-duo-modal-head">
        <span>mangalib-duo</span>
        <button type="button" class="ml-duo-modal-close" title="Закрыть">&times;</button>
      </div>
    `;

    const sec = createSettingsSection('modal');
    sec.style.marginTop = '10px';
    modal.appendChild(sec);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    const close = () => backdrop.remove();
    modal.querySelector('.ml-duo-modal-close').addEventListener('click', close);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close();
    });
  }

  // =========================================================================
  // 8. КЛАВИАТУРА, ОТСЛЕЖИВАНИЕ ПЕРЕХОДОВ SPA И ЗАПУСК
  // =========================================================================

  function isAnyModalOpen() {
    if (document.getElementById('ml-duo-fallback-backdrop')) return true;
    const dialogs = document.querySelectorAll('[role="dialog"], [class*="modal"][class*="open"], [class*="drawer"][class*="open"]');
    return Array.from(dialogs).some(el => el.offsetParent !== null);
  }

  function checkRouteChange() {
    if (location.href === currentUrl) return;
    const prevRoute = parseChapterRoute(new URL(currentUrl).pathname);
    currentUrl = location.href;
    const nextRoute = parseChapterRoute(location.pathname);

    if (!nextRoute) {
      chapterPages = [];
      pagesFromApi = false;
      chapterKey = '';
      apiFetchInFlightFor = '';
      cleanupDuoStage();
      return;
    }

    if (!prevRoute || prevRoute.key !== nextRoute.key) {
      chapterPages = [];
      pagesFromApi = false;
      chapterKey = '';
      apiFetchInFlightFor = '';
      currentSpreadIndex = 0;
      uiHidden = settings.cleanScreen;

      const stage = document.getElementById('ml-duo-stage');
      if (stage) stage.remove();
      restoreNativeContainer();
      scheduleRender();
    }
  }

  function setupListeners() {
    window.addEventListener('keydown', (e) => {
      if (!isReaderPage()) return;

      const tag = (e.target?.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return;

      if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyD') {
        e.preventDefault();
        e.stopImmediatePropagation();
        saveSettings({ enabled: !settings.enabled });
        return;
      }

      if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyS') {
        e.preventDefault();
        e.stopImmediatePropagation();
        saveSettings({ coverAlone: !settings.coverAlone });
        return;
      }

      if (e.ctrlKey || e.altKey || e.metaKey) return;

      if (e.code === 'KeyF' && !isAnyModalOpen()) {
        e.preventDefault();
        e.stopImmediatePropagation();
        toggleFullscreen();
        return;
      }

      if (!settings.enabled || !document.getElementById('ml-duo-stage') || isAnyModalOpen()) return;

      if (e.code === 'ArrowLeft' || e.code === 'KeyA') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        animateTurnToSpread(settings.rtlNav ? 1 : -1);
      } else if (e.code === 'ArrowRight' || e.code === 'KeyD') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        animateTurnToSpread(settings.rtlNav ? -1 : 1);
      } else if (e.code === 'Space') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        animateTurnToSpread(e.shiftKey ? -1 : 1);
      }
    }, true);

    document.addEventListener('fullscreenchange', syncAllSettingsUI);
    document.addEventListener('webkitfullscreenchange', syncAllSettingsUI);
    window.addEventListener('popstate', checkRouteChange);

    // Лёгкая проверка SPA-маршрута без модификации history.pushState
    setInterval(checkRouteChange, 250);

    const observer = new MutationObserver((mutations) => {
      let needRender = false;
      let needSettings = false;

      for (const m of mutations) {
        if (m.target?.closest?.('#ml-duo-stage, #ml-duo-settings-section, #ml-duo-fallback-backdrop')) {
          continue;
        }
        if (m.type === 'childList' && (m.addedNodes.length || m.removedNodes.length)) {
          needRender = true;
          needSettings = true;
        } else if (m.type === 'attributes' && m.target?.tagName === 'IMG') {
          needRender = true;
        }
      }

      if (needSettings) tryInjectIntoNativeSettings();
      if (needRender) scheduleRender();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src']
    });
  }

  function init() {
    injectStyles();

    try {
      if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('Настройки mangalib-duo', openFallbackModal);
        GM_registerMenuCommand('Вкл/Выкл разворот (Alt+D)', () => saveSettings({ enabled: !settings.enabled }));
      }
    } catch (_) {}

    setupListeners();
    tryInjectIntoNativeSettings();
    scheduleRender();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
