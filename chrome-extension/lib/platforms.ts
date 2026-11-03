/**
 * Platform Configuration
 * Centralized platform definitions to ensure consistency across the extension
 */

/**
 * Build the collection URL for a given platform and account identifier.
 * Returns null if the platform doesn't support URL construction.
 */
export function buildPlatformUrl(platform: string, accountId: string): string | null {
  // WeChat, Bilibili, Redbook and Douyin collect the currently logged-in account
  // from their own creator/admin console, so there is no account id to interpolate.
  if (platform === 'wxh') {
    return 'https://mp.weixin.qq.com/';
  }
  if (platform === 'bilibili') {
    return 'https://member.bilibili.com/platform/upload-manager/article';
  }
  if (platform === 'redbook') {
    return 'https://creator.xiaohongshu.com/new/note-manager';
  }
  if (platform === 'douyin') {
    return 'https://creator.douyin.com/creator-micro/content/manage';
  }
  if (!accountId) return null;
  switch (platform) {
    case 'x':
      return `https://x.com/${accountId}`;
    case 'weibo':
      return `https://weibo.com/u/${accountId}`;
    case 'qzone':
      return `https://user.qzone.qq.com/${accountId}`;
    case 'zsxq':
      return `https://wx.zsxq.com/group/${accountId}`;
    case 'youtube':
      return `https://www.youtube.com/@${accountId}/videos`;
    default:
      return null;
  }
}

/**
 * Platform configuration for UI elements and config mapping
 */
export const PLATFORMS = {
  x: {
    toggle: 'enableX',
    config: 'configX',
    targetInput: 'targetXUser',
    configKey: 'targetXUser' as const,
  },
  bilibili: {
    toggle: 'enableBilibili',
    config: 'configBilibili',
    targetInput: 'targetBilibiliUser',
    configKey: 'targetBilibiliUser' as const,
  },
  qzone: {
    toggle: 'enableQZone',
    config: 'configQZone',
    targetInput: 'targetQZoneUser',
    configKey: 'targetQZoneUser' as const,
  },
  weibo: {
    toggle: 'enableWeibo',
    config: 'configWeibo',
    targetInput: 'targetWeiboUser',
    configKey: 'targetWeiboUser' as const,
  },
  redbook: {
    toggle: 'enableRedbook',
    config: 'configRedbook',
    targetInput: 'targetRedbookUser',
    configKey: 'targetRedbookUser' as const,
  },
  douyin: {
    toggle: 'enableDouyin',
    config: 'configDouyin',
    targetInput: 'targetDouyinUser',
    configKey: 'targetDouyinUser' as const,
  },
  zsxq: {
    toggle: 'enableZsxq',
    config: 'configZsxq',
    targetInput: 'targetZsxqGroup',
    configKey: 'targetZsxqGroup' as const,
  },
  youtube: {
    toggle: 'enableYoutube',
    config: 'configYoutube',
    targetInput: 'targetYoutubeChannel',
    configKey: 'targetYoutubeChannel' as const,
  },
  wxh: {
    toggle: 'enableWxh',
    config: 'configWxh',
    targetInput: 'targetWxhAlbum',
    configKey: 'targetWxhAlbum' as const,
  },
} as const;

export type PlatformKey = keyof typeof PLATFORMS;

/**
 * Default enabled sources
 */
export const DEFAULT_ENABLED_SOURCES: PlatformKey[] = [
  'x',
  'bilibili',
  'qzone',
  'weibo',
  'redbook',
  'douyin',
  'zsxq',
  'youtube',
  'wxh',
];

/**
 * All available platform keys
 */
export const ALL_PLATFORMS = Object.keys(PLATFORMS) as PlatformKey[];
