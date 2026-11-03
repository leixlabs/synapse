import { expect, test, beforeEach, afterEach } from 'bun:test';
import { Window } from 'happy-dom';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { runInContext, createContext } from 'node:vm';

const TARGET_HTML_DIR = join(import.meta.dir, '../target-html');

function createTestWindow(url: string = 'https://example.com') {
  const window = new Window({
    url: url,
    settings: {
      disableJavaScriptFileLoading: true,
      disableJavaScriptEvaluation: false,
      disableCSSFileLoading: true,
      disableIframePageLoading: true,
    },
  });

  // Mock chrome API on the window
  (window as any).chrome = {
    runtime: {
      sendMessage: () => {},
      onMessage: {
        addListener: () => {},
      },
      getURL: (path: string) => `chrome-extension://id/${path}`,
    },
    storage: {
      local: {
        get: (keys?: string | string[] | { [key: string]: any } | null) => {
          return Promise.resolve({});
        },
        set: (items: { [key: string]: any }) => {
          return Promise.resolve();
        },
        remove: (keys: string | string[]) => {
          return Promise.resolve();
        },
        clear: () => {
          return Promise.resolve();
        },
      },
    },
  };

  // Polyfill standard globals for VM context
  const globals = [
    'Array',
    'Object',
    'String',
    'Number',
    'Boolean',
    'RegExp',
    'Date',
    'Math',
    'JSON',
    'Promise',
    'console',
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'clearInterval',
    'URL',
    'URLSearchParams',
    'Error',
    'TypeError',
    'RangeError',
    'SyntaxError',
    'ReferenceError',
    'URIError',
    'EvalError',
    'Map',
    'Set',
    'WeakMap',
    'WeakSet',
    'Symbol',
    'Function',
    'parseInt',
    'parseFloat',
    'isNaN',
    'isFinite',
  ];

  globals.forEach((key) => {
    if (!(window as any)[key]) {
      (window as any)[key] = (globalThis as any)[key];
    }
  });

  return window;
}

