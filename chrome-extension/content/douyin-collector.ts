/**
 * Douyin (抖音) Content Collector
 *
 * Collects the currently logged-in account's works from the creator console
 * "内容管理 → 作品" page:
 *   https://creator.douyin.com/creator-micro/content/manage
 *
 * Unlike the public profile feed, this page renders the operations data of every
 * work, so each work is collected together with all nine metric slots the card
 * shows: 播放 / 点赞 / 评论 / 分享 / 收藏 / 弹幕 / 封面点击率 / 平均播放占比 / 吸粉量.
 *
 * The cards expose no work id: there is no href and no data-* attribute pointing
 * at the video. The id is therefore read from the console's own list API
 * (`/janus/douyin/creator/pc/work_list`, requested with the account cookies from
 * the page), which lets every work carry a playable URL:
 *   https://www.douyin.com/user/self?modal_id=<aweme id>
 * When that API is unavailable the collector falls back to an archive key built
 * from the publish time plus the cover image's stable object path, and the URL
 * points back at the console page that lists the work.
 */
(() => {
  const CONTENT_HOST = 'creator.douyin.com';
  const CONTENT_MANAGE_PATH = '/creator-micro/content/manage';
  const MANAGE_URL = 'https://creator.douyin.com/creator-micro/content/manage';

  /**
   * Metric label as rendered on the card → the engagement field it feeds.
   * All nine slots of the card are mapped, by label text rather than position.
   */
  const METRIC_LABELS: Record<
    string,
    | 'views'
    | 'likes'
    | 'comments'
    | 'reposts'
    | 'collects'
    | 'danmaku'
    | 'fans'
    | 'coverClickRate'
    | 'avgPlayRatio'
  > = {
    播放: 'views',
    点赞: 'likes',
    评论: 'comments',
    分享: 'reposts',
    收藏: 'collects',
    弹幕: 'danmaku',
    吸粉量: 'fans',
    封面点击率: 'coverClickRate',
    平均播放占比: 'avgPlayRatio',
  };

  /** Engagement fields the console renders as a percentage (`6.51%`). */
  const PERCENT_METRICS = new Set(['coverClickRate', 'avgPlayRatio']);

  const DURATION_PATTERN = /^\d{1,2}:\d{2}(?::\d{2})?$/;

  /** Public page that opens a work in a player, given its id. */
  const SELF_MODAL_URL = 'https://www.douyin.com/user/self?modal_id=';
  const VIDEO_URL = 'https://www.douyin.com/video/';

  /**
   * Same-origin list API the console itself calls to render the works tab. Its
   * `aweme_list` entries carry the work id the DOM hides.
   */
  const WORK_LIST_API = '/janus/douyin/creator/pc/work_list';
  /** Work statuses of the works tab: 创建, 审核中, 已发布, 仅自见, 直播回放. */
  const WORK_LIST_STATUS = '0,1,2,3,6';
  const WORK_LIST_PAGE_SIZE = 20;
  const WORK_LIST_MAX_PAGES = 5;

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

  /** Douyin class names carry a build hash (`video-card-sfaSzz`), so match the prefix. */
  function hasClassPrefix(element: Element, prefix: string): boolean {
    return Array.from(element.classList || []).some((name) => name.startsWith(prefix));
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

  /**
   * Parse a rate such as `6.51%`, `40%` or `0` into a percentage number
   * (`6.51` means 6.51%), rounded to two decimals. Returns undefined for
   * placeholders and unparsable values.
   */
  function parsePercentValue(raw: string): number | undefined {
    const text = (raw || '').replace(/,/g, '').trim();
    if (!text || text === '-' || text === '—' || text === '--' || text === '%') {
      return undefined;
    }

    const match = text.match(/^([\d.]+)\s*%?/);
    if (!match) return undefined;

    const base = Number.parseFloat(match[1]);
    if (!Number.isFinite(base)) return undefined;

    return Math.round(base * 100) / 100;
  }

  /** Style attributes reach the DOM with HTML entities already decoded, but be safe. */
  function decodeEntities(value: string): string {
    return value.replace(/&amp;/g, '&').replace(/&quot;/g, '"');
  }

  /**
   * Format the wall-clock time shown on the card ("2026年10月31日 07:03") as
   * ISO 8601 in Beijing time, which is what the creator console displays.
   */
  function formatWorkTime(raw: string): string {
    const match = (raw || '').match(
      /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(\d{1,2}):(\d{2})/,
    );
    if (!match) return '';

    const [, year, month, day, hour, minute] = match;
    const pad = (value: string) => value.padStart(2, '0');
    return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${minute}:00+08:00`;
  }

  // ---------------------------------------------------------------------------
  // Work card field extraction
  // ---------------------------------------------------------------------------

  /**
   * The cover is painted as a CSS background on the media box; the URL is signed
   * but the object path in front of `~tplv` identifies the asset and stays put.
   */
  function extractCoverUrl(workElement: Element): string {
    const cover = workElement.querySelector('[class*="video-card-cover"]');
    const match = (cover?.getAttribute('style') || '').match(/url\(["']?([^"')]+)["']?\)/);
    if (!match) return '';
    return decodeEntities(match[1]).trim();
  }

  function coverObjectKey(coverUrl: string): string {
    if (!coverUrl) return '';
    try {
      const fileName = (new URL(coverUrl).pathname.split('/').pop() || '').trim();
      // `tos-cn-i-xxx/<key>~tplv-...resize...webp` → <key>
      return fileName.split('~')[0];
    } catch (_) {
      return '';
    }
  }

  function extractWorkTitle(workElement: Element): string {
    return textOf(workElement.querySelector('[class*="info-title-text"]'));
  }

  function extractWorkTimestamp(workElement: Element): string {
    return formatWorkTime(textOf(workElement.querySelector('[class*="info-time"]')));
  }

  /** Video works carry a `05:50` duration badge on the cover. */
  function extractWorkDuration(workElement: Element): string {
    const badges = Array.from(workElement.querySelectorAll('[class*="badge-"]'));
    for (const badge of badges) {
      const value = textOf(badge);
      if (DURATION_PATTERN.test(value)) return value;
    }
    return '';
  }

  /**
   * Map the card's metric slots onto engagement metrics by label text.
   * A zero is a real measurement and is kept; unmapped slots are skipped.
   * Rate slots are read as percentages, everything else as counts.
   */
  function extractWorkEngagement(workElement: Element): EngagementMetrics | undefined {
    const engagement: EngagementMetrics = {};

    workElement.querySelectorAll('[class*="metric-label"]').forEach((labelElement) => {
      const key = METRIC_LABELS[textOf(labelElement)];
      if (!key) return;

      const item = labelElement.closest('[class*="metric-item"]') || labelElement.parentElement;
      const raw = textOf(item?.querySelector('[class*="metric-value"]') || null);
      const value = PERCENT_METRICS.has(key) ? parsePercentValue(raw) : parseStatValue(raw);
      if (value !== undefined) engagement[key] = value;
    });

    return Object.keys(engagement).length > 0 ? engagement : undefined;
  }

  /** Hashtags are part of the caption text; store them without the leading `#`. */
  function extractHashtags(text: string): string[] {
    const tags = new Set<string>();
    for (const match of (text || '').matchAll(/#([\w\u4e00-\u9fa5]+)/g)) {
      tags.add(match[1]);
    }
    return Array.from(tags);
  }

  /**
   * Stable archive key for a work. The console hides the work id, so identity is
   * (publish time + cover object path); both survive reloads and re-collections.
   * The time is compacted to `YYYYMMDDHHmm` so the URL stays readable.
   */
  function buildWorkKey(workElement: Element, timestamp: string, title: string): string {
    const coverKey = coverObjectKey(extractCoverUrl(workElement));
    const compactTime = (timestamp.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/) || [])
      .slice(1)
      .join('');
    const parts = [compactTime, coverKey].filter(Boolean);
    if (parts.length > 0) return parts.join('-');
    return title;
  }

  /**
   * The console does not render the account nickname (it lives in the avatar
   * popover), so this normally stays empty and the author fields are omitted.
   */
  function getAccountDisplayName(): string {
    return (
      textOf(document.querySelector('[class*="header-account-name"]')) ||
      textOf(document.querySelector('[class*="nickname"]')) ||
      textOf(document.querySelector('[class*="user-name"]'))
    );
  }

  // ---------------------------------------------------------------------------
  // Collection
  // ---------------------------------------------------------------------------

  /**
   * Find all work cards in the content list.
   *
   * Every card part carries the `video-card-` prefix (`video-card-content-`,
   * `video-card-cover-`, `video-card-info-`), so a card is the node that owns both
   * a cover and a title. When such nodes nest, keep the innermost one: a future
   * list wrapper would otherwise swallow every card below it.
   */
  function findAllWorksDouyin(): Element[] {
    const candidates = Array.from(document.querySelectorAll('[class*="video-card-"]'))
      .filter((element) => hasClassPrefix(element, 'video-card-'))
      .filter((element) => element.querySelector('[class*="video-card-cover"]'))
      .filter((element) => element.querySelector('[class*="info-title-text"]'));

    return candidates.filter(
      (element) => !candidates.some((other) => other !== element && element.contains(other)),
    );
  }

  /**
   * Collect data from a single work card.
   */
  function collectWorkDataDouyin(
    workElement: Element,
    pool?: WorkIdentity[],
  ): CollectedContent {
    const title = extractWorkTitle(workElement);
    const coverUrl = extractCoverUrl(workElement);
    const duration = extractWorkDuration(workElement);
    const timestamp = extractWorkTimestamp(workElement);
    const engagement = extractWorkEngagement(workElement);

    const identity = pool ? takeWorkIdentity(pool, timestamp, title) : undefined;
    const workId = identity ? identity.id : '';

    const key = workId ? `work-${workId}` : buildWorkKey(workElement, timestamp, title);
    const url = workId
      ? `${SELF_MODAL_URL}${workId}`
      : key
        ? `${MANAGE_URL}#work=${encodeURIComponent(key)}`
        : MANAGE_URL;

    // Video works carry a duration badge; image works (图文) only have a cover.
    const type: ContentType = duration ? 'video' : coverUrl ? 'image' : 'text';

    const authorName = getAccountDisplayName();
    const text = title || '无标题作品';

    return {
      source: 'Douyin',
      type,
      text,
      images: coverUrl ? [coverUrl] : [],
      videos: [],
      links: workId ? buildWorkLinks(workId, type) : [url],
      tags: extractHashtags(text),
      timestamp,
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
  // Work ids (resolved from the console's own list API)
  // ---------------------------------------------------------------------------

  /** A work as described by the list API: its id plus what we match it on. */
  interface WorkIdentity {
    id: string;
    createTime: number;
    desc: string;
  }

  let workIdentitiesPromise: Promise<WorkIdentity[]> | null = null;

  /**
   * Drop the cached work list. The console is a single page app, so the list
   * changes with the tab and is re-read after every navigation.
   */
  function resetWorkIdentities(): void {
    workIdentitiesPromise = null;
  }

  /**
   * Read the work ids from the console's list API.
   *
   * The request runs in the page context with the account cookies, which is
   * exactly how the console itself loads the works tab, so no signature is
   * needed. Returns an empty array when the API is unreachable or answers with
   * an error; the collector then falls back to the time+cover archive key.
   */
  function fetchWorkIdentities(): Promise<WorkIdentity[]> {
    if (workIdentitiesPromise) return workIdentitiesPromise;

    workIdentitiesPromise = (async () => {
      const identities: WorkIdentity[] = [];
      let cursor = 0;

      for (let page = 0; page < WORK_LIST_MAX_PAGES; page++) {
        const params = new URLSearchParams({
          status: WORK_LIST_STATUS,
          count: String(WORK_LIST_PAGE_SIZE),
          max_cursor: String(cursor),
          scene: 'star_atlas',
          device_platform: 'android',
        });

        const response = await fetch(`${WORK_LIST_API}?${params.toString()}`, {
          credentials: 'include',
          headers: { accept: 'application/json' },
        });
        if (!response.ok) break;

        const data: any = await response.json();
        const works: any[] = Array.isArray(data && data.aweme_list) ? data.aweme_list : [];
        for (const work of works) {
          const id = String((work && (work.aweme_id || work.item_id)) || '');
          if (!id) continue;
          identities.push({
            id,
            createTime: Number(work.create_time) || 0,
            desc: typeof work.desc === 'string' ? work.desc : '',
          });
        }

        if (!data || !data.has_more) break;
        const next = Number(data.max_cursor);
        if (!Number.isFinite(next) || next === 0 || next === cursor) break;
        cursor = next;
      }

      console.log(`[Synapse] Douyin: resolved ${identities.length} work ids`);
      return identities;
    })().catch((error) => {
      console.log('[Synapse] Douyin: work list API unavailable', error);
      return [] as WorkIdentity[];
    });

    return workIdentitiesPromise;
  }

  function normalizeTitle(value: string): string {
    return (value || '').replace(/\s+/g, '').trim();
  }

  /**
   * Take (and consume) the identity matching a card. Publish time is the
   * reliable key — both the card and the API round to the minute — with the
   * caption as fallback. Consuming keeps one id from landing on two cards.
   */
  function takeWorkIdentity(
    pool: WorkIdentity[],
    timestamp: string,
    title: string,
  ): WorkIdentity | undefined {
    if (pool.length === 0) return undefined;

    const publishedAt = timestamp ? Math.floor(new Date(timestamp).getTime() / 1000) : 0;
    if (publishedAt > 0) {
      const byTime = pool.findIndex(
        (identity) => identity.createTime > 0 && Math.abs(identity.createTime - publishedAt) <= 60,
      );
      if (byTime >= 0) return pool.splice(byTime, 1)[0];
    }

    const wanted = normalizeTitle(title);
    if (wanted) {
      const byTitle = pool.findIndex((identity) => normalizeTitle(identity.desc) === wanted);
      if (byTitle >= 0) return pool.splice(byTitle, 1)[0];
    }

    return undefined;
  }

  /** Links that play the work, known once the id is resolved. */
  function buildWorkLinks(id: string, type: ContentType): string[] {
    const links = [`${SELF_MODAL_URL}${id}`];
    if (type === 'video') links.push(`${VIDEO_URL}${id}`);
    return links;
  }

  /**
   * Collect every work on the page, each enriched with its work id. A hung list
   * API must not hold up the collection, so it is given ten seconds before the
   * cards are collected on their own.
   */
  async function collectAllWorksDouyin(): Promise<CollectedContent[]> {
    const pool = await Promise.race([
      fetchWorkIdentities(),
      sleep(10000).then(() => [] as WorkIdentity[]),
    ]);
    return findAllWorksDouyin().map((workElement) => collectWorkDataDouyin(workElement, pool));
  }

  // ---------------------------------------------------------------------------
  // Page detection
  // ---------------------------------------------------------------------------

  function isContentManagePage(): boolean {
    return (
      window.location.hostname === CONTENT_HOST &&
      window.location.pathname.indexOf(CONTENT_MANAGE_PATH) === 0
    );
  }

  async function getPageInfo(): Promise<PageInfo> {
    if (!isContentManagePage()) {
      return {
        isTargetPage: false,
        itemCount: 0,
        currentUrl: window.location.href,
      };
    }

    const accountName = getAccountDisplayName();

    return {
      isTargetPage: true,
      itemCount: findAllWorksDouyin().length,
      currentUrl: window.location.href,
      pageIdentifier: accountName,
      accountName,
    };
  }

  // ---------------------------------------------------------------------------
  // Auto-collect
  // ---------------------------------------------------------------------------

  async function tryAutoCollect(): Promise<void> {
    if (!isContentManagePage()) return;

    const response: any = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'GET_CONFIG' }, resolve);
    });

    const config = response?.config;
    if (!config) return;

    const enabledSources: string[] = config.enabledSources || [];
    if (!enabledSources.includes('douyin')) {
      console.log('[Synapse] Douyin auto-collect disabled');
      return;
    }

    const interval = config.collectIntervalMinutes ?? 240;
    const lastCollectForSource = config.lastCollectTimes?.douyin;
    const lastCollect = lastCollectForSource ? new Date(lastCollectForSource).getTime() : 0;

    if (interval > 0 && lastCollect > 0) {
      const minsSinceLast = (Date.now() - lastCollect) / (1000 * 60);
      if (minsSinceLast < interval) {
        console.log(
          `[Synapse] Skipping auto-collect for Douyin: last collect was ${minsSinceLast.toFixed(2)} mins ago (interval: ${interval}m)`,
        );
        return;
      }
    }

    // The work list is rendered asynchronously after the console shell.
    await sleep(1500);

    const contents = await collectAllWorksDouyin();
    if (contents.length === 0) {
      console.log('[Synapse] Douyin: No works found on the content manage page');
      return;
    }

    console.log(`[Synapse] Douyin: Collecting ${contents.length} works`);

    chrome.runtime.sendMessage(
      { type: 'CONTENT_TO_BG_PROCESS', contents, pageUID: getAccountDisplayName() },
      (result) => {
        if (result?.success) {
          console.log(`[Synapse] Douyin auto-collected ${result.collected} items`);
        } else {
          console.log('[Synapse] Douyin auto-collect failed', result?.error);
        }
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Message listeners
  // ---------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'POP_TO_CONTENT_COLLECT') {
      if (!isContentManagePage()) {
        sendResponse({ success: false, error: 'Not a Douyin content manage page' });
        return true;
      }

      collectAllWorksDouyin().then((contents) => {
        if (contents.length === 0) {
          sendResponse({ success: false, error: 'No works found on page' });
          return;
        }

        chrome.runtime.sendMessage(
          { type: 'CONTENT_TO_BG_PROCESS', contents, pageUID: getAccountDisplayName() },
          (response) => sendResponse(response),
        );
      });
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

  chrome.runtime.sendMessage({ type: 'CONTENT_SCRIPT_READY', source: 'douyin' });
  tryAutoCollect();

  let lastUrl = window.location.href;
  const observer = new MutationObserver(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      resetWorkIdentities();
      tryAutoCollect();
    }
  });
  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  }

  console.log('[Douyin Collector] Script loaded');
})();
