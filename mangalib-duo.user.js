// ==UserScript==
// @name         MangaLib Duo
// @namespace    https://github.com/kakosina/mangalib-duo
// @version      3.0.0
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

  const STORAGE_KEY = 'mangalib_duo_settings_v300';
  const COMMENTS_FLAG_KEY = 'ml_duo_open_comments_after_nav';

  const DEFAULT_SETTINGS = {
    enabled: true,           // Двустраничный режим (Alt+D)
    readingMode: 'paged',    // 'paged' (постранично) | 'strip' (бесконечная полоса вбок)
    firstPageSide: 'right',  // 'right' (манга: 2 | 1) | 'left' (комикс: 1 | 2)
    rtlNav: true,            // Листать справа налево (манга)
    pageCurl: true,          // Чистая книжная анимация страницы (выкл = без анимации совсем)
    coverAlone: false,       // Обложка отдельно (сдвиг парности, Alt+S)
    autoWide: true,          // Широкие сканы целиком
    cleanScreen: true        // Скрывать верхнее и нижнее меню при открытии главы
  };

  function loadSettings() {
    try {
      let raw = null;
      if (typeof GM_getValue === 'function') raw = GM_getValue(STORAGE_KEY, null);
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
    const prevMode = settings.readingMode;
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
    } else if ('cleanScreen' in patch && isReaderPage() && settings.enabled && !commentsOpen) {
      applyCleanScreenState(settings.cleanScreen);
    }

    if (prevMode !== settings.readingMode) {
      resetStripState();
      const stage = document.getElementById('ml-duo-stage');
      if (stage) stage.dataset.sig = '';
    }

    scheduleRender();
  }

  let settings = loadSettings();

  // Состояние текущей главы и серверов картинок
  let chapterPages = [];
  let pagesFromApi = false;
  let chapterKey = '';
  let initialDomRouteKey = '';    // Какая глава реально отрендерена самой читалкой MangaLib (для комментариев)
  let activeChapterRoute = null;  // Текущая видимая глава (включая подгруженные в бесконечной полосе)
  let cdnOrigin = '';
  let imageServersLoaded = false;
  let fallbackServers = [
    'https://img33.imgslib.link',
    'https://img3.imgslib.link',
    'https://img2.imgslib.link',
    'https://img2.mixlib.me'
  ];

  // Кэш списка глав тайтла (для бесконечной подгрузки в горизонтальной полосе)
  let mangaChaptersCache = { slug: '', list: null, loading: false };

  let currentSpreadIndex = 0;
  let openAtLastSpread = false;
  let lastSpreadChangeAt = 0;
  let apiFetchInFlightFor = '';
  let renderRaf = null;
  let animRaf = null;
  let currentUrl = location.href;
  let hiddenNativeContainer = null;
  let uiHidden = settings.cleanScreen;
  let commentsOpen = false;

  // Размеры книги (1 страница = pageW x pageH)
  let bookMetrics = { pageW: 500, pageH: 720, left: 0, top: 0 };

  // Состояние бесконечной горизонтальной полосы
  const stripState = {
    loadedKeys: new Set(),
    lastLoadedRoute: null,
    loadingNext: false,
    noMoreChapters: false,
    userScrolled: false,
    scrollTimer: null,
    chaptersData: new Map(), // key -> { route, pages }
    panActive: false,
    panPointerId: null,
    panStartX: 0,
    panStartY: 0,
    panStartScroll: 0,
    panMoved: false
  };

  // Состояние интерактивного перелистывания (мышь + палец) в постраничном режиме
  const curl = {
    active: false,
    pointerId: null,
    isDragging: false,
    isAnimating: false,
    canCurl: false,
    startX: 0,
    startY: 0,
    startBookX: 0,
    startBookY: 0,
    lastX: 0,
    lastTime: 0,
    vx: 0,
    turnDir: 'l2r',
    stepDelta: 1,
    targetIndex: 0,
    isBoundary: false,
    bx: 0,
    dy: 0,
    progress: 0,
    nodes: null
  };

  // =========================================================================
  // 1. МАРШРУТЫ, API ГЛАВ И СБОРКА URL КАРТИНОК
  // =========================================================================

  function parseChapterRoute(pathname = location.pathname) {
    const m = pathname.match(/^(\/[a-z]{2})?(?:\/manga)?\/([^/]+)\/(read\/)?v([^/]+)\/c([^/?#]+)/i);
    if (!m) return null;
    return {
      langPrefix: m[1] || '',
      slug: m[2],
      hasRead: Boolean(m[3]),
      volume: m[4],
      number: m[5],
      key: `${m[2]}_${m[4]}_${m[5]}`
    };
  }

  function buildChapterPathname(route) {
    const lang = route.langPrefix || '';
    const readPart = route.hasRead ? 'read/' : 'read/';
    return `${lang}/manga/${route.slug}/${readPart}v${route.volume}/c${route.number}`;
  }

  function isReaderPage(pathname = location.pathname) {
    return Boolean(parseChapterRoute(pathname));
  }

  function compareChapterOrder(a, b) {
    const va = parseFloat(a.volume) || 0;
    const vb = parseFloat(b.volume) || 0;
    if (va !== vb) return va - vb;
    return (parseFloat(a.number) || 0) - (parseFloat(b.number) || 0);
  }

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
        try { path = new URL(normalizeFullUrl(rawUrl)).pathname; } catch (_) {}
      }
      if (singleSlash) return host + '/' + path.replace(/^\/+/, '');
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

  function getApiHeaders() {
    const headers = { Accept: 'application/json', 'Site-Id': '1' };
    const token = getMangaLibAuthToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  async function loadImageServersOnce() {
    if (imageServersLoaded) return;
    imageServersLoaded = true;
    try {
      const res = await fetch('https://api.cdnlibs.org/api/constants?fields[]=imageServers', {
        headers: { Accept: 'application/json', 'Site-Id': '1' },
        credentials: 'omit'
      });
      if (!res.ok) return;
      const json = await res.json();
      const servers = json?.data?.imageServers;
      if (!Array.isArray(servers)) return;
      const mangaServers = servers
        .filter(s => s && typeof s.url === 'string' && (!Array.isArray(s.site_ids) || s.site_ids.includes(1)))
        .map(s => s.url.replace(/\/+$/, ''));
      if (mangaServers.length) {
        fallbackServers = Array.from(new Set([...mangaServers, ...fallbackServers]));
        if (!cdnOrigin) {
          cdnOrigin = mangaServers[0];
          scheduleRender();
        }
      }
    } catch (_) {}
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

    try {
      const entries = performance.getEntriesByType('resource');
      for (let i = entries.length - 1; i >= 0; i--) {
        const name = entries[i].name || '';
        if (/\/manga\/|imgslib|mixlib|cdnlibs/i.test(name) && /\.(jpe?g|png|webp|avif|gif)(\?|$)/i.test(name)) {
          const origin = new URL(name).origin;
          if (origin && origin !== location.origin) {
            cdnOrigin = origin;
            if (!fallbackServers.includes(origin)) fallbackServers.unshift(origin);
            return origin;
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

  async function fetchChapterPagesByRoute(route, branchId = '') {
    const qs = new URLSearchParams({ number: route.number, volume: route.volume });
    if (branchId) qs.set('branch_id', branchId);

    const perfUrl = findChapterApiUrlFromPerformance(route);
    const candidateUrls = Array.from(new Set([
      perfUrl,
      `https://api.cdnlibs.org/api/manga/${encodeURIComponent(route.slug)}/chapter?${qs.toString()}`,
      `${location.origin}/api/manga/${encodeURIComponent(route.slug)}/chapter?${qs.toString()}`
    ].filter(Boolean)));

    const headers = getApiHeaders();

    for (const url of candidateUrls) {
      try {
        const res = await fetch(url, { headers, credentials: 'omit' });
        if (!res.ok) continue;
        const json = await res.json();
        const data = json?.data || json;
        if (!data || !Array.isArray(data.pages) || !data.pages.length) continue;
        return data.pages.map((p, idx) => {
          const u = p.url || '';
          return {
            index: idx,
            url: u,
            image: p.image || '',
            fullUrl: isRealFullUrl(u) ? normalizeFullUrl(u) : '',
            width: Number(p.width) || 0,
            height: Number(p.height) || 0
          };
        });
      } catch (_) {}
    }
    return null;
  }

  async function fetchMangaChaptersList(slug) {
    if (mangaChaptersCache.slug === slug && Array.isArray(mangaChaptersCache.list)) {
      return mangaChaptersCache.list;
    }
    if (mangaChaptersCache.loading) return null;
    mangaChaptersCache.loading = true;

    const urls = [
      `https://api.cdnlibs.org/api/manga/${encodeURIComponent(slug)}/chapters`,
      `${location.origin}/api/manga/${encodeURIComponent(slug)}/chapters`
    ];
    const headers = getApiHeaders();

    for (const url of urls) {
      try {
        const res = await fetch(url, { headers, credentials: 'omit' });
        if (!res.ok) continue;
        const json = await res.json();
        const raw = json?.data;
        if (!Array.isArray(raw) || !raw.length) continue;

        const sorted = raw
          .filter(c => c && c.volume != null && c.number != null)
          .map(c => ({
            volume: String(c.volume),
            number: String(c.number),
            name: c.name || '',
            branches: Array.isArray(c.branches) ? c.branches : []
          }))
          .sort(compareChapterOrder);

        mangaChaptersCache = { slug, list: sorted, loading: false };
        return sorted;
      } catch (_) {}
    }

    mangaChaptersCache.loading = false;
    return null;
  }

  async function loadCurrentChapterFromApi() {
    const route = parseChapterRoute();
    if (!route) return;
    if (pagesFromApi && chapterKey === route.key && chapterPages.length > 0) return;
    if (apiFetchInFlightFor === route.key) return;
    apiFetchInFlightFor = route.key;

    loadImageServersOnce();

    const search = new URLSearchParams(location.search);
    const branchId = search.get('bid') || search.get('branch_id') || '';
    const pages = await fetchChapterPagesByRoute(route, branchId);

    const nowRoute = parseChapterRoute();
    if (pages && nowRoute && nowRoute.key === route.key) {
      applyPagesList(pages, route, true);
      return;
    }

    if (apiFetchInFlightFor === route.key) apiFetchInFlightFor = '';
  }

  function applyPagesList(rawPages, route, fromApi) {
    const key = route ? route.key : 'dom';
    const isSame = key === chapterKey && pagesFromApi === fromApi && chapterPages.length === rawPages.length;
    chapterKey = key;
    pagesFromApi = fromApi;
    if (route) {
      activeChapterRoute = route;
      if (!initialDomRouteKey) initialDomRouteKey = route.key;
    }

    chapterPages = rawPages.map((p, idx) => {
      const u = p.url || '';
      return {
        index: idx,
        url: u,
        image: p.image || '',
        fullUrl: p.fullUrl || (isRealFullUrl(u) ? normalizeFullUrl(u) : ''),
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
  // 2. СТИЛИ (ЧИСТАЯ КНИГА БЕЗ ТЕНЕЙ, ПОЛОСА ВБОК, КОММЕНТАРИИ, РОДНОЕ МЕНЮ)
  // =========================================================================

  const STYLES = `
    html.ml-duo-active,
    html.ml-duo-active body {
      overflow: hidden !important;
      height: 100% !important;
      overscroll-behavior: none !important;
    }

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

    .ml-duo-native-masked {
      visibility: hidden !important;
      pointer-events: none !important;
      max-height: 100vh !important;
      overflow: hidden !important;
    }

    /* В режиме комментариев полностью сворачиваем картинки читалки, чтобы сразу видеть комментарии */
    .ml-duo-native-collapsed {
      display: none !important;
    }

    /* --- ОСНОВНАЯ СЦЕНА --- */
    #ml-duo-stage {
      position: fixed;
      inset: 0;
      width: 100vw;
      height: 100vh;
      z-index: 15;
      background: var(--ml-duo-bg, #141414);
      user-select: none;
      -webkit-user-select: none;
    }

    /* Постраничный режим */
    #ml-duo-stage.mode-paged {
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      touch-action: none;
      cursor: default;
    }

    #ml-duo-stage.mode-paged.can-grab {
      cursor: grab;
    }

    #ml-duo-stage.mode-paged.is-dragging {
      cursor: grabbing;
    }

    /* Режим бесконечной горизонтальной полосы */
    #ml-duo-stage.mode-strip {
      display: block;
      overflow-x: auto;
      overflow-y: hidden;
      touch-action: pan-x;
      -webkit-overflow-scrolling: touch;
      scrollbar-width: none;
      cursor: grab;
    }

    #ml-duo-stage.mode-strip::-webkit-scrollbar {
      display: none;
    }

    #ml-duo-stage.mode-strip.is-dragging {
      cursor: grabbing;
    }

    .ml-duo-strip-track {
      display: flex;
      flex-direction: row;
      align-items: center;
      height: 100vh;
      width: max-content;
      gap: 18px;
      padding: 0 24px;
      box-sizing: border-box;
    }

    .ml-duo-strip-spread {
      flex: 0 0 auto;
      height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .ml-duo-strip-spread > img {
      display: block;
      max-height: 100vh;
      max-width: 100vw;
      width: auto;
      height: auto;
      object-fit: contain;
      pointer-events: none;
      -webkit-user-drag: none;
    }

    .ml-duo-strip-pair {
      display: flex;
      flex-direction: row;
      align-items: center;
      justify-content: center;
      height: 100vh;
    }

    .ml-duo-strip-pair > img {
      display: block;
      max-height: 100vh;
      max-width: 50vw;
      width: auto;
      height: auto;
      object-fit: contain;
      pointer-events: none;
      -webkit-user-drag: none;
    }

    /* Аккуратный вертикальный разделитель глав в бесконечной полосе */
    .ml-duo-strip-divider {
      flex: 0 0 auto;
      height: 70vh;
      min-width: 160px;
      padding: 20px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      border-left: 1px solid rgba(128, 128, 128, 0.22);
      border-right: 1px solid rgba(128, 128, 128, 0.22);
      color: inherit;
      text-align: center;
      box-sizing: border-box;
    }

    .ml-duo-strip-div-title {
      font-size: 13px;
      font-weight: 600;
      opacity: 0.78;
    }

    .ml-duo-strip-div-btn {
      border: 1px solid rgba(128, 128, 128, 0.35);
      background: rgba(128, 128, 128, 0.14);
      color: inherit;
      font: inherit;
      font-size: 13px;
      padding: 6px 12px;
      border-radius: 6px;
      cursor: pointer;
    }

    .ml-duo-strip-div-btn:hover {
      background: rgba(128, 128, 128, 0.26);
    }

    /* --- ПОСТРАНИЧНАЯ КНИГА (ЧИСТАЯ, БЕЗ ТЕНЕЙ И 3D-ЭФФЕКТОВ) --- */
    .ml-duo-book {
      position: relative;
      overflow: visible;
      flex-shrink: 0;
    }

    .ml-duo-layer {
      position: absolute;
      inset: 0;
      pointer-events: none;
    }

    .ml-duo-page-box {
      position: absolute;
      top: 0;
      overflow: hidden;
      display: flex;
      align-items: center;
      background: transparent;
    }

    .ml-duo-page-box.is-left {
      left: 0;
      justify-content: flex-end;
    }

    .ml-duo-page-box.is-right {
      right: 0;
      justify-content: flex-start;
    }

    .ml-duo-page-box.is-back {
      left: 0;
      top: 0;
      transform-origin: 0 0;
      will-change: transform;
    }

    .ml-duo-page-box > img {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: contain;
      pointer-events: none;
      -webkit-user-drag: none;
    }

    .ml-duo-page-box.is-left > img  { object-position: right center; }
    .ml-duo-page-box.is-right > img { object-position: left center; }

    .ml-duo-solo-wrap {
      position: relative;
      width: 100vw;
      height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .ml-duo-solo-wrap > img {
      display: block;
      max-width: 100vw;
      max-height: 100vh;
      width: auto;
      height: auto;
      object-fit: contain;
      pointer-events: none;
      -webkit-user-drag: none;
    }

    .ml-curl-front {
      z-index: 4;
      will-change: clip-path;
    }

    .ml-curl-flap {
      z-index: 5;
      will-change: clip-path;
    }

    /* Кнопка возврата к чтению при просмотре комментариев */
    #ml-duo-back-to-manga {
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 9999;
      padding: 10px 16px;
      border-radius: 8px;
      border: 1px solid rgba(128, 128, 128, 0.35);
      background: #1f1f23;
      color: #f4f4f5;
      font-family: inherit;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.32);
    }

    #ml-duo-back-to-manga:hover {
      background: #2b2b31;
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

    .ml-duo-action-btn {
      width: 100%;
      margin-top: 8px;
      padding: 7px 10px;
      border-radius: 6px;
      border: 1px solid rgba(128, 128, 128, 0.28);
      background: rgba(128, 128, 128, 0.12);
      color: inherit;
      font: inherit;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      text-align: center;
    }

    .ml-duo-action-btn:hover {
      background: rgba(128, 128, 128, 0.22);
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
  // 3. ЧИСТЫЙ ЭКРАН, ПОЛНОЭКРАННЫЙ РЕЖИМ И ПРОСМОТР КОММЕНТАРИЕВ
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
        el.id === 'ml-duo-back-to-manga' ||
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
    if (!isReaderPage() || !settings.enabled || commentsOpen) {
      document.documentElement.classList.remove('ml-duo-ui-hidden');
      return;
    }
    tagNativeReaderChrome();
    document.documentElement.classList.toggle('ml-duo-ui-hidden', uiHidden);
  }

  function toggleReaderChrome() {
    applyCleanScreenState(!uiHidden);
  }

  function findCommentsElement() {
    const selectors = [
      '#comments',
      '[id*="comment"]',
      '[class*="comments"]',
      '[data-comments]'
    ];
    for (const sel of selectors) {
      const nodes = document.querySelectorAll(sel);
      for (const el of nodes) {
        if (el.closest('#ml-duo-stage, #ml-duo-settings-section, header, nav')) continue;
        const rect = el.getBoundingClientRect();
        if (rect.height > 40 || (el.textContent || '').includes('Комментари')) {
          return el;
        }
      }
    }
    return null;
  }

  function openCommentsView(targetRoute = null) {
    if (!isReaderPage()) return;

    // Закрываем открытые настройки, если открыли комментарии из меню
    const fallbackModal = document.getElementById('ml-duo-fallback-backdrop');
    if (fallbackModal) fallbackModal.remove();

    // Если в бесконечной полосе пользователь дошёл до другой главы — переходим на неё, чтобы открыть именно её комментарии
    const desiredRoute = targetRoute || activeChapterRoute || parseChapterRoute();
    if (desiredRoute && initialDomRouteKey && desiredRoute.key !== initialDomRouteKey) {
      try { sessionStorage.setItem(COMMENTS_FLAG_KEY, '1'); } catch (_) {}
      location.href = buildChapterPathname(desiredRoute);
      return;
    }

    commentsOpen = true;
    document.documentElement.classList.remove('ml-duo-active', 'ml-duo-ui-hidden');

    const stage = document.getElementById('ml-duo-stage');
    if (stage) stage.style.display = 'none';

    if (hiddenNativeContainer) {
      hiddenNativeContainer.classList.remove('ml-duo-native-masked');
      hiddenNativeContainer.classList.add('ml-duo-native-collapsed');
    }

    // Показываем кнопку возврата к чтению
    let backBtn = document.getElementById('ml-duo-back-to-manga');
    if (!backBtn) {
      backBtn = document.createElement('button');
      backBtn.id = 'ml-duo-back-to-manga';
      backBtn.type = 'button';
      backBtn.textContent = '← Вернуться к чтению';
      backBtn.addEventListener('click', closeCommentsView);
      document.body.appendChild(backBtn);
    }

    // Прокручиваем прямо к комментариям (или пробуем открыть родной блок комментариев MangaLib)
    requestAnimationFrame(() => {
      const commentsEl = findCommentsElement();
      if (commentsEl) {
        commentsEl.scrollIntoView({ behavior: 'auto', block: 'start' });
      } else {
        window.scrollTo(0, document.body.scrollHeight);
      }
    });
  }

  function closeCommentsView() {
    if (!commentsOpen) return;
    commentsOpen = false;

    const backBtn = document.getElementById('ml-duo-back-to-manga');
    if (backBtn) backBtn.remove();

    if (hiddenNativeContainer) {
      hiddenNativeContainer.classList.remove('ml-duo-native-collapsed');
      hiddenNativeContainer.classList.add('ml-duo-native-masked');
    }

    const stage = document.getElementById('ml-duo-stage');
    if (stage) stage.style.display = '';

    if (isReaderPage() && settings.enabled) {
      document.documentElement.classList.add('ml-duo-active');
      applyCleanScreenState(uiHidden);
    }
  }

  // =========================================================================
  // 4. ПОИСК КАРТИНОК, РАЗМЕРЫ КНИГИ И ГРУППИРОВКА РАЗВОРОТОВ
  // =========================================================================

  function isLikelyMangaImage(img) {
    if (!img || img.closest('#ml-duo-stage, #ml-duo-settings-section, #ml-duo-fallback-backdrop')) return false;
    if (img.closest('header, nav, footer, [role="dialog"], #comments, [class*="comment"]')) return false;
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
        // Не скрываем общий контейнер, если внутри него лежат комментарии
        if (candidate.querySelector('#comments, [class*="comments"]')) {
          continue;
        }
        return candidate;
      }
    }
    return null;
  }

  function collectDomPagesFallback(nativeImgs) {
    if (pagesFromApi || nativeImgs.length < 2) return;
    const route = parseChapterRoute();
    const list = nativeImgs
      .map(img => ({
        url: img.currentSrc || img.src || img.getAttribute('data-src') || '',
        image: '',
        width: img.naturalWidth || 0,
        height: img.naturalHeight || 0
      }))
      .filter(p => isRealFullUrl(p.url));

    if (list.length >= 2) applyPagesList(list, route, false);
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

  function mapGroupToSlots(group, pagesArr = chapterPages) {
    if (!group) return { left: null, right: null, solo: null };
    if (group.solo) return { left: null, right: null, solo: pagesArr[group.pages[0]] || null };
    const p1 = pagesArr[group.pages[0]] || null;
    const p2 = pagesArr[group.pages[1]] || null;
    return settings.firstPageSide === 'right'
      ? { left: p2, right: p1, solo: null }
      : { left: p1, right: p2, solo: null };
  }

  function computeBookMetrics(slots) {
    const vw = window.innerWidth || 1000;
    const vh = window.innerHeight || 700;

    let ratio = 0.707;
    const sample = [slots?.right, slots?.left, ...chapterPages.slice(0, 6)]
      .filter(p => p && p.width > 0 && p.height > 0 && p.width < p.height * 1.15);

    if (sample.length) {
      const ratios = sample.map(p => p.width / p.height);
      ratio = ratios.reduce((a, b) => a + b, 0) / ratios.length;
      ratio = Math.max(0.54, Math.min(0.95, ratio));
    }

    let pageH = vh;
    let pageW = pageH * ratio;
    if (pageW * 2 > vw) {
      pageW = vw / 2;
      pageH = pageW / ratio;
    }

    pageW = Math.floor(pageW);
    pageH = Math.floor(pageH);

    bookMetrics = {
      pageW,
      pageH,
      left: Math.round((vw - pageW * 2) / 2),
      top: Math.round((vh - pageH) / 2)
    };
    return bookMetrics;
  }

  function createPageImg(pageMeta, onMeasured) {
    const img = document.createElement('img');
    img.referrerPolicy = 'strict-origin-when-cross-origin';
    img.alt = '';
    img.draggable = false;

    const primaryUrl = buildImageUrl(pageMeta);
    img.src = primaryUrl;

    const attempts = [];
    const primarySingle = buildImageUrl(pageMeta, '', true);
    if (primarySingle && primarySingle !== primaryUrl) attempts.push({ u: primarySingle, s: cdnOrigin });
    for (const srv of fallbackServers) {
      const u1 = buildImageUrl(pageMeta, srv, false);
      const u2 = buildImageUrl(pageMeta, srv, true);
      if (u1 && u1 !== primaryUrl) attempts.push({ u: u1, s: srv });
      if (u2 && u2 !== primaryUrl && u2 !== u1) attempts.push({ u: u2, s: srv });
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
      if (img.dataset.mlTryServer) cdnOrigin = img.dataset.mlTryServer;
      if (!pageMeta.width || !pageMeta.height) {
        pageMeta.width = img.naturalWidth;
        pageMeta.height = img.naturalHeight;
        if (onMeasured) onMeasured(pageMeta);
      }
    }, { once: true });

    return img;
  }

  function createPageBox(pageMeta, boxClass, w, h) {
    const box = document.createElement('div');
    box.className = `ml-duo-page-box ${boxClass}`;
    box.style.width = `${w}px`;
    box.style.height = `${h}px`;

    if (pageMeta) {
      const img = createPageImg(pageMeta, () => {
        if (settings.readingMode === 'paged' && !curl.isDragging && !curl.isAnimating) {
          renderStaticCurrentSpread();
        }
      });
      box.appendChild(img);
    }
    return box;
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

  // =========================================================================
  // 5. РЕЖИМ 1: ПОСТРАНИЧНЫЙ РАЗВОРОТ (ЧИСТАЯ КНИЖНАЯ СТРАНИЦА / БЕЗ АНИМАЦИИ)
  // =========================================================================

  function clipPolyHalfPlane(poly, mx, my, nx, ny) {
    if (!poly.length) return [];
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const da = (a.x - mx) * nx + (a.y - my) * ny;
      const db = (b.x - mx) * nx + (b.y - my) * ny;
      if (da >= 0) out.push(a);
      if ((da >= 0) !== (db >= 0)) {
        const t = da / (da - db);
        out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      }
    }
    return out;
  }

  function reflectPoint(p, mx, my, nx, ny) {
    const d = (p.x - mx) * nx + (p.y - my) * ny;
    return { x: p.x - 2 * d * nx, y: p.y - 2 * d * ny };
  }

  function clampToCircle(x, y, cx, cy, r) {
    const dx = x - cx;
    const dy = y - cy;
    const dist = Math.hypot(dx, dy);
    if (dist <= r || dist < 1e-6) return { x, y };
    const s = r / dist;
    return { x: cx + dx * s, y: cy + dy * s };
  }

  function polyToClipPath(poly) {
    if (!poly || poly.length < 3) return 'polygon(0px 0px, 0px 0px, 0px 0px)';
    return 'polygon(' + poly.map(p => `${p.x.toFixed(1)}px ${p.y.toFixed(1)}px`).join(', ') + ')';
  }

  function renderStaticCurrentSpread() {
    const stage = document.getElementById('ml-duo-stage');
    if (!stage || !chapterPages.length || settings.readingMode !== 'paged') return;

    const groups = computeSpreadGroups(chapterPages);
    if (!groups.length) return;

    currentSpreadIndex = Math.max(0, Math.min(currentSpreadIndex, groups.length - 1));
    const group = groups[currentSpreadIndex];
    const slots = mapGroupToSlots(group);

    stage.classList.toggle('can-grab', settings.pageCurl);
    stage.innerHTML = '';

    if (slots.solo) {
      const soloWrap = document.createElement('div');
      soloWrap.className = 'ml-duo-solo-wrap';
      soloWrap.appendChild(createPageImg(slots.solo, () => {
        if (!curl.isDragging && !curl.isAnimating) renderStaticCurrentSpread();
      }));
      stage.appendChild(soloWrap);
    } else {
      const m = computeBookMetrics(slots);
      const book = document.createElement('div');
      book.className = 'ml-duo-book';
      book.style.width = `${m.pageW * 2}px`;
      book.style.height = `${m.pageH}px`;

      book.appendChild(createPageBox(slots.left, 'is-left', m.pageW, m.pageH));
      book.appendChild(createPageBox(slots.right, 'is-right', m.pageW, m.pageH));
      stage.appendChild(book);
    }

    syncPageQueryParam(group.pages[0] + 1);
    preloadSpread(groups, currentSpreadIndex + 1);
    preloadSpread(groups, currentSpreadIndex + 2);
    preloadSpread(groups, currentSpreadIndex - 1);
  }

  function syncPageQueryParam(pageNum, routeOverride = null) {
    try {
      const u = new URL(location.href);
      if (routeOverride) {
        u.pathname = buildChapterPathname(routeOverride);
      }
      u.searchParams.set('p', String(pageNum));
      const nextHref = u.toString();
      if (nextHref !== location.href) {
        window.history.replaceState(window.history.state, '', nextHref);
        currentUrl = nextHref;
      }
    } catch (_) {}
  }

  // Чистая сцена книжной страницы (без теней, градиентов и 3D-эффектов)
  function buildCleanCurlDOM(oldSlots, newSlots, turnDir) {
    const stage = document.getElementById('ml-duo-stage');
    if (!stage) return null;

    const m = computeBookMetrics(oldSlots);
    const w = m.pageW;
    const h = m.pageH;

    stage.innerHTML = '';

    const book = document.createElement('div');
    book.className = 'ml-duo-book';
    book.style.width = `${w * 2}px`;
    book.style.height = `${h}px`;

    // 1. Нижний слой (открывающаяся + неподвижная страницы)
    const underLayer = document.createElement('div');
    underLayer.className = 'ml-duo-layer';
    underLayer.appendChild(createPageBox(turnDir === 'l2r' ? newSlots.left : oldSlots.left, 'is-left', w, h));
    underLayer.appendChild(createPageBox(turnDir === 'l2r' ? oldSlots.right : newSlots.right, 'is-right', w, h));

    // 2. Лицевая часть перелистываемой страницы
    const frontLayer = document.createElement('div');
    frontLayer.className = 'ml-duo-layer ml-curl-front';
    frontLayer.appendChild(createPageBox(
      turnDir === 'l2r' ? oldSlots.left : oldSlots.right,
      turnDir === 'l2r' ? 'is-left' : 'is-right',
      w,
      h
    ));

    // 3. Переворачиваемый чистый лист (оборотная сторона)
    const flapLayer = document.createElement('div');
    flapLayer.className = 'ml-duo-layer ml-curl-flap';

    const backBox = createPageBox(
      turnDir === 'l2r' ? newSlots.right : newSlots.left,
      `is-back ${turnDir === 'l2r' ? 'is-right' : 'is-left'}`,
      w,
      h
    );
    flapLayer.appendChild(backBox);

    book.appendChild(underLayer);
    book.appendChild(frontLayer);
    book.appendChild(flapLayer);
    stage.appendChild(book);

    return { w, h, turnDir, frontLayer, flapLayer, backBox };
  }

  function updateCleanCurlGeometry(nodes, bxRaw, dyRaw) {
    if (!nodes) return;
    const { w, h, turnDir, frontLayer, flapLayer, backBox } = nodes;
    const diag = Math.hypot(w, h);
    const totalW = w * 2;

    let A, B;
    if (turnDir === 'l2r') {
      const bx = Math.max(0.5, Math.min(totalW - 0.1, bxRaw));
      if (dyRaw <= 0) {
        A = { x: 0, y: h };
        B = { x: bx, y: h + dyRaw };
        B = clampToCircle(B.x, B.y, w, 0, diag - 0.5);
        B = clampToCircle(B.x, B.y, w, h, w - 0.1);
      } else {
        A = { x: 0, y: 0 };
        B = { x: bx, y: dyRaw };
        B = clampToCircle(B.x, B.y, w, h, diag - 0.5);
        B = clampToCircle(B.x, B.y, w, 0, w - 0.1);
      }
      if (B.x < 0.5) B.x = 0.5;
    } else {
      const bx = Math.max(0.1, Math.min(totalW - 0.5, bxRaw));
      if (dyRaw <= 0) {
        A = { x: totalW, y: h };
        B = { x: bx, y: h + dyRaw };
        B = clampToCircle(B.x, B.y, w, 0, diag - 0.5);
        B = clampToCircle(B.x, B.y, w, h, w - 0.1);
      } else {
        A = { x: totalW, y: 0 };
        B = { x: bx, y: dyRaw };
        B = clampToCircle(B.x, B.y, w, h, diag - 0.5);
        B = clampToCircle(B.x, B.y, w, 0, w - 0.1);
      }
      if (B.x > totalW - 0.5) B.x = totalW - 0.5;
    }

    const vx = B.x - A.x;
    const vy = B.y - A.y;
    const len = Math.hypot(vx, vy);
    if (len < 0.5) return;

    const nx = vx / len;
    const ny = vy / len;
    const mx = (A.x + B.x) * 0.5;
    const my = (A.y + B.y) * 0.5;
    const alpha = Math.atan2(ny, nx);

    const pageRect = turnDir === 'l2r'
      ? [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }]
      : [{ x: w, y: 0 }, { x: totalW, y: 0 }, { x: totalW, y: h }, { x: w, y: h }];

    const flatPoly = clipPolyHalfPlane(pageRect, mx, my, nx, ny);
    const peeledPoly = clipPolyHalfPlane(pageRect, mx, my, -nx, -ny);
    const flapPoly = peeledPoly.map(p => reflectPoint(p, mx, my, nx, ny));

    frontLayer.style.clipPath = polyToClipPath(flatPoly);
    flapLayer.style.clipPath = polyToClipPath(flapPoly);

    const originStart = turnDir === 'l2r' ? { x: w, y: 0 } : { x: totalW, y: 0 };
    const O = reflectPoint(originStart, mx, my, nx, ny);
    backBox.style.transform = `translate3d(${O.x.toFixed(2)}px, ${O.y.toFixed(2)}px, 0) rotate(${(2 * alpha).toFixed(5)}rad)`;
  }

  function stopCurlAnimation() {
    if (animRaf) {
      cancelAnimationFrame(animRaf);
      animRaf = null;
    }
    curl.isAnimating = false;
  }

  function animateCurlTo(nodes, fromBx, fromDy, toBx, toDy, durationMs, arcHeight, onDone) {
    stopCurlAnimation();
    curl.isAnimating = true;
    const startTime = performance.now();

    const step = (now) => {
      const rawT = Math.min(1, (now - startTime) / durationMs);
      const ease = 1 - Math.pow(1 - rawT, 3.2);

      const bx = fromBx + (toBx - fromBx) * ease;
      const dy = fromDy * (1 - ease) + arcHeight * Math.sin(rawT * Math.PI);

      curl.bx = bx;
      curl.dy = dy;
      updateCleanCurlGeometry(nodes, bx, dy);

      if (rawT < 1) {
        animRaf = requestAnimationFrame(step);
      } else {
        animRaf = null;
        curl.isAnimating = false;
        onDone();
      }
    };

    animRaf = requestAnimationFrame(step);
  }

  function triggerPagedTurn(delta) {
    if (!chapterPages.length) {
      loadCurrentChapterFromApi();
      return;
    }

    const groups = computeSpreadGroups(chapterPages);
    if (!groups.length) return;

    if (curl.isAnimating) {
      stopCurlAnimation();
      renderStaticCurrentSpread();
    }

    const nextIdx = currentSpreadIndex + delta;
    if (nextIdx >= groups.length || nextIdx < 0) {
      if (!pagesFromApi && chapterPages.length < 2) {
        loadCurrentChapterFromApi();
        return;
      }
      if (Date.now() - lastSpreadChangeAt < 280) return;
      goToAdjacentChapter(nextIdx >= groups.length ? 1 : -1);
      return;
    }

    const oldGroup = groups[currentSpreadIndex];
    const newGroup = groups[nextIdx];
    const turnDir = (settings.firstPageSide === 'right')
      ? (delta > 0 ? 'l2r' : 'r2l')
      : (delta > 0 ? 'r2l' : 'l2r');

    currentSpreadIndex = nextIdx;
    lastSpreadChangeAt = Date.now();

    // Если анимация отключена (или одиночный широкий скан) — мгновенное переключение БЕЗ анимации
    if (!settings.pageCurl || oldGroup.solo || newGroup.solo) {
      renderStaticCurrentSpread();
      return;
    }

    const nodes = buildCleanCurlDOM(mapGroupToSlots(oldGroup), mapGroupToSlots(newGroup), turnDir);
    if (!nodes) {
      renderStaticCurrentSpread();
      return;
    }

    const totalW = nodes.w * 2;
    const startBx = turnDir === 'l2r' ? 1 : totalW - 1;
    const endBx = turnDir === 'l2r' ? totalW - 0.5 : 0.5;
    const arc = -Math.min(nodes.h * 0.12, 100);

    animateCurlTo(nodes, startBx, 0, endBx, 0, 390, arc, () => {
      renderStaticCurrentSpread();
    });
  }

  // Интерактивный жест в постраничном режиме (мышь + палец)
  function onPagedPointerDown(e) {
    if (isAnyModalOpen()) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (curl.active) return;

    e.stopPropagation();

    if (curl.isAnimating) {
      stopCurlAnimation();
      renderStaticCurrentSpread();
    }

    curl.active = true;
    curl.pointerId = e.pointerId;
    curl.isDragging = false;
    curl.canCurl = false;
    curl.startX = e.clientX;
    curl.startY = e.clientY;
    curl.startBookX = e.clientX - bookMetrics.left;
    curl.startBookY = e.clientY - bookMetrics.top;
    curl.lastX = e.clientX;
    curl.lastTime = performance.now();
    curl.vx = 0;
    curl.progress = 0;
    curl.nodes = null;

    window.addEventListener('pointermove', onPagedPointerMove, { passive: false });
    window.addEventListener('pointerup', onPagedPointerUp);
    window.addEventListener('pointercancel', onPagedPointerCancel);
  }

  function startPagedDrag(dx) {
    const groups = computeSpreadGroups(chapterPages);
    if (!groups.length) return false;

    const stage = document.getElementById('ml-duo-stage');
    if (!stage) return false;

    curl.turnDir = dx > 0 ? 'l2r' : 'r2l';
    curl.stepDelta = settings.rtlNav
      ? (curl.turnDir === 'l2r' ? 1 : -1)
      : (curl.turnDir === 'r2l' ? 1 : -1);

    curl.targetIndex = currentSpreadIndex + curl.stepDelta;
    curl.isBoundary = curl.targetIndex < 0 || curl.targetIndex >= groups.length;

    const oldGroup = groups[currentSpreadIndex];
    const newGroup = !curl.isBoundary ? groups[curl.targetIndex] : null;
    curl.canCurl = settings.pageCurl && !curl.isBoundary && !oldGroup.solo && newGroup && !newGroup.solo;
    curl.isDragging = true;

    if (curl.canCurl) {
      stage.classList.add('is-dragging');
      const nodes = buildCleanCurlDOM(mapGroupToSlots(oldGroup), mapGroupToSlots(newGroup), curl.turnDir);
      if (!nodes) return false;
      curl.nodes = nodes;
      curl.bx = curl.turnDir === 'l2r' ? 1 : nodes.w * 2 - 1;
      curl.dy = 0;
    }
    return true;
  }

  function onPagedPointerMove(e) {
    if (!curl.active || e.pointerId !== curl.pointerId) return;

    const dx = e.clientX - curl.startX;
    const dy = e.clientY - curl.startY;
    const now = performance.now();
    const dt = Math.max(1, now - curl.lastTime);
    curl.vx = (e.clientX - curl.lastX) / dt;
    curl.lastX = e.clientX;
    curl.lastTime = now;

    if (!curl.isDragging) {
      if (Math.hypot(dx, dy) < 7) return;
      if (Math.abs(dy) > Math.abs(dx) * 1.55) {
        cleanupPagedDragListeners();
        curl.active = false;
        return;
      }
      if (!startPagedDrag(dx)) {
        cleanupPagedDragListeners();
        curl.active = false;
        return;
      }
    }

    e.preventDefault();

    if (curl.canCurl && curl.nodes) {
      const w = curl.nodes.w;
      const h = curl.nodes.h;
      const totalW = w * 2;

      if (curl.turnDir === 'l2r') {
        const startXClamped = Math.max(0, Math.min(w * 1.15, curl.startBookX));
        const span = Math.max(w * 0.75, totalW - startXClamped);
        curl.progress = Math.max(0, Math.min(1, dx / span));
        curl.bx = Math.max(1, curl.progress * totalW);
      } else {
        const startXClamped = Math.max(w * 0.85, Math.min(totalW, curl.startBookX));
        const span = Math.max(w * 0.75, startXClamped);
        curl.progress = Math.max(0, Math.min(1, -dx / span));
        curl.bx = Math.min(totalW - 1, totalW - curl.progress * totalW);
      }

      const damp = Math.sin(curl.progress * Math.PI);
      const naturalBias = (curl.startBookY < h * 0.42 ? 1 : -1) * Math.min(24, h * 0.038) * damp;
      curl.dy = dy * 0.8 * Math.max(0.15, 1 - Math.pow(curl.progress, 2.2)) + naturalBias;

      updateCleanCurlGeometry(curl.nodes, curl.bx, curl.dy);
    } else {
      // Без анимации — только фиксируем прогресс свайпа, саму картинку не двигаем
      curl.progress = Math.min(1, Math.abs(dx) / 90);
    }
  }

  function finishPagedDrag(cancelled = false) {
    const stage = document.getElementById('ml-duo-stage');
    if (stage) stage.classList.remove('is-dragging');

    if (!curl.isDragging) {
      if (!cancelled) {
        const vw = window.innerWidth || 1;
        const ratio = curl.startX / vw;
        if (ratio < 0.35) {
          triggerPagedTurn(settings.rtlNav ? 1 : -1);
        } else if (ratio > 0.65) {
          triggerPagedTurn(settings.rtlNav ? -1 : 1);
        } else {
          toggleReaderChrome();
        }
      }
      return;
    }

    const directedVel = curl.turnDir === 'l2r' ? curl.vx : -curl.vx;
    const shouldCommit = !cancelled && (
      curl.progress > 0.32 ||
      (directedVel > 0.32 && curl.progress > 0.06)
    );

    if (curl.isBoundary) {
      if (shouldCommit && (pagesFromApi || chapterPages.length >= 2)) {
        goToAdjacentChapter(curl.stepDelta);
      }
      return;
    }

    if (curl.canCurl && curl.nodes) {
      const nodes = curl.nodes;
      const totalW = nodes.w * 2;
      const toBx = shouldCommit
        ? (curl.turnDir === 'l2r' ? totalW - 0.5 : 0.5)
        : (curl.turnDir === 'l2r' ? 0.5 : totalW - 0.5);

      const remaining = Math.abs(toBx - curl.bx) / totalW;
      const duration = Math.max(130, Math.min(340, Math.round(remaining * 400)));

      if (shouldCommit) {
        currentSpreadIndex = curl.targetIndex;
        lastSpreadChangeAt = Date.now();
      }

      animateCurlTo(nodes, curl.bx, curl.dy, toBx, 0, duration, 0, () => {
        renderStaticCurrentSpread();
      });
      return;
    }

    // Без анимации: мгновенный переход при свайпе
    if (shouldCommit) {
      currentSpreadIndex = curl.targetIndex;
      lastSpreadChangeAt = Date.now();
      renderStaticCurrentSpread();
    }
  }

  function cleanupPagedDragListeners() {
    window.removeEventListener('pointermove', onPagedPointerMove);
    window.removeEventListener('pointerup', onPagedPointerUp);
    window.removeEventListener('pointercancel', onPagedPointerCancel);
  }

  function onPagedPointerUp(e) {
    if (!curl.active || e.pointerId !== curl.pointerId) return;
    cleanupPagedDragListeners();
    curl.active = false;
    finishPagedDrag(false);
  }

  function onPagedPointerCancel(e) {
    if (!curl.active || e.pointerId !== curl.pointerId) return;
    cleanupPagedDragListeners();
    curl.active = false;
    finishPagedDrag(true);
  }

  // =========================================================================
  // 6. РЕЖИМ 2: БЕСКОНЕЧНАЯ ГОРИЗОНТАЛЬНАЯ ПОЛОСА (ПО 2 СТРАНИЦЫ ВБОК)
  // =========================================================================

  function resetStripState() {
    stripState.loadedKeys.clear();
    stripState.chaptersData.clear();
    stripState.lastLoadedRoute = null;
    stripState.loadingNext = false;
    stripState.noMoreChapters = false;
    stripState.userScrolled = false;
    clearTimeout(stripState.scrollTimer);
  }

  function buildStripChapterNodes(route, pages, includeStartDivider = false) {
    const groups = computeSpreadGroups(pages);
    const orderedGroups = settings.rtlNav ? [...groups].reverse() : groups;
    const fragment = document.createDocumentFragment();

    const makeSpreadEl = (group) => {
      const slots = mapGroupToSlots(group, pages);
      const wrap = document.createElement('div');
      wrap.className = 'ml-duo-strip-spread';
      wrap.dataset.chapterKey = route.key;
      wrap.dataset.firstPage = String(group.pages[0] + 1);

      if (slots.solo) {
        wrap.appendChild(createPageImg(slots.solo));
      } else {
        const pair = document.createElement('div');
        pair.className = 'ml-duo-strip-pair';
        if (slots.left) pair.appendChild(createPageImg(slots.left));
        if (slots.right) pair.appendChild(createPageImg(slots.right));
        wrap.appendChild(pair);
      }
      return wrap;
    };

    const makeDivider = () => {
      const div = document.createElement('div');
      div.className = 'ml-duo-strip-divider';
      div.innerHTML = `
        <div class="ml-duo-strip-div-title">Том ${route.volume} · Глава ${route.number}</div>
        <button type="button" class="ml-duo-strip-div-btn">Комментарии</button>
      `;
      div.querySelector('button').addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openCommentsView(route);
      });
      return div;
    };

    if (settings.rtlNav) {
      // В RTL сначала идут более дальние страницы (слева), затем первые (справа), а разделитель ставится перед новой главой (справа от неё)
      for (const g of orderedGroups) fragment.appendChild(makeSpreadEl(g));
      if (includeStartDivider) fragment.appendChild(makeDivider());
    } else {
      if (includeStartDivider) fragment.appendChild(makeDivider());
      for (const g of orderedGroups) fragment.appendChild(makeSpreadEl(g));
    }

    return fragment;
  }

  function renderHorizontalStrip() {
    const stage = document.getElementById('ml-duo-stage');
    if (!stage || !chapterPages.length || settings.readingMode !== 'strip') return;

    const route = parseChapterRoute() || { slug: '', volume: '1', number: '1', key: chapterKey || 'ch', langPrefix: '', hasRead: true };
    resetStripState();
    stripState.loadedKeys.add(route.key);
    stripState.lastLoadedRoute = route;
    stripState.chaptersData.set(route.key, { route, pages: chapterPages });

    stage.innerHTML = '';
    const track = document.createElement('div');
    track.className = 'ml-duo-strip-track';
    track.appendChild(buildStripChapterNodes(route, chapterPages, false));
    stage.appendChild(track);

    // Позиционируем полосу на текущий разворот
    const alignInitialScroll = () => {
      if (stripState.userScrolled) return;
      const spreads = Array.from(track.querySelectorAll('.ml-duo-strip-spread'));
      if (!spreads.length) return;
      const targetIdx = settings.rtlNav
        ? Math.max(0, spreads.length - 1 - currentSpreadIndex)
        : Math.min(spreads.length - 1, currentSpreadIndex);
      const targetEl = spreads[targetIdx];
      if (targetEl) {
        const left = targetEl.offsetLeft - Math.max(0, (stage.clientWidth - targetEl.offsetWidth) / 2);
        stage.scrollLeft = Math.max(0, left);
      } else if (settings.rtlNav) {
        stage.scrollLeft = stage.scrollWidth - stage.clientWidth;
      }
    };

    requestAnimationFrame(() => {
      alignInitialScroll();
      // Повторяем выравнивание после прогрузки первых картинок, если пользователь ещё не скроллил
      setTimeout(alignInitialScroll, 180);
      setTimeout(alignInitialScroll, 500);
    });

    // Заранее подгружаем список глав для бесконечной ленты
    if (route.slug) fetchMangaChaptersList(route.slug);
  }

  async function maybeLoadNextChapterInStrip() {
    if (settings.readingMode !== 'strip' || stripState.loadingNext || stripState.noMoreChapters) return;
    const stage = document.getElementById('ml-duo-stage');
    const track = stage?.querySelector('.ml-duo-strip-track');
    if (!stage || !track || !stripState.lastLoadedRoute?.slug) return;

    const distToEnd = settings.rtlNav
      ? stage.scrollLeft
      : (stage.scrollWidth - stage.clientWidth - stage.scrollLeft);

    if (distToEnd > window.innerWidth * 1.6) return;

    stripState.loadingNext = true;
    try {
      const cur = stripState.lastLoadedRoute;
      const chapters = await fetchMangaChaptersList(cur.slug);
      if (!chapters || !chapters.length) {
        stripState.noMoreChapters = true;
        return;
      }

      const idx = chapters.findIndex(c => c.volume === cur.volume && c.number === cur.number);
      const next = idx >= 0 && idx + 1 < chapters.length
        ? chapters[idx + 1]
        : chapters.find(c => compareChapterOrder(c, cur) > 0);

      if (!next) {
        stripState.noMoreChapters = true;
        appendEndOfMangaCard(track, cur);
        return;
      }

      const nextRoute = {
        langPrefix: cur.langPrefix || '',
        slug: cur.slug,
        hasRead: cur.hasRead,
        volume: next.volume,
        number: next.number,
        key: `${cur.slug}_${next.volume}_${next.number}`
      };

      if (stripState.loadedKeys.has(nextRoute.key)) {
        stripState.noMoreChapters = true;
        return;
      }

      const search = new URLSearchParams(location.search);
      const branchId = search.get('bid') || search.get('branch_id') || '';
      const pages = await fetchChapterPagesByRoute(nextRoute, branchId);
      if (!pages || !pages.length) {
        stripState.noMoreChapters = true;
        return;
      }

      stripState.loadedKeys.add(nextRoute.key);
      stripState.lastLoadedRoute = nextRoute;
      stripState.chaptersData.set(nextRoute.key, { route: nextRoute, pages });

      const frag = buildStripChapterNodes(nextRoute, pages, true);

      if (settings.rtlNav) {
        // В RTL добавляем новую главу СЛЕВА и компенсируем scrollLeft, чтобы экран не прыгал
        const prevScrollWidth = stage.scrollWidth;
        const prevScrollLeft = stage.scrollLeft;
        track.insertBefore(frag, track.firstChild);
        const added = stage.scrollWidth - prevScrollWidth;
        stage.scrollLeft = prevScrollLeft + added;
      } else {
        track.appendChild(frag);
      }
    } finally {
      stripState.loadingNext = false;
    }
  }

  function appendEndOfMangaCard(track, lastRoute) {
    if (track.querySelector('.ml-duo-strip-end')) return;
    const card = document.createElement('div');
    card.className = 'ml-duo-strip-divider ml-duo-strip-end';
    card.innerHTML = `
      <div class="ml-duo-strip-div-title">Конец доступных глав</div>
      <button type="button" class="ml-duo-strip-div-btn">Комментарии к главе</button>
    `;
    card.querySelector('button').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openCommentsView(lastRoute);
    });
    if (settings.rtlNav) {
      track.insertBefore(card, track.firstChild);
    } else {
      track.appendChild(card);
    }
  }

  function onStripScroll() {
    if (settings.readingMode !== 'strip') return;
    stripState.userScrolled = true;
    maybeLoadNextChapterInStrip();

    clearTimeout(stripState.scrollTimer);
    stripState.scrollTimer = setTimeout(() => {
      const stage = document.getElementById('ml-duo-stage');
      if (!stage) return;
      const centerX = stage.scrollLeft + stage.clientWidth / 2;
      const spreads = stage.querySelectorAll('.ml-duo-strip-spread');
      let best = null;
      let bestDist = Infinity;

      for (const el of spreads) {
        const mid = el.offsetLeft + el.offsetWidth / 2;
        const d = Math.abs(mid - centerX);
        if (d < bestDist) {
          bestDist = d;
          best = el;
        }
      }

      if (best) {
        const key = best.dataset.chapterKey;
        const pageNum = Number(best.dataset.firstPage) || 1;
        const ch = stripState.chaptersData.get(key);
        if (ch?.route) {
          activeChapterRoute = ch.route;
          syncPageQueryParam(pageNum, ch.route);
        } else {
          syncPageQueryParam(pageNum);
        }
      }
    }, 140);
  }

  function onStripWheel(e) {
    if (settings.readingMode !== 'strip' || isAnyModalOpen()) return;
    const stage = document.getElementById('ml-duo-stage');
    if (!stage) return;

    // Колёсико мыши (вертикальная прокрутка) превращаем в плавное движение полосы вбок
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault();
      stripState.userScrolled = true;
      const step = e.deltaY * 1.25;
      stage.scrollLeft += settings.rtlNav ? -step : step;
    }
  }

  function onStripPointerDown(e) {
    if (isAnyModalOpen()) return;
    if (e.target.closest('button')) return;

    // На планшете/таче отдаём прокрутку нативному скроллу браузера, но ловим короткий тап по центру для меню
    if (e.pointerType !== 'mouse') {
      stripState.panActive = true;
      stripState.panPointerId = e.pointerId;
      stripState.panStartX = e.clientX;
      stripState.panStartY = e.clientY;
      stripState.panMoved = false;
      window.addEventListener('pointermove', onStripTouchCheckMove, { passive: true });
      window.addEventListener('pointerup', onStripTouchCheckUp);
      return;
    }

    if (e.button !== 0) return;
    const stage = document.getElementById('ml-duo-stage');
    if (!stage) return;

    stripState.panActive = true;
    stripState.panPointerId = e.pointerId;
    stripState.panStartX = e.clientX;
    stripState.panStartY = e.clientY;
    stripState.panStartScroll = stage.scrollLeft;
    stripState.panMoved = false;

    window.addEventListener('pointermove', onStripMouseMove);
    window.addEventListener('pointerup', onStripMouseUp);
    window.addEventListener('pointercancel', onStripMouseUp);
  }

  function onStripTouchCheckMove(e) {
    if (!stripState.panActive || e.pointerId !== stripState.panPointerId) return;
    if (Math.hypot(e.clientX - stripState.panStartX, e.clientY - stripState.panStartY) > 10) {
      stripState.panMoved = true;
    }
  }

  function onStripTouchCheckUp(e) {
    if (!stripState.panActive || e.pointerId !== stripState.panPointerId) return;
    window.removeEventListener('pointermove', onStripTouchCheckMove);
    window.removeEventListener('pointerup', onStripTouchCheckUp);
    stripState.panActive = false;

    if (!stripState.panMoved) {
      const ratio = stripState.panStartX / (window.innerWidth || 1);
      if (ratio >= 0.25 && ratio <= 0.75) {
        toggleReaderChrome();
      }
    }
  }

  function onStripMouseMove(e) {
    if (!stripState.panActive || e.pointerId !== stripState.panPointerId) return;
    const stage = document.getElementById('ml-duo-stage');
    if (!stage) return;

    const dx = e.clientX - stripState.panStartX;
    if (!stripState.panMoved && Math.abs(dx) > 6) {
      stripState.panMoved = true;
      stripState.userScrolled = true;
      stage.classList.add('is-dragging');
    }

    if (stripState.panMoved) {
      stage.scrollLeft = stripState.panStartScroll - dx;
    }
  }

  function onStripMouseUp(e) {
    if (!stripState.panActive || e.pointerId !== stripState.panPointerId) return;
    window.removeEventListener('pointermove', onStripMouseMove);
    window.removeEventListener('pointerup', onStripMouseUp);
    window.removeEventListener('pointercancel', onStripMouseUp);
    stripState.panActive = false;

    const stage = document.getElementById('ml-duo-stage');
    if (stage) stage.classList.remove('is-dragging');

    if (!stripState.panMoved) {
      const vw = window.innerWidth || 1;
      const ratio = stripState.panStartX / vw;
      if (ratio >= 0.3 && ratio <= 0.7) {
        toggleReaderChrome();
      } else if (stage) {
        const dir = ratio < 0.3 ? -1 : 1;
        stage.scrollBy({ left: dir * Math.round(vw * 0.85), behavior: 'smooth' });
      }
    }
  }

  // =========================================================================
  // 7. ОБЩАЯ СЦЕНА, ПЕРЕХОД ПО ГЛАВАМ И ДИСПЕТЧЕР
  // =========================================================================

  function ensureStage() {
    let stage = document.getElementById('ml-duo-stage');
    if (stage) {
      stage.classList.toggle('mode-paged', settings.readingMode === 'paged');
      stage.classList.toggle('mode-strip', settings.readingMode === 'strip');
      return stage;
    }

    stage = document.createElement('div');
    stage.id = 'ml-duo-stage';
    stage.className = settings.readingMode === 'strip' ? 'mode-strip' : 'mode-paged';

    const bodyBg = getComputedStyle(document.body).backgroundColor;
    if (bodyBg && bodyBg !== 'rgba(0, 0, 0, 0)' && bodyBg !== 'transparent') {
      stage.style.setProperty('--ml-duo-bg', bodyBg);
    }

    stage.addEventListener('pointerdown', (e) => {
      if (settings.readingMode === 'strip') {
        onStripPointerDown(e);
      } else {
        onPagedPointerDown(e);
      }
    });

    stage.addEventListener('wheel', onStripWheel, { passive: false });
    stage.addEventListener('scroll', onStripScroll, { passive: true });

    stage.addEventListener('touchmove', (e) => {
      if (settings.readingMode === 'paged' && curl.active) {
        e.preventDefault();
      }
    }, { passive: false });

    stage.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      e.preventDefault();
      e.stopPropagation();
    });

    document.body.appendChild(stage);
    return stage;
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
      hiddenNativeContainer.classList.remove('ml-duo-native-masked', 'ml-duo-native-collapsed');
      hiddenNativeContainer = null;
    }
  }

  function cleanupDuoStage() {
    stopCurlAnimation();
    cleanupPagedDragListeners();
    curl.active = false;
    curl.isDragging = false;
    commentsOpen = false;
    resetStripState();

    const backBtn = document.getElementById('ml-duo-back-to-manga');
    if (backBtn) backBtn.remove();

    const stage = document.getElementById('ml-duo-stage');
    if (stage) stage.remove();

    restoreNativeContainer();
    document.documentElement.classList.remove('ml-duo-active', 'ml-duo-ui-hidden');
  }

  function getLayoutSig() {
    return `${chapterKey}|${chapterPages.length}|${cdnOrigin}|${settings.readingMode}|${settings.firstPageSide}|${settings.rtlNav}|${settings.pageCurl}|${settings.coverAlone}|${settings.autoWide}`;
  }

  function applyDuoLayout() {
    if (!isReaderPage() || !settings.enabled) {
      cleanupDuoStage();
      return;
    }

    if (commentsOpen) return;

    const nativeImgs = getNativeReaderImages();
    detectCdnFromBrowser();
    collectDomPagesFallback(nativeImgs);

    if (!pagesFromApi) {
      loadCurrentChapterFromApi();
    }

    if (!chapterPages.length) return;
    if (!cdnOrigin && !chapterPages[0].fullUrl && !isRealFullUrl(chapterPages[0].url)) {
      loadImageServersOnce();
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
    if (!curl.isDragging && !curl.isAnimating && (stage.dataset.sig !== sig || !stage.children.length)) {
      stage.dataset.sig = sig;
      if (settings.readingMode === 'strip') {
        renderHorizontalStrip();
      } else {
        renderStaticCurrentSpread();
      }
    }

    // Если был отложенный переход к комментариям другой главы — открываем сразу
    try {
      if (sessionStorage.getItem(COMMENTS_FLAG_KEY) === '1') {
        sessionStorage.removeItem(COMMENTS_FLAG_KEY);
        setTimeout(() => openCommentsView(), 200);
      }
    } catch (_) {}
  }

  function scheduleRender() {
    if (renderRaf) cancelAnimationFrame(renderRaf);
    renderRaf = requestAnimationFrame(() => {
      renderRaf = null;
      applyDuoLayout();
    });
  }

  // =========================================================================
  // 8. НАТИВНАЯ СЕКЦИЯ НАСТРОЕК ВНУТРИ МЕНЮ MANGALIB
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
          <span class="ml-duo-label">Режим листания</span>
          <div class="ml-duo-seg">
            <button type="button" class="ml-duo-seg-btn" data-mode="paged">Постранично</button>
            <button type="button" class="ml-duo-seg-btn" data-mode="strip">Полоса вбок</button>
          </div>
        </div>

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

        <div class="ml-duo-row ml-duo-paged-only">
          <span class="ml-duo-label">Анимация страницы (книга)</span>
          <label class="ml-duo-switch">
            <input type="checkbox" data-setting="pageCurl">
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

        <button type="button" class="ml-duo-action-btn" data-action="comments">
          Комментарии к главе (C)
        </button>
      </div>
    `;

    sec.querySelectorAll('input[data-setting]').forEach(input => {
      input.addEventListener('change', () => {
        saveSettings({ [input.dataset.setting]: input.checked });
      });
    });

    const fsInput = sec.querySelector('input[data-action="fullscreen"]');
    if (fsInput) fsInput.addEventListener('change', toggleFullscreen);

    const commentsBtn = sec.querySelector('button[data-action="comments"]');
    if (commentsBtn) {
      commentsBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (commentsOpen) {
          closeCommentsView();
        } else {
          openCommentsView();
        }
      });
    }

    sec.querySelectorAll('button[data-mode]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        saveSettings({ readingMode: btn.dataset.mode });
      });
    });

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

    sec.querySelectorAll('button[data-mode]').forEach(btn => {
      btn.classList.toggle('is-active', btn.dataset.mode === settings.readingMode);
    });

    sec.querySelectorAll('button[data-side]').forEach(btn => {
      btn.classList.toggle('is-active', btn.dataset.side === settings.firstPageSide);
    });

    const pagedOnly = sec.querySelector('.ml-duo-paged-only');
    if (pagedOnly) pagedOnly.style.display = settings.readingMode === 'paged' ? '' : 'none';

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
  // 9. КЛАВИАТУРА, ПЕРЕХВАТ РОДНОЙ КНОПКИ КОММЕНТАРИЕВ И ЗАПУСК
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
      initialDomRouteKey = '';
      activeChapterRoute = null;
      apiFetchInFlightFor = '';
      cleanupDuoStage();
      return;
    }

    // В режиме бесконечной полосы мы сами обновляем URL при прокрутке — не сбрасываем сцену, если глава уже в полосе
    if (settings.readingMode === 'strip' && stripState.loadedKeys.has(nextRoute.key)) {
      return;
    }

    if (!prevRoute || prevRoute.key !== nextRoute.key) {
      stopCurlAnimation();
      if (commentsOpen) closeCommentsView();
      chapterPages = [];
      pagesFromApi = false;
      chapterKey = '';
      initialDomRouteKey = nextRoute.key;
      activeChapterRoute = nextRoute;
      apiFetchInFlightFor = '';
      currentSpreadIndex = 0;
      uiHidden = settings.cleanScreen;
      resetStripState();

      const stage = document.getElementById('ml-duo-stage');
      if (stage) stage.remove();
      restoreNativeContainer();
      scheduleRender();
    }
  }

  function setupListeners() {
    // Если нажали на родную кнопку «Комментарии» в верхней/нижней панели MangaLib — открываем комментарии
    document.addEventListener('click', (e) => {
      if (!isReaderPage() || !settings.enabled || commentsOpen) return;
      const btn = e.target?.closest?.('a, button');
      if (!btn || btn.closest('#ml-duo-stage, #ml-duo-settings-section, #ml-duo-fallback-backdrop')) return;

      const metaText = `${btn.getAttribute('href') || ''} ${btn.getAttribute('title') || ''} ${btn.getAttribute('aria-label') || ''} ${btn.textContent || ''}`;
      if (/#comments|коммент|comment/i.test(metaText)) {
        setTimeout(() => {
          if (!isAnyModalOpen() && !commentsOpen) {
            openCommentsView();
          }
        }, 180);
      }
    }, true);

    window.addEventListener('keydown', (e) => {
      if (!isReaderPage()) return;

      const tag = (e.target?.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return;

      // Esc закрывает режим комментариев
      if (e.code === 'Escape' && commentsOpen) {
        e.preventDefault();
        closeCommentsView();
        return;
      }

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

      // C — открыть/закрыть комментарии к главе
      if (e.code === 'KeyC' && settings.enabled && !isAnyModalOpen()) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (commentsOpen) closeCommentsView();
        else openCommentsView();
        return;
      }

      // F — на весь экран
      if (e.code === 'KeyF' && !isAnyModalOpen()) {
        e.preventDefault();
        e.stopImmediatePropagation();
        toggleFullscreen();
        return;
      }

      if (!settings.enabled || commentsOpen || isAnyModalOpen()) return;
      const stage = document.getElementById('ml-duo-stage');
      if (!stage) return;

      // В режиме горизонтальной полосы клавиши плавно двигают ленту вбок
      if (settings.readingMode === 'strip') {
        const jump = Math.round(window.innerWidth * 0.85);
        if (e.code === 'ArrowLeft' || e.code === 'KeyA') {
          e.preventDefault();
          e.stopImmediatePropagation();
          stripState.userScrolled = true;
          stage.scrollBy({ left: -jump, behavior: 'smooth' });
        } else if (e.code === 'ArrowRight' || e.code === 'KeyD') {
          e.preventDefault();
          e.stopImmediatePropagation();
          stripState.userScrolled = true;
          stage.scrollBy({ left: jump, behavior: 'smooth' });
        } else if (e.code === 'Space') {
          e.preventDefault();
          e.stopImmediatePropagation();
          stripState.userScrolled = true;
          const dir = (e.shiftKey ? -1 : 1) * (settings.rtlNav ? -1 : 1);
          stage.scrollBy({ left: dir * jump, behavior: 'smooth' });
        }
        return;
      }

      // В постраничном режиме
      if (e.code === 'ArrowLeft' || e.code === 'KeyA') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        triggerPagedTurn(settings.rtlNav ? 1 : -1);
      } else if (e.code === 'ArrowRight' || e.code === 'KeyD') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        triggerPagedTurn(settings.rtlNav ? -1 : 1);
      } else if (e.code === 'Space') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        triggerPagedTurn(e.shiftKey ? -1 : 1);
      }
    }, true);

    window.addEventListener('resize', () => {
      if (isReaderPage() && settings.enabled && !commentsOpen && settings.readingMode === 'paged' && !curl.isDragging && !curl.isAnimating) {
        renderStaticCurrentSpread();
      }
    });

    document.addEventListener('fullscreenchange', () => {
      syncAllSettingsUI();
      if (isReaderPage() && settings.enabled && !commentsOpen && settings.readingMode === 'paged') {
        setTimeout(renderStaticCurrentSpread, 60);
      }
    });
    document.addEventListener('webkitfullscreenchange', () => {
      syncAllSettingsUI();
      if (isReaderPage() && settings.enabled && !commentsOpen && settings.readingMode === 'paged') {
        setTimeout(renderStaticCurrentSpread, 60);
      }
    });

    window.addEventListener('popstate', checkRouteChange);
    setInterval(checkRouteChange, 250);

    const observer = new MutationObserver((mutations) => {
      let needRender = false;
      let needSettings = false;

      for (const m of mutations) {
        if (m.target?.closest?.('#ml-duo-stage, #ml-duo-settings-section, #ml-duo-fallback-backdrop, #ml-duo-back-to-manga')) {
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

    const startRoute = parseChapterRoute();
    if (startRoute) {
      initialDomRouteKey = startRoute.key;
      activeChapterRoute = startRoute;
    }

    try {
      if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('Настройки mangalib-duo', openFallbackModal);
        GM_registerMenuCommand('Комментарии к главе (C)', () => {
          if (commentsOpen) closeCommentsView();
          else openCommentsView();
        });
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