function loadCollector(window: Window, relPath: string) {
  const absPath = join(import.meta.dir, '..', relPath);
  if (existsSync(absPath)) {
    let content = readFileSync(absPath, 'utf8');

    // Remove "use strict"
    content = content.replace(/"use strict";/g, '');

    // Strip export keywords
    content = content.replace(/^export\s+/gm, '');
    content = content.replace(/^export\s+\{.*\};?\s*$/gm, '');

    // Replace const/let with var
    content = content.replace(/^(const|let)\s+/gm, 'var ');

    // Strip IIFE wrapper
    content = content.replace(/\(\(\)\s*=>\s*\{/, '');
    content = content.replace(/\}\)\(\);\s*$/, '');

    // Remove top-level return checks
    content = content.replace(
      /if\s*\(\s*typeof\s+chrome\s*===\s*['"]undefined['"]\s*\|\|\s*!chrome\.runtime\s*\)\s*\{\s*return;?\s*\}/g,
      '',
    );

    try {
      // Ensure Array and other globals are present on the window object before context creation
      const globalPrototypes = [
        'Array',
        'Object',
        'String',
        'Number',
        'Boolean',
        'RegExp',
        'Date',
        'Math',
        'JSON',
        'Promise',
        'Map',
        'Set',
        'WeakMap',
        'WeakSet',
        'Symbol',
        'Function',
        'Error',
        'TypeError',
        'encodeURIComponent',
        'decodeURIComponent',
        'encodeURI',
        'decodeURI',
        'btoa',
        'atob',
        'unescape',
        'escape',
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
      ];

      globalPrototypes.forEach((key) => {
        if (!(window as any)[key]) {
          try {
            (window as any)[key] = (globalThis as any)[key];
          } catch (e) {
            console.error(`Failed to polyfill ${key}:`, e);
          }
        }
      });

      // Create VM context from the window
      createContext(window);

      // Execute in the window context
      runInContext(content, window);
    } catch (e) {
      console.error(`Error evaluating ${relPath}:`, e);
    }
  } else {
    console.warn(`Warning: Compiled collector not found at ${absPath}. Run build first.`);
  }
}

let originalDate: any;

beforeEach(() => {
  // Mock global Date so Happy-DOM picks it up if it falls back to global
  // Note: VM context might use its own Date or the one from window.
  // We mock globalThis.Date just in case, but ideally we should mock window.Date if needed.
  // However, Happy-DOM's Window usually exposes the environment's Date constructor.

  const fixedDate = new Date('2024-01-01T12:00:00Z');
  originalDate = globalThis.Date;

  const MockDate = function (this: Date, ...args: any[]) {
    if (args.length > 0) return new (originalDate as any)(...args);
    return new (originalDate as any)(fixedDate);
  } as any;

  MockDate.prototype = originalDate.prototype;
  MockDate.now = () => fixedDate.getTime();
  MockDate.UTC = originalDate.UTC;
  MockDate.parse = originalDate.parse;

  globalThis.Date = MockDate;
});

afterEach(() => {
  globalThis.Date = originalDate;
});

function loadHtmlToWindow(window: Window, htmlPath: string) {
  let html = readFileSync(htmlPath, 'utf-8');
  // happy-dom's parser drops everything after an empty <style> tag nested in an
  // <svg> (Bilibili's icon sprite ships one). Chrome handles it fine, so strip
  // them here rather than distorting the fixture.
  html = html.replace(/<style[^>]*><\/style>/g, '');
  (window.document as any).write(html);
}

test('X.com Collector', async () => {
  const window = createTestWindow('https://x.com/home');
  loadCollector(window, 'dist/content/x-collector.js');

  const htmlPath = join(TARGET_HTML_DIR, 'x.html');
  const jsonPath = join(TARGET_HTML_DIR, 'x.json');

  loadHtmlToWindow(window, htmlPath);

  const tweets = (window as any).findAllTweetsX();
  expect(tweets.length).toBeGreaterThan(0);

  const results = await Promise.all(tweets.map((t: any) => (window as any).collectTweetDataX(t)));

  // Only override collectedAt
  results.forEach((r: any) => {
    r.collectedAt = '2024-01-01T00:00:00.000Z';
  });

  if (!existsSync(jsonPath)) {
    writeFileSync(jsonPath, JSON.stringify(results, null, 2));
    console.log(`Created ${jsonPath} with collected data. Please review it.`);
  } else {
    const expected = JSON.parse(readFileSync(jsonPath, 'utf-8'));
    expect(results).toEqual(expected);
  }
});

test('Bilibili Collector', () => {
  const window = createTestWindow('https://member.bilibili.com/platform/upload-manager/article');
  loadCollector(window, 'dist/content/bilibili-collector.js');

  const htmlPath = join(TARGET_HTML_DIR, 'bilibili-internal.html');
  const jsonPath = join(TARGET_HTML_DIR, 'bilibili-internal.json');

  loadHtmlToWindow(window, htmlPath);

  const cards = (window as any).findAllArchivesBilibili();
  expect(cards.length).toBeGreaterThan(0);

  const results = cards
    .map((c: any) => (window as any).collectArchiveDataBilibili(c))
    .filter(Boolean);

  results.forEach((r: any) => {
    r.collectedAt = '2024-01-01T00:00:00.000Z';
  });

  if (!existsSync(jsonPath)) {
    writeFileSync(jsonPath, JSON.stringify(results, null, 2));
    console.log(`Created ${jsonPath}. Please review it.`);
  } else {
    const expected = JSON.parse(readFileSync(jsonPath, 'utf-8'));
    expect(results).toEqual(expected);
  }
});

test('QZone Collector', () => {
  const window = createTestWindow('https://user.qzone.qq.com/852872578/main');
  loadCollector(window, 'dist/content/qzone-collector.js');

  const htmlPath = join(TARGET_HTML_DIR, 'qq.html');
  const jsonPath = join(TARGET_HTML_DIR, 'qq.json');

  loadHtmlToWindow(window, htmlPath);

  const feeds = (window as any).findAllFeedsQZone();
  const results = feeds.map((f: any) => (window as any).collectFeedDataQZone(f));

  results.forEach((r: any) => {
    r.collectedAt = '2024-01-01T00:00:00.000Z';
  });

  if (!existsSync(jsonPath)) {
    writeFileSync(jsonPath, JSON.stringify(results, null, 2));
    console.log(`Created ${jsonPath}. Please review it.`);
  } else {
    const expected = JSON.parse(readFileSync(jsonPath, 'utf-8'));
    expect(results).toEqual(expected);
  }
});

test('Weibo Collector', () => {
  const window = createTestWindow('https://weibo.com/u/3260895521');
  loadCollector(window, 'dist/content/weibo-collector.js');

  const htmlPath = join(TARGET_HTML_DIR, 'weibo.html');
  const jsonPath = join(TARGET_HTML_DIR, 'weibo.json');

  loadHtmlToWindow(window, htmlPath);

  const posts = (window as any).findAllPostsWeibo();
  expect(posts.length).toBeGreaterThan(0);

  const results = posts.map((p: any) => (window as any).collectPostDataWeibo(p));

  results.forEach((r: any) => {
    r.collectedAt = '2024-01-01T00:00:00.000Z';
  });

  if (!existsSync(jsonPath)) {
    writeFileSync(jsonPath, JSON.stringify(results, null, 2));
    console.log(`Created ${jsonPath}. Please review it.`);
  } else {
    const expected = JSON.parse(readFileSync(jsonPath, 'utf-8'));
    expect(results).toEqual(expected);
  }
});

test('Redbook Collector', () => {
  const window = createTestWindow('https://creator.xiaohongshu.com/new/note-manager');

  loadCollector(window, 'dist/content/redbook-collector.js');

  const htmlPath = join(TARGET_HTML_DIR, 'redbook-internal.html');
  const jsonPath = join(TARGET_HTML_DIR, 'redbook-internal.json');

  loadHtmlToWindow(window, htmlPath);

  const notes = (window as any).findAllNotesRedbook();
  expect(notes.length).toBeGreaterThan(0);

  const results = notes.map((n: any) => (window as any).collectNoteDataRedbook(n));

  results.forEach((r: any) => {
    r.collectedAt = '2024-01-01T00:00:00.000Z';
  });

  if (!existsSync(jsonPath)) {
    writeFileSync(jsonPath, JSON.stringify(results, null, 2));
    console.log(`Created ${jsonPath}. Please review it.`);
  } else {
    const expected = JSON.parse(readFileSync(jsonPath, 'utf-8'));
    expect(results).toEqual(expected);
  }
});

test('Douyin Collector', () => {
  const window = createTestWindow('https://creator.douyin.com/creator-micro/content/manage');

  loadCollector(window, 'dist/content/douyin-collector.js');

  const htmlPath = join(TARGET_HTML_DIR, 'douyin.html');
  const jsonPath = join(TARGET_HTML_DIR, 'douyin.json');

  loadHtmlToWindow(window, htmlPath);

  const works = (window as any).findAllWorksDouyin();
  expect(works.length).toBeGreaterThan(0);

  const results = works.map((w: any) => (window as any).collectWorkDataDouyin(w));

  results.forEach((r: any) => {
    r.collectedAt = '2024-01-01T00:00:00.000Z';
  });

  if (!existsSync(jsonPath)) {
    writeFileSync(jsonPath, JSON.stringify(results, null, 2));
    console.log(`Created ${jsonPath}. Please review it.`);
  } else {
    const expected = JSON.parse(readFileSync(jsonPath, 'utf-8'));
    expect(results).toEqual(expected);
  }

  // Without the list API the work is keyed on time + cover and the URL anchors
  // back at the console.
  const withoutId = (window as any).collectWorkDataDouyin(works[0], []);
  expect(withoutId.url).toContain('/creator-micro/content/manage#work=');

  // With the id resolved from the list API the work gets a playable URL.
  const pool = [
    {
      id: '7702600309545928881',
      createTime: Math.floor(new Date(results[0].timestamp).getTime() / 1000),
      desc: results[0].text,
    },
  ];
  const withId = (window as any).collectWorkDataDouyin(works[0], pool);
  expect(withId.url).toBe('https://www.douyin.com/user/self?modal_id=7702600309545928881');
  expect(withId.links[0]).toBe('https://www.douyin.com/user/self?modal_id=7702600309545928881');
  // The identity is consumed so it cannot land on a second card.
  expect(pool.length).toBe(0);
});

test('Douyin work ids resolved from the list API', async () => {
  const window = createTestWindow(
    'https://creator.douyin.com/creator-micro/content/manage',
  );

  loadCollector(window, 'dist/content/douyin-collector.js');
  loadHtmlToWindow(window, join(TARGET_HTML_DIR, 'douyin.html'));

  const works = (window as any).findAllWorksDouyin();
  const first = (window as any).collectWorkDataDouyin(works[0]);

  // Stand in for the console's own list API: same origin, page cookies.
  (window as any).fetch = () =>
    Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          has_more: false,
          aweme_list: [
            {
              aweme_id: '7702600309545928881',
              create_time: Math.floor(new Date(first.timestamp).getTime() / 1000),
              desc: first.text,
            },
          ],
        }),
    });

  const contents = await (window as any).collectAllWorksDouyin();
  expect(contents[0].url).toBe(
    'https://www.douyin.com/user/self?modal_id=7702600309545928881',
  );
  expect(contents[0].links).toEqual([
    'https://www.douyin.com/user/self?modal_id=7702600309545928881',
    'https://www.douyin.com/video/7702600309545928881',
  ]);
});

