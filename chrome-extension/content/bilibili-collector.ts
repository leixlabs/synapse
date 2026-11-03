/**
 * Bilibili Content Collector
 *
 * Collects the logged-in UP's works from the creator center "稿件管理" page:
 *   https://member.bilibili.com/platform/upload-manager/article
 *
 * The public space feed exposes no operational data, whereas the creator list
 * renders every work together with its 运营数据, so each card is collected with
 * its engagement metrics attached:
 *   播放 / 点赞 / 弹幕 / 评论 / 硬币 / 收藏 / 分享
 *
 * Each card links to the public work URL (video/BVxxx or read/cvxxx) from its
 * cover anchor; that URL is the dedupe key on the server side.
 */
(() => {
  const CREATOR_HOST = 'member.bilibili.com';
  const UPLOAD_MANAGER_PATH = '/platform/upload-manager';

  /**
   * Stat slots of a card. The page labels every slot through its `title`
   * attribute, so the mapping survives a reordering of the slots.
   * Bilibili calls the tipping metric 硬币 in the creator list.
   */
  const STAT_TITLES: Record<string, keyof EngagementMetrics> = {
    播放: 'views',
    点赞: 'likes',
    弹幕: 'danmaku',
    评论: 'comments',
    硬币: 'coins',
    收藏: 'collects',
    分享: 'reposts',
  };

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
   * Returns undefined for the `-` placeholder and unparsable values.
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
   * Normalize a protocol-relative CDN URL to https and drop the transform
   * suffix (`@308w_174h`), keeping the original asset.
   */
  function normalizeCoverUrl(raw: string): string {
    const value = (raw || '').trim();
    if (!value) return '';

    const withScheme = value.startsWith('//')
      ? `https:${value}`
      : value.replace(/^http:\/\//, 'https://');

    return withScheme.split('@')[0].split('?')[0];
  }

  /**
   * Normalize a card link to the canonical public work URL. The list renders
   * protocol-relative hrefs and may append tracking params.
   */
  function normalizeWorkUrl(raw: string): string {
    const value = (raw || '').trim();
    if (!value) return '';

    let url = value.startsWith('//') ? `https:${value}` : value;
    if (!/^https?:\/\//.test(url)) return '';
    url = url.replace(/^http:\/\//, 'https://');
    return url.split('#')[0].split('?')[0];
  }

  /**
   * Format the wall-clock publish time shown on the card
   * ("2026年10月31日 20:30:00") as ISO 8601 in Beijing time.
   */
  function formatPublishTime(raw: string): string {
    const match = (raw || '').match(
      /(\d{4})\s*[年/.-]\s*(\d{1,2})\s*[月/.-]\s*(\d{1,2})\s*日?(?:\s*(\d{1,2}):(\d{2})(?::(\d{2}))?)?/,
    );
    if (!match) return '';

    const pad = (value: string | undefined) => (value || '0').padStart(2, '0');
    const [, year, month, day, hour, minute, second] = match;
    return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}+08:00`;
  }

  // ---------------------------------------------------------------------------
  // Account identity
  // ---------------------------------------------------------------------------

  /**
   * The creator header renders only the avatar (no nickname, no UID), so the
   * session cookie's DedeUserID is the only reliable account identifier.
   */
  function getAccountUid(): string {
    const cookieMatch = document.cookie.match(/(?:^|;\s*)DedeUserID=(\d+)/);
    if (cookieMatch) return cookieMatch[1];

    const links = Array.from(
      document.querySelectorAll(
        'a.avatar, .header-popover-avatar a, a[href*="space.bilibili.com"]',
      ),
    );
    for (const link of links) {
      const match = (link.getAttribute('href') || '').match(/space\.bilibili\.com\/(\d+)/);
      if (match) return match[1];
    }
    return '';
  }

  /**
   * Last-resort identifier: the avatar's face hash is stable per account.
   */
  function getAccountFaceHash(): string {
    const img = document.querySelector('a.avatar img') as HTMLImageElement | null;
    const src = img?.getAttribute('src') || '';
    const match = src.match(/bfs\/face\/([0-9a-zA-Z]+)\./);
    return match ? match[1] : '';
  }

  function getAccountDisplayName(): string {
    const nameElement = document.querySelector(
      '.up-name, .nickname, .header-popover-avatar .name, [class*="nickname"]',
    );
    const name = textOf(nameElement);
    if (name) return name;

    // Existing Bilibili entries store the UID as the display name.
    return getAccountUid();
  }

  function getAccountIdentity(): AuthorInfo {
    const uid = getAccountUid();
    const faceHash = uid ? '' : getAccountFaceHash();
    const username = uid || (faceHash ? `bili-face-${faceHash.slice(0, 12)}` : '');

    // The avatar face hash is only a fallback identifier, never a display name.
    return {
      username,
      displayName: getAccountDisplayName() || 'Bilibili',
    };
  }

  // ---------------------------------------------------------------------------
  // Card field extraction
  // ---------------------------------------------------------------------------

  function extractTitle(card: Element): string {
    const titleElement = card.querySelector('.meta-title .name, .meta-title a, .name');
    const title = textOf(titleElement);
    if (title) return title;

    const cover = card.querySelector('a.cover-wrp img, img.cover-img') as HTMLImageElement | null;
    return (cover?.getAttribute('alt') || '').trim();
  }

  function extractWorkUrl(card: Element): string {
    const anchors = [
      card.querySelector('a.cover-wrp'),
      card.querySelector('.meta-title a'),
      card.querySelector('a[href*="/video/"]'),
      card.querySelector('a[href*="/read/"]'),
    ];

    for (const anchor of anchors) {
      const url = normalizeWorkUrl(anchor?.getAttribute('href') || '');
      if (url) return url;
    }
    return '';
  }

  function extractCover(card: Element): string[] {
    const cover = card.querySelector('a.cover-wrp img, img.cover-img') as HTMLImageElement | null;
    const url = normalizeCoverUrl(cover?.getAttribute('src') || cover?.src || '');
    return url ? [url] : [];
  }

  function extractDuration(card: Element): string {
    return textOf(card.querySelector('.duration'));
  }

  function extractPublishTime(card: Element): string {
    const dateElement = card.querySelector('.pubdate .date') || card.querySelector('.pubdate');
    return formatPublishTime(textOf(dateElement));
  }

  /**
   * Map every stat slot of the card onto engagement metrics. A zero is a real
   * measurement and is kept; only missing slots are skipped.
   */
  function extractEngagement(card: Element): EngagementMetrics | undefined {
    const stats = Array.from(card.querySelectorAll('.meta-footer .view-stat, .view-stat'));
    if (stats.length === 0) return undefined;

    const engagement: EngagementMetrics = {};
    for (const stat of stats) {
      const key = STAT_TITLES[(stat.getAttribute('title') || '').trim()];
      if (!key) continue;

      const value = parseStatValue(textOf(stat.querySelector('.icon-text')) || textOf(stat));
      if (value !== undefined) engagement[key] = value;
    }

    return Object.keys(engagement).length > 0 ? engagement : undefined;
  }

  function collectArchiveDataBilibili(card: Element): CollectedContent | null {
    const title = extractTitle(card);
    const url = extractWorkUrl(card);
    if (!title || !url) return null;

    const duration = extractDuration(card);
    const timestamp = extractPublishTime(card) || new Date().toISOString();
    const author = getAccountIdentity();

    // 图文 works live under /read/, everything else is a video submission.
    const type: ContentType = duration || !url.includes('/read/') ? 'video' : 'article';

    return {
      source: 'Bilibili',
      type,
      text: title,
      images: extractCover(card),
      videos: [],
      links: [url],
      tags: [],
      timestamp,
      url,
      author: { username: author.username, displayName: author.displayName },
      collectedAt: new Date().toISOString(),
      engagement: extractEngagement(card),
    };
  }

  // ---------------------------------------------------------------------------
  // Collection
  // ---------------------------------------------------------------------------

  /**
   * Find every work card in the 稿件管理 list. Only the current page of the
   * list is rendered, so this returns the visible batch.
   */
  function findAllArchivesBilibili(): Element[] {
    if (!isUploadManagerPage()) return [];

    const scoped = Array.from(document.querySelectorAll('.article-list_wrap .article-card'));
    return scoped.length > 0 ? scoped : Array.from(document.querySelectorAll('.article-card'));
  }

  function collectAllBilibili(): CollectedContent[] {
    const seen = new Set<string>();
    const results: CollectedContent[] = [];

    for (const card of findAllArchivesBilibili()) {
      const content = collectArchiveDataBilibili(card);
      if (!content) continue;
      if (seen.has(content.url)) continue;
      seen.add(content.url);
      results.push(content);
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // Page detection
  // ---------------------------------------------------------------------------

  function isUploadManagerPage(): boolean {
    return (
      window.location.hostname === CREATOR_HOST &&
      window.location.pathname.indexOf(UPLOAD_MANAGER_PATH) === 0
    );
  }

  async function getPageInfo(): Promise<PageInfo> {
    if (!isUploadManagerPage()) {
      return {
        isTargetPage: false,
        itemCount: 0,
        currentUrl: window.location.href,
      };
    }

    const author = getAccountIdentity();
    return {
      isTargetPage: true,
      itemCount: findAllArchivesBilibili().length,
      currentUrl: window.location.href,
      pageIdentifier: author.username || author.displayName,
      accountName: author.displayName,
    };
  }

  // ---------------------------------------------------------------------------
  // Auto-collect
  // ---------------------------------------------------------------------------

  async function tryAutoCollect(): Promise<void> {
    if (!isUploadManagerPage()) return;

    const response: any = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'GET_CONFIG' }, resolve);
    });

    const config = response?.config;
    if (!config) return;

    const enabledSources: string[] = config.enabledSources || [];
    if (!enabledSources.includes('bilibili')) {
      console.log('[Synapse] Bilibili auto-collect disabled');
      return;
    }

    const interval = config.collectIntervalMinutes ?? 240;
    const lastCollectForSource = config.lastCollectTimes?.bilibili;
    const lastCollect = lastCollectForSource ? new Date(lastCollectForSource).getTime() : 0;

    if (interval > 0 && lastCollect > 0) {
      const minsSinceLast = (Date.now() - lastCollect) / (1000 * 60);
      if (minsSinceLast < interval) {
        console.log(
          `[Synapse] Skipping auto-collect for Bilibili: last collect was ${minsSinceLast.toFixed(2)} mins ago (interval: ${interval}m)`,
        );
        return;
      }
    }

    // The list is rendered asynchronously after the page shell.
    await sleep(1500);

    const contents = collectAllBilibili();
    if (contents.length === 0) {
      console.log('[Synapse] Bilibili: no works found on the upload manager page');
      return;
    }

    console.log(`[Synapse] Bilibili: collecting ${contents.length} works`);

    chrome.runtime.sendMessage(
      {
        type: 'CONTENT_TO_BG_PROCESS',
        contents,
        pageUID: getAccountIdentity().username,
      },
      (result) => {
        if (result?.success) {
          console.log(`[Synapse] Bilibili auto-collected ${result.collected} items`);
        } else {
          console.log('[Synapse] Bilibili auto-collect failed', result?.error);
        }
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Message listeners
  // ---------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener(
    (
      message: any,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response?: any) => void,
    ) => {
      if (message.type === 'POP_TO_CONTENT_COLLECT') {
        if (!isUploadManagerPage()) {
          sendResponse({ success: false, error: 'Not a Bilibili upload manager page' });
          return true;
        }

        const contents = collectAllBilibili();
        if (contents.length === 0) {
          sendResponse({ success: false, error: 'No works found on page' });
          return true;
        }

        chrome.runtime.sendMessage(
          {
            type: 'CONTENT_TO_BG_PROCESS',
            contents,
            pageUID: getAccountIdentity().username,
          },
          (response) => sendResponse(response),
        );
        return true;
      }

      if (message.type === 'GET_PAGE_INFO') {
        getPageInfo().then((info) => sendResponse(info));
        return true;
      }

      return true;
    },
  );

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------

  chrome.runtime.sendMessage({ type: 'CONTENT_SCRIPT_READY', source: 'bilibili' });
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
})();
