/**
 * Synapse Unified Data Types
 * These are global types available throughout the extension.
 */

interface AuthorInfo {
  username: string;
  displayName: string;
}

type ContentType = 'text' | 'image' | 'video' | 'article' | 'unknown';

interface EngagementMetrics {
  likes?: number;
  comments?: number;
  reposts?: number;
  reads?: number;    // 阅读量 (WXH)
  views?: number;    // 播放量 (Bilibili video)
  collects?: number; // 收藏 (Bilibili)
  danmaku?: number;  // 弹幕 (Bilibili, Douyin)
  coins?: number;    // 投币/硬币 (Bilibili)
  fans?: number;     // 吸粉量 (Douyin)
  coverClickRate?: number; // 封面点击率, percent: 6.51 means 6.51% (Douyin)
  avgPlayRatio?: number;   // 平均播放占比, percent (Douyin)
}

interface CollectedContent {
  source: 'X' | 'Bilibili' | 'QZone' | 'Weibo' | 'Redbook' | 'Douyin' | 'ZSXQ' | 'YouTube' | 'WXH';
  type?: ContentType;
  text: string;
  images: string[];
  videos: string[];
  links?: string[];
  tags?: string[];
  timestamp: string;
  url: string;
  author: AuthorInfo;
  collectedAt: string;
  engagement?: EngagementMetrics;
  localServerId?: string;
  localServerPath?: string;
}

/**
 * Unified PageInfo interface for all collectors
 * Returned by GET_PAGE_INFO message handler
 */
interface PageInfo {
  /** Whether the current page matches the configured target */
  isTargetPage: boolean;
  /** Number of content items found on the page */
  itemCount: number;
  /** Current page URL */
  currentUrl: string;
  /** Optional: Platform-specific identifier (user ID, group ID, etc.) */
  pageIdentifier?: string;
  /** Optional: Additional platform-specific data */
  [key: string]: any;
}

type LogLevelValue = 'info' | 'warn' | 'error' | 'success';

interface LogEntry {
  id: string;
  timestamp: string;
  level: LogLevelValue;
  message: string;
  summary: string;
  data: any;
}

interface AppConfig {
  localServerUrl: string;
  enabledSources: string[];
  targetXUser: string[];
  targetBilibiliUser: string[];
  targetQZoneUser: string[];
  targetWeiboUser: string[];
  targetRedbookUser: string[];
  targetDouyinUser?: string[];
  targetZsxqGroup?: string[];
  targetYoutubeChannel?: string[];
  targetWxhAlbum?: string[];
  collectIntervalMinutes?: number;
  lastCollectTime: string | null;
  lastCollectTimes?: Record<string, string>;
  debugMode: boolean;
}
