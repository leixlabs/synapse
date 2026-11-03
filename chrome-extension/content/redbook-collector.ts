/**
 * Redbook (Xiaohongshu) Content Collector
 *
 * Collects the currently logged-in account's notes from the creator service
 * platform "笔记管理" page:
 *   https://creator.xiaohongshu.com/new/note-manager
 *
 * Unlike the public profile feed (which exposes only the cover and title), the
 * creator page renders the operations data of every note, so each note is
 * collected together with 观看 / 评论 / 点赞 / 收藏 / 转发.
 *
 * Note cards carry no href: the note id is read from the `data-impression`
 * attribute (an analytics JSON payload) and turned into the canonical public
 * note URL, which is also the server-side dedupe key.
 */
(() => {
  const NOTE_MANAGER_PATH = '/new/note-manager';
  const CREATOR_HOST = 'creator.xiaohongshu.com';
  const NOTE_URL_PREFIX = 'https://www.xiaohongshu.com/explore/';

  /**
   * The five stat slots of a note card, in the fixed order the page renders
   * them: 观看, 评论, 点赞, 收藏, 转发.
   */
  const STAT_KEYS = ['views', 'comments', 'likes', 'collects', 'reposts'] as const;

  // ---------------------------------------------------------------------------
  // Generic helpers
  // ---------------------------------------------------------------------------

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function textOf(element: Element | null): string {
    if (!element) return '';
    return (element as HTMLElement).innerText?.trim() || element.textContent?.trim() || '';
  }

  /**
   * Parse a stat label such as `1234`, `1,234`, `1.2万`, `3.5w` into a number.
   * Returns undefined for placeholders and unparsable values.
   */
  function parseStatValue(raw: string): number | undefined {
    const text = (raw || '').replace(/,/g, '').trim();
    if (!text || text === '-' || text === '—' || text === '--') return undefined;

    const match = text.match(/^([\d.]+)\s*(万|亿|[wWkK])?/);
    if (!match) return undefined;

    const base = Number.parseFloat(match[1]);
    if (!Number.isFinite(base)) return undefined;

    const unit = (match[2] || '').toLowerCase();
    const factor =
      unit === '万' || unit === 'w' ? 10000 : unit === '亿' ? 100000000 : unit === 'k' ? 1000 : 1;

    return Math.round(base * factor);
  }

  function normalizeImageUrl(url: string): string {
    const value = (url || '').trim();
    if (!value) return '';
    // Covers are rendered over http, which a https page cannot fetch; the CDN
    // serves the same asset over https.
    return value.replace(/^http:\/\//, 'https://');
  }

  /**
   * Format the wall-clock time shown on the card ("2026-10-28 18:23") as ISO
   * 8601 in Beijing time, which is what the creator platform displays.
   */
  function formatNoteTime(raw: string): string {
    const match = (raw || '').match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
    if (!match) return '';
    const [, year, month, day, hour, minute] = match;
    return `${year}-${month}-${day}T${hour}:${minute}:00+08:00`;
  }

  // ---------------------------------------------------------------------------
  // Note card field extraction
  // ---------------------------------------------------------------------------

  /**
   * Read the note id out of the card's analytics attribute:
   * {"noteTarget":{"type":"NoteTarget","value":{"noteId":"6ae1cd0a..."}}, ...}
   */
  function extractNoteId(noteElement: Element): string {
    const raw = noteElement.getAttribute('data-impression') || '';
    if (!raw) return '';

    try {
      const parsed = JSON.parse(raw);
      const noteId = parsed?.noteTarget?.value?.noteId;
      if (noteId) return String(noteId);
    } catch (_) {
      /* fall through to the regex fallback */
    }

    const match = raw.match(/"noteId"\s*:\s*"([0-9a-zA-Z]+)"/);
    return match ? match[1] : '';
  }

  function extractNoteTitle(noteElement: Element): string {
    const titleElement = noteElement.querySelector('.note-card__title');
    if (!titleElement) return '';
    // Untitled notes are rendered as a greyed 无笔记标题 placeholder.
    if (titleElement.classList.contains('note-card__title--empty')) return '';

    const title = textOf(titleElement);
    return title === '无笔记标题' ? '' : title;
  }

  function extractNoteImages(noteElement: Element): string[] {
    const images: string[] = [];

    const cover = noteElement.querySelector('.note-card__media img.content');
    const coverSrc = normalizeImageUrl(cover?.getAttribute('src') || '');
    if (coverSrc && !coverSrc.startsWith('data:')) {
      images.push(coverSrc.split('?')[0]);
    }

    if (images.length === 0) {
      // Fallback: older layouts only set the cover as a CSS background image.
      const bg = noteElement.querySelector('.note-card__media .media-bg');
      const match = (bg?.getAttribute('style') || '').match(/url\(["']?([^"')]+)["']?\)/);
      if (match) {
        const src = normalizeImageUrl(match[1]);
        if (src) images.push(src.split('?')[0]);
      }
    }

    return images;
  }

  /** Video notes show a duration badge on the cover. */
  function extractNoteDuration(noteElement: Element): string {
    return textOf(noteElement.querySelector('.play_time'));
  }

  function extractNoteTimestamp(noteElement: Element): string {
    return formatNoteTime(textOf(noteElement.querySelector('.note-card__time')));
  }

  /**
   * Map the five stat slots of a card onto engagement metrics.
   * A zero is a real measurement and is kept; only missing slots are skipped.
   */
  function extractNoteEngagement(noteElement: Element): EngagementMetrics | undefined {
    const stats = Array.from(noteElement.querySelectorAll('.note-card__stat'));
    if (stats.length === 0) return undefined;

    const engagement: EngagementMetrics = {};
    stats.forEach((stat, index) => {
      const key = STAT_KEYS[index];
      if (!key) return;
      const span = stat.querySelector('span');
      const value = parseStatValue(textOf(span) || stat.textContent || '');
      if (value !== undefined) engagement[key] = value;
    });

    return Object.keys(engagement).length > 0 ? engagement : undefined;
  }

  function getAccountDisplayName(): string {
    return (
      textOf(document.querySelector('.user-info .name-box')) ||
      textOf(document.querySelector('.d-topbar-default .name-box'))
    );
  }

  // ---------------------------------------------------------------------------
  // Collection
  // ---------------------------------------------------------------------------

  /**
   * Find all note cards in the note manager list.
   */
  function findAllNotesRedbook(): Element[] {
    const scoped = Array.from(document.querySelectorAll('.notes-container .note-card'));
    return scoped.length > 0 ? scoped : Array.from(document.querySelectorAll('.note-card'));
  }

  /**
   * Collect data from a single note card.
   */
  function collectNoteDataRedbook(noteElement: Element): CollectedContent {
    const noteId = extractNoteId(noteElement);
    const title = extractNoteTitle(noteElement);
    const images = extractNoteImages(noteElement);
    const duration = extractNoteDuration(noteElement);
    const engagement = extractNoteEngagement(noteElement);
    const url = noteId ? `${NOTE_URL_PREFIX}${noteId}` : '';

    // Video notes carry a duration badge; the note manager exposes no video
    // file, so the public note URL stays the only reference.
    const type: ContentType = duration ? 'video' : images.length > 0 ? 'image' : 'text';

    const authorName = getAccountDisplayName();

    return {
      source: 'Redbook',
      type,
      text: title || '无标题笔记',
      images,
      videos: [],
      links: url ? [url] : [],
      tags: [],
      timestamp: extractNoteTimestamp(noteElement),
      url,
      author: {
        username: authorName,
        displayName: authorName,
      },
      collectedAt: new Date().toISOString(),
      engagement,
    };
  }

  // ---------------------------------------------------------------------------
  // Page detection
  // ---------------------------------------------------------------------------

  function isNoteManagerPage(): boolean {
    return (
      window.location.hostname === CREATOR_HOST &&
      window.location.pathname.indexOf(NOTE_MANAGER_PATH) === 0
    );
  }

  async function getPageInfo(): Promise<PageInfo> {
    if (!isNoteManagerPage()) {
      return {
        isTargetPage: false,
        itemCount: 0,
        currentUrl: window.location.href,
      };
    }

    return {
      isTargetPage: true,
      itemCount: findAllNotesRedbook().length,
      currentUrl: window.location.href,
      pageIdentifier: getAccountDisplayName(),
      accountName: getAccountDisplayName(),
    };
  }

  // ---------------------------------------------------------------------------
  // Auto-collect
  // ---------------------------------------------------------------------------

  async function tryAutoCollect(): Promise<void> {
    if (!isNoteManagerPage()) return;

    const response: any = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'GET_CONFIG' }, resolve);
    });

    const config = response?.config;
    if (!config) return;

    const enabledSources: string[] = config.enabledSources || [];
    if (!enabledSources.includes('redbook')) {
      console.log('[Synapse] Redbook auto-collect disabled');
      return;
    }

    const interval = config.collectIntervalMinutes ?? 240;
    const lastCollectForSource = config.lastCollectTimes?.redbook;
    const lastCollect = lastCollectForSource ? new Date(lastCollectForSource).getTime() : 0;

    if (interval > 0 && lastCollect > 0) {
      const minsSinceLast = (Date.now() - lastCollect) / (1000 * 60);
      if (minsSinceLast < interval) {
        console.log(
          `[Synapse] Skipping auto-collect for Redbook: last collect was ${minsSinceLast.toFixed(2)} mins ago (interval: ${interval}m)`,
        );
        return;
      }
    }

    // The note list is rendered asynchronously after the page shell.
    await sleep(1500);

    const notes = findAllNotesRedbook();
    if (notes.length === 0) {
      console.log('[Synapse] Redbook: No notes found on the note manager page');
      return;
    }

    const contents = notes.map(collectNoteDataRedbook).filter((item) => item.url);

    console.log(`[Synapse] Redbook: Collecting ${contents.length} notes`);
    if (contents.length === 0) return;

    chrome.runtime.sendMessage(
      { type: 'CONTENT_TO_BG_PROCESS', contents, pageUID: getAccountDisplayName() },
      (result) => {
        if (result?.success) {
          console.log(`[Synapse] Redbook auto-collected ${result.collected} items`);
        } else {
          console.log('[Synapse] Redbook auto-collect failed', result?.error);
        }
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Message listeners
  // ---------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'POP_TO_CONTENT_COLLECT') {
      if (!isNoteManagerPage()) {
        sendResponse({ success: false, error: 'Not a Redbook note manager page' });
        return true;
      }

      const contents = findAllNotesRedbook()
        .map(collectNoteDataRedbook)
        .filter((item) => item.url);

      if (contents.length === 0) {
        sendResponse({ success: false, error: 'No notes found on page' });
        return true;
      }

      chrome.runtime.sendMessage(
        { type: 'CONTENT_TO_BG_PROCESS', contents, pageUID: getAccountDisplayName() },
        (response) => sendResponse(response),
      );
      return true;
    }

    if (message.type === 'GET_PAGE_INFO') {
      getPageInfo().then((info) => sendResponse(info));
      return true;
    }

    return true;
  });

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------

  chrome.runtime.sendMessage({ type: 'CONTENT_SCRIPT_READY', source: 'redbook' });
  tryAutoCollect();

  let lastUrl = window.location.href;
  const observer = new MutationObserver(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      tryAutoCollect();
    }
  });
  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  }

  console.log('[Redbook Collector] Script loaded');
})();
