export type SourceMeta = {
  /** Stable css-safe key, used for the dot colour class. */
  key: string;
  /** Human label shown in the UI. */
  label: string;
  /** CSS colour value for the source dot. */
  color: string;
};

/**
 * Registry of every collector that can write into the archive.
 * Keys are the lower-cased `source` field found in the Markdown front matter.
 */
export const SOURCE_META: Record<string, SourceMeta> = {
  x: { key: "x", label: "X", color: "var(--src-x)" },
  bilibili: { key: "bilibili", label: "Bilibili", color: "var(--src-bilibili)" },
  qzone: { key: "qzone", label: "QZone", color: "var(--src-qzone)" },
  weibo: { key: "weibo", label: "Weibo", color: "var(--src-weibo)" },
  redbook: { key: "redbook", label: "RedBook", color: "var(--src-redbook)" },
  wxh: { key: "wechat", label: "WeChat", color: "var(--src-wechat)" },
  "公众号": { key: "wechat", label: "公众号", color: "var(--src-wechat)" },
  youtube: { key: "youtube", label: "YouTube", color: "var(--src-youtube)" },
  zsxq: { key: "zsxq", label: "知识星球", color: "var(--src-zsxq)" },
};

const FALLBACK: SourceMeta = {
  key: "other",
  label: "Other",
  color: "var(--ink-faint)",
};

export function sourceMeta(raw: string): SourceMeta {
  const key = String(raw ?? "").toLowerCase();
  return SOURCE_META[key] ?? { ...FALLBACK, label: raw || FALLBACK.label };
}