test('ZSXQ Collector', () => {
  const window = createTestWindow('https://wx.zsxq.com/group/48415284844818');
  loadCollector(window, 'dist/content/zsxq-collector.js');

  const htmlPath = join(TARGET_HTML_DIR, 'zsxq.html');
  const jsonPath = join(TARGET_HTML_DIR, 'zsxq.json');

  loadHtmlToWindow(window, htmlPath);

  const topics = (window as any).findAllZsxqTopics();
  expect(topics.length).toBeGreaterThan(0);

  const results = topics.map((t: any) => (window as any).collectZsxqTopicData(t));

  results.forEach((r: any) => {
    r.collectedAt = '2024-01-01T00:00:00.000Z';
  });

  if (!existsSync(jsonPath)) {
    writeFileSync(jsonPath, JSON.stringify(results, null, 2));
    console.log(`Created ${jsonPath}. Please review it.`);
  } else {
    const expected = JSON.parse(readFileSync(jsonPath, 'utf-8'));
    expect(results).toEqual(expected);
  }
});

test('YouTube Collector', () => {
  const window = createTestWindow('https://www.youtube.com/@kamaleizhang/videos');
  loadCollector(window, 'dist/content/youtube-collector.js');

  const htmlPath = join(TARGET_HTML_DIR, 'youtube.html');
  const jsonPath = join(TARGET_HTML_DIR, 'youtube.json');

  loadHtmlToWindow(window, htmlPath);

  // Debug: check if function exists
  console.log(
    '[YouTube Test] findAllVideosYoutube exists:',
    typeof (window as any).findAllVideosYoutube,
  );

  const videos = (window as any).findAllVideosYoutube();
  console.log('[YouTube Test] videos found:', videos.length);
  expect(videos.length).toBeGreaterThan(0);

  const results = videos
    .map((v: any) => (window as any).collectVideoDataYoutube(v))
    .filter(Boolean);

  results.forEach((r: any) => {
    r.collectedAt = '2024-01-01T00:00:00.000Z';
  });

  if (!existsSync(jsonPath)) {
    writeFileSync(jsonPath, JSON.stringify(results, null, 2));
    console.log(`Created ${jsonPath}. Please review it.`);
  } else {
    const expected = JSON.parse(readFileSync(jsonPath, 'utf-8'));
    expect(results).toEqual(expected);
  }
});

test('WXH Collector', () => {
  const window = createTestWindow(
    'https://mp.weixin.qq.com/cgi-bin/appmsgpublish?sub=list&begin=0&count=10&token=1873195352&lang=zh_CN',
  );
  loadCollector(window, 'dist/content/wxh-collector.js');

  const htmlPath = join(TARGET_HTML_DIR, 'wxh-internal.html');
  const jsonPath = join(TARGET_HTML_DIR, 'wxh-internal.json');

  loadHtmlToWindow(window, htmlPath);

  // The page embeds its payload in an inline `publish_page` <script>; the
  // collector reads it from the script text, so no manual injection is needed.
  const results = (window as any).findAllContent();
  expect(results.length).toBeGreaterThan(0);

  results.forEach((r: any) => {
    r.collectedAt = '2024-01-01T00:00:00.000Z';
  });

  if (!existsSync(jsonPath)) {
    writeFileSync(jsonPath, JSON.stringify(results, null, 2));
    console.log(`Created ${jsonPath}. Please review it.`);
  } else {
    const expected = JSON.parse(readFileSync(jsonPath, 'utf-8'));
    expect(results).toEqual(expected);
  }
});
