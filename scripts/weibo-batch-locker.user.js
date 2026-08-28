// ==UserScript==
// @name         微博批量锁脚本 (设为仅自己可见)
// @namespace    https://github.com/wang93wei/lock-weibo
// @version      0.6.8
// @description  在 weibo.com 登录态下，按「最近N条 / 时间预设(1月/3月/半年/1年前) / 发布日期范围 / mid 范围」筛选，批量将自己的微博设为「仅自己可见」(visible.type=1)。默认 dry-run 预览，二次确认后执行，可随时停止。
// @author       AlanWang
// @supportURL   https://github.com/wang93wei/lock-weibo/issues
// @match        https://weibo.com/*
// @run-at       document-idle
// @grant        none
// @license      Apache-2.0
// ==/UserScript==

/* global window, document, fetch, URLSearchParams, AbortController, confirm */

/*
 * Interface contracts (verified first-hand 2026-07-27, see
 * .trellis/tasks/archive/2026-07/07-27-weibo-batch-locker/research/weibo-api-notes.md):
 *
 *   List:  GET /ajax/statuses/mymblog?uid=&page=&feature=0[&since_id=]
 *          -> { ok:1, data:{ list:[{id, mid, visible:{type,list_id}, created_at, text_raw}], total, since_id } }
 *
 *   Lock:  POST /ajax/statuses/modifyVisible
 *          Body (form): ids=<mid>&visible=1   (visible is a STRING "1")
 *          Headers: x-xsrf-token (from document.cookie XSRF-TOKEN), x-requested-with
 *          -> { ok:>0, statuses:[...] }
 *
 *   Visibility enum (from weibo-pro-next bundle):
 *     0=公开 1=仅自己可见 6=好友圈(list) 9=受限 10=粉丝 3=付费会员
 *     Only "仅自己可见" (1) is used here.
 */

(function () {
  "use strict";

  // ===========================================================================
  // Config
  // ===========================================================================
  const CONFIG = {
    PAGE_SIZE: 20, // mymblog returns ~20 per page
    // Sliding-window rate limiter (global, covers both mymblog + modifyVisible).
    // Allows at most RATE_MAX requests within any RATE_WINDOW_MS window.
    // Default ~3 req / 10s ≈ one request every ~3.3s on average.
    RATE_WINDOW_MS: 10000,
    RATE_MAX: 3,
    DEFAULT_DELAY_SEC: 1.5, // legacy: min gap hint (window already enforces pacing)
    RATE_LIMITED_WAIT_MS: 30000, // pause length when weibo itself rate-limits us
    MAX_RETRY: 3, // retries per weibo on transient errors
    MAX_PAGE_RETRY: 3, // retries on a rate-limited page before giving up
    RETRY_BASE_WAIT_MS: 2000, // exponential backoff base
    MAX_PAGES_FALLBACK: 5000, // safety cap to avoid infinite pagination
    PRIVATE_TYPE: 1, // visible.type value for "仅自己可见"
  };

  const VISIBLE_TEXT = {
    0: "公开",
    1: "仅自己可见",
    6: "好友圈",
    9: "受限",
    10: "粉丝可见",
    3: "付费会员可见",
  };

  // ===========================================================================
  // Utils
  // ===========================================================================

  /**
   * Logged-in user's uid. Prefer weibo globals ($CONFIG) so homepage / SPA
   * routes work; fall back to /u/<id> or /profile/<id> in the URL.
   * This tool only locks own posts — always the login uid, not "page owner".
   */
  function getUid() {
    const cfg = window.$CONFIG;
    if (cfg) {
      const fromCfg = cfg.uid ?? cfg.user?.idstr ?? cfg.user?.id;
      if (fromCfg != null && /^\d+$/.test(String(fromCfg))) return String(fromCfg);
    }
    const m = window.location.pathname.match(/\/u\/(\d+)/);
    if (m) return m[1];
    const m2 = window.location.pathname.match(/\/profile\/(\d+)/);
    if (m2) return m2[1];
    return null;
  }

  /** SPA route change: pushState / replaceState / popstate. */
  function onSpaNavigate(cb) {
    const fire = () => {
      try {
        cb();
      } catch (e) {
        console.warn("[wbl] spa navigate hook", e);
      }
    };
    const wrap = (type) => {
      const orig = history[type];
      if (typeof orig !== "function") return;
      history[type] = function (...args) {
        const ret = orig.apply(this, args);
        fire();
        return ret;
      };
    };
    wrap("pushState");
    wrap("replaceState");
    window.addEventListener("popstate", fire);
  }

  /** Extract XSRF-TOKEN from document.cookie (verified non-HttpOnly). */
  function getXsrfToken() {
    const m = document.cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]+)/);
    if (!m) return "";
    try {
      return decodeURIComponent(m[1]);
    } catch (_) {
      return m[1];
    }
  }

  /** Weibo created_at -> Date. e.g. "Sat Jul 25 11:37:50 +0800 2026". */
  function parseWeiboDate(s) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : new Date(t);
  }

  /** YYYY-MM-DD string for a Date (local). */
  function toDayStr(d) {
    if (!d) return "";
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${m}-${day}`;
  }

  /**
   * "YYYY-MM-DD" -> Unix seconds (+0800 local timezone, as Weibo's
   * searchProfile expects). `endOfDay=true` returns 23:59:59 of that day so a
   * user's end date includes the whole day; otherwise 00:00:00.
   * Returns null on bad input.
   */
  function dateStrToEpochSec(dateStr, endOfDay) {
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
    const parts = dateStr.split("-").map(Number);
    const d = new Date(parts[0], parts[1] - 1, parts[2], endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0);
    return Math.floor(d.getTime() / 1000);
  }

  /** Current time as Unix seconds. */
  function nowEpochSec() {
    return Math.floor(Date.now() / 1000);
  }

  /**
   * Return today's YYYY-MM-DD shifted back by `months` whole months.
   * Subtracts months by hand and CLAMPS the day to the target month's last
   * day, because JS Date.setMonth overflows instead (Mar 31 - 1 month would
   * become Mar 3, not Feb 28 — a real bug that would silently break filtering
   * when "today" lands on the 29th/30th/31st).
   * Examples: Jul 27 - 3 months -> "2026-04-27"; Mar 31 - 1 month -> "2026-02-28".
   */
  function cutoffDayMonthsAgo(months) {
    const now = new Date();
    let y = now.getFullYear();
    let m = now.getMonth() - months; // 0-based; may go negative
    while (m < 0) { m += 12; y -= 1; }
    while (m > 11) { m -= 12; y += 1; }
    const lastDay = new Date(y, m + 1, 0).getDate(); // day 0 of next month = last day of target
    const day = Math.min(now.getDate(), lastDay);
    return toDayStr(new Date(y, m, day));
  }

  /**
   * Compare two mids as numbers (16-digit ids exceed Number.MAX_SAFE_INTEGER,
   * but mids are fixed-width and monotonically increasing, so lexicographic
   * order == numeric order when equal-length; length is the tiebreaker).
   */
  function cmpMid(a, b) {
    a = String(a);
    b = String(b);
    if (a.length !== b.length) return a.length - b.length;
    return a < b ? -1 : a > b ? 1 : 0;
  }

  /** True if the weibo is already "仅自己可见". Always returns a boolean.
   *  Coerces type so both number 1 and string "1" count (API drift has done both). */
  function isPrivate(blog) {
    return Boolean(blog && blog.visible && Number(blog.visible.type) === CONFIG.PRIVATE_TYPE);
  }

  function visibleText(blog) {
    const t = blog && blog.visible && blog.visible.type;
    return VISIBLE_TEXT[t] != null ? VISIBLE_TEXT[t] : `type=${t}`;
  }

  /** Sleep that can be aborted via AbortSignal. */
  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      const t = setTimeout(resolve, ms);
      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true }
        );
      }
    });
  }

  /**
   * Yield to the browser so it can paint pending DOM changes (log lines,
   * counters). Without this, a tight await-loop keeps deferring repaints and
   * the panel appears frozen even though requests are firing (visible in F12).
   * requestAnimationFrame resolves before the next paint; the outer setTimeout
   * guarantees the macrotask boundary browsers need to actually render.
   */
  function yieldToRender() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  /** Random delay around `baseSec` (±20%). */
  function randomDelayMs(baseSec) {
    return Math.round(baseSec * (0.8 + Math.random() * 0.4) * 1000);
  }

  /**
   * Sliding-window rate limiter. Throttles ALL outbound weibo requests
   * (mymblog pagination + modifyVisible) so that at most `max` requests happen
   * within any trailing `windowMs` window. This mirrors how platforms actually
   * detect abuse (request density over time), which fixed inter-request delays
   * only approximate.
   *
   * Usage: `await rateLimiter.acquire(signal)` before every network call.
   * Returns the ms it waited (0 if no wait).
   */
  function createRateLimiter(windowMs, max) {
    const timestamps = []; // ms timestamps of admitted requests, ascending
    let cfgWindow = windowMs;
    let cfgMax = max;
    return {
      async acquire(signal) {
        while (true) {
          if (signal && signal.aborted)
            throw new DOMException("Aborted", "AbortError");
          const now = Date.now();
          // Drop timestamps that fell out of the window.
          while (timestamps.length && now - timestamps[0] >= cfgWindow) {
            timestamps.shift();
          }
          if (timestamps.length < cfgMax) {
            timestamps.push(now);
            return;
          }
          // Window full: wait until the oldest request ages out, then re-check.
          const wait = cfgWindow - (now - timestamps[0]) + 5;
          await sleep(wait, signal);
        }
      },
      /** Reconfigure at runtime (e.g. when the user changes the panel input). */
      setMax(m) {
        cfgMax = Math.max(1, Math.floor(m));
      },
      // Test/inspect helper: how many requests are currently in-window.
      _inWindow() {
        const now = Date.now();
        while (timestamps.length && now - timestamps[0] >= cfgWindow) timestamps.shift();
        return timestamps.length;
      },
    };
  }

  // Single global limiter instance shared by all requests in this page session.
  const rateLimiter = createRateLimiter(CONFIG.RATE_WINDOW_MS, CONFIG.RATE_MAX);

  // ===========================================================================
  // API layer
  // ===========================================================================

  /**
   * Match weibo-pro-next XHR headers (verified 2026-07-28 on mymblog/searchProfile):
   *   accept, client-version, server-version, traceparent, x-requested-with, x-xsrf-token
   * Browser auto-fills cookie / user-agent / referer / sec-fetch-* / accept-language
   * when fetch() runs same-origin with credentials:"include" — do NOT set those
   * (several are forbidden header names in the Fetch spec).
   *
   * Official axios interceptor (weibo-pro-next bundle) does exactly:
   *   headers["client-version"] = window.$VERSION.CLIENT
   *   headers["server-version"] = window.$VERSION.SERVER
   * Page boots with:
   *   window.$VERSION = { CLIENT: "3.0.0", SERVER: "v2026.07.23.1" }
   * We mirror that; scrape / fallback only if $VERSION is missing (early boot).
   */
  const CLIENT_VERSION_FALLBACK = "3.0.0";
  const SERVER_VERSION_FALLBACK = "v2026.07.23.1";
  let cachedClientVersion = null;
  let cachedServerVersion = null;

  /** Read window.$VERSION once; returns { client, server } (may be partial). */
  function readWindowVersion() {
    try {
      const v = window.$VERSION;
      if (!v || typeof v !== "object") return {};
      return {
        client: typeof v.CLIENT === "string" && v.CLIENT ? v.CLIENT : null,
        server: typeof v.SERVER === "string" && v.SERVER ? v.SERVER : null,
      };
    } catch (_) {
      return {};
    }
  }

  function getClientVersion() {
    if (cachedClientVersion) return cachedClientVersion;
    const fromWin = readWindowVersion().client;
    if (fromWin) {
      cachedClientVersion = fromWin;
      return cachedClientVersion;
    }
    // Late fallback: scrape inline boot script `CLIENT: 'x.y.z'`
    try {
      const head = (document.head && document.head.innerHTML) || "";
      const m = head.match(/CLIENT\s*:\s*['"]([\d.]+)['"]/);
      if (m) {
        cachedClientVersion = m[1];
        return cachedClientVersion;
      }
    } catch (_) {
      /* ignore */
    }
    cachedClientVersion = CLIENT_VERSION_FALLBACK;
    return cachedClientVersion;
  }

  function getServerVersion() {
    if (cachedServerVersion) return cachedServerVersion;
    const fromWin = readWindowVersion().server;
    if (fromWin) {
      cachedServerVersion = fromWin;
      return cachedServerVersion;
    }
    try {
      const head = (document.head && document.head.innerHTML) || "";
      const m =
        head.match(/SERVER\s*:\s*['"](v20\d{2}\.\d{2}\.\d{2}\.\d+)['"]/) ||
        head.match(/\b(v20\d{2}\.\d{2}\.\d{2}\.\d+)\b/);
      if (m) {
        cachedServerVersion = m[1];
        return cachedServerVersion;
      }
    } catch (_) {
      /* ignore */
    }
    cachedServerVersion = SERVER_VERSION_FALLBACK;
    return cachedServerVersion;
  }

  /** W3C traceparent: 00-<32 hex trace id>-<16 hex span id>-00 */
  function makeTraceparent() {
    const hex = (n) => {
      const a = new Uint8Array(n);
      (window.crypto || window.msCrypto).getRandomValues(a);
      return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
    };
    return `00-${hex(16)}-${hex(8)}-00`;
  }

  function apiHeaders(isPost) {
    const h = {
      accept: "application/json, text/plain, */*",
      "client-version": getClientVersion(),
      "server-version": getServerVersion(),
      traceparent: makeTraceparent(),
      "x-requested-with": "XMLHttpRequest",
      "x-xsrf-token": getXsrfToken(),
    };
    if (isPost) h["content-type"] = "application/x-www-form-urlencoded";
    return h;
  }

  /** Fetch one page of the user's own weibo timeline. Returns data.data. */
  async function fetchBlogPage({ uid, page, sinceId }, signal) {
    await rateLimiter.acquire(signal); // global sliding-window throttle
    const params = new URLSearchParams({ uid, page: String(page), feature: "0" });
    if (sinceId) params.set("since_id", String(sinceId));
    const url = `https://weibo.com/ajax/statuses/mymblog?${params.toString()}`;
    const res = await fetch(url, {
      headers: apiHeaders(false),
      credentials: "include",
      signal,
    });
    // 403 => auth; 414/429 => weibo rate-limiting gateway (often with "频次过快")
    if (res.status === 403) {
      const e = new Error("Cookie 已过期或未登录 (HTTP 403)");
      e.code = "AUTH";
      throw e;
    }
    if (res.status === 414 || res.status === 429) {
      const e = new Error(`访问频次过快，被微博限流 (HTTP ${res.status})`);
      e.code = "RISK";
      throw e;
    }
    if (!res.ok) throw new Error(`mymblog HTTP ${res.status}`);
    const data = await res.json();
    if (data.ok !== 1) {
      const msg = data.msg || "";
      const e = new Error(`mymblog ok=${data.ok} ${msg}`.trim());
      // weibo sometimes returns ok:0 with a "频次/频繁/limit" message instead of an HTTP code
      if (/频次|频繁|过快|limit|too many/i.test(msg)) e.code = "RISK";
      else if (data.ok === 0 && /login|登录/i.test(msg)) e.code = "AUTH";
      else e.code = "API";
      throw e;
    }
    if (!data.data || !Array.isArray(data.data.list)) {
      throw new Error("mymblog 响应结构异常");
    }
    return data.data;
  }

  /** Set one weibo's visibility to "仅自己可见". */
  async function modifyVisible(mid, signal) {
    await rateLimiter.acquire(signal); // global sliding-window throttle
    const body = new URLSearchParams({ ids: String(mid), visible: "1" });
    const res = await fetch("https://weibo.com/ajax/statuses/modifyVisible", {
      method: "POST",
      headers: apiHeaders(true),
      body,
      credentials: "include",
      signal,
    });
    if (res.status === 403) {
      const e = new Error("Cookie 已过期或未登录 (HTTP 403)");
      e.code = "AUTH";
      throw e;
    }
    if (res.status === 414 || res.status === 429) {
      const e = new Error(`访问频次过快，被微博限流 (HTTP ${res.status})`);
      e.code = "RISK";
      throw e;
    }
    if (!res.ok) {
      // 非 2xx 时尝试读响应体里的服务端 message（2026-08-29 实测：永久拒绝返回
      // HTTP 400 + {"ok":0,"message":"此条微博暂不支持变更可见范围。"}，字段名是
      // message 不是 msg）。非 JSON 响应体（如网关 HTML）回退通用文案，解析失败
      // 绝不抛新异常。PERM = 服务端永久拒绝（该微博类型不支持变更可见范围），
      // 重试无意义；console 输出便于 DevTools 调试。
      let srv = "";
      try {
        const body = await res.json();
        srv = (body && (body.message || body.msg)) || "";
      } catch (_) {
        // 响应体非 JSON：保持通用错误文案
      }
      console.error("[wbl] modifyVisible 失败:", mid, "HTTP " + res.status, srv || "(无可解析响应体)");
      const e = new Error(`modifyVisible HTTP ${res.status}${srv ? ` ${srv}` : ""}`);
      if (/暂不支持/.test(srv)) e.code = "PERM";
      throw e;
    }
    const data = await res.json();
    if (!(data.ok > 0)) {
      // 字段名兼容 message 与 msg（2026-08-29 实测：400 路径用 message）。
      const msg = data.msg || data.message || "";
      const e = new Error(`modifyVisible ok=${data.ok} ${msg}`.trim());
      // ok<=0 分类：限流措辞 → 长 RISK 暂停；登录 → AUTH 终止；「暂不支持」→
      // PERM（服务端永久拒绝，重试无意义）；其余短退避重试。
      if (/频次|频繁|过快|limit|too many/i.test(msg)) e.code = "RISK";
      else if (data.ok === -100 || /login|登录/i.test(msg)) e.code = "AUTH";
      else if (/暂不支持/.test(msg)) e.code = "PERM";
      else e.code = "API";
      console.error("[wbl] modifyVisible 业务失败:", mid, "ok=" + data.ok, msg);
      throw e;
    }
    return data;
  }

  /**
   * Fetch one page of the user's own weibos filtered server-side by time range
   * via searchProfile. Returns data.data. Used by "时间预设"/"日期范围" filters
   * to avoid the cost of full-timeline pagination that mymblog would require.
   *
   * NOTE on pagination (verified 2026-07-27): `page`, `max_id`, `since_id` are
   * ALL ignored by this endpoint — only `endtime` moves the cursor (results are
   * newest-first; callers shrink `endtime` to the oldest item's created_at to
   * fetch the next slice). `page` is therefore pinned to 1 here; the loop lives
   * in runApiModeSearchProfile. `Referer` is validated server-side but the
   * browser sets it automatically for same-origin fetch, so nothing extra is
   * needed vs fetchBlogPage.
   */
  async function fetchSearchProfilePage({ uid, starttime, endtime }, signal) {
    await rateLimiter.acquire(signal); // global sliding-window throttle
    const params = new URLSearchParams({ uid, page: "1" });
    if (starttime) params.set("starttime", String(starttime));
    if (endtime) params.set("endtime", String(endtime));
    const url = `https://weibo.com/ajax/statuses/searchProfile?${params.toString()}`;
    const res = await fetch(url, {
      headers: apiHeaders(false),
      credentials: "include",
      signal,
    });
    if (res.status === 403) {
      const e = new Error("Cookie 已过期或未登录 (HTTP 403)");
      e.code = "AUTH";
      throw e;
    }
    if (res.status === 414 || res.status === 429) {
      const e = new Error(`访问频次过快，被微博限流 (HTTP ${res.status})`);
      e.code = "RISK";
      throw e;
    }
    if (!res.ok) throw new Error(`searchProfile HTTP ${res.status}`);
    const data = await res.json();
    if (data.ok !== 1) {
      const msg = data.msg || "";
      const e = new Error(`searchProfile ok=${data.ok} ${msg}`.trim());
      if (/频次|频繁|过快|limit|too many/i.test(msg)) e.code = "RISK";
      else if (data.ok === -100 || /login|登录/i.test(msg)) e.code = "AUTH";
      else e.code = "API";
      throw e;
    }
    if (!data.data || !Array.isArray(data.data.list)) {
      throw new Error("searchProfile 响应结构异常");
    }
    return data.data;
  }

  // ===========================================================================
  // Filters (pure functions)
  // ===========================================================================

  function byDateRange(blogs, { start, end }) {
    const s = start ? start.replace(/-/g, "") : null; // YYYYMMDD
    const e = end ? end.replace(/-/g, "") : null;
    return blogs.filter((b) => {
      const day = toDayStr(parseWeiboDate(b.created_at)).replace(/-/g, "");
      if (!day) return false;
      if (s && day < s) return false;
      if (e && day > e) return false;
      return true;
    });
  }

  function byMidRange(blogs, { startMid, endMid }) {
    return blogs.filter((b) => {
      const m = String(b.mid || b.id);
      if (startMid && cmpMid(m, startMid) < 0) return false;
      if (endMid && cmpMid(m, endMid) > 0) return false;
      return true;
    });
  }

  /**
   * Relative-time filter: lock weibos published STRICTLY before (today - N months).
   * `months` selects how far back; the cutoff is recomputed at call time, so the
   * filter is always relative to "now" (dynamic locking).
   * Matches weibos whose created_at day < cutoffDay (both as YYYYMMDD strings).
   */
  function byBeforeMonths(blogs, { months }) {
    const cutoff = cutoffDayMonthsAgo(months); // "YYYY-MM-DD"
    const cutoffNum = cutoff.replace(/-/g, ""); // "YYYYMMDD"
    return blogs.filter((b) => {
      const day = toDayStr(parseWeiboDate(b.created_at)).replace(/-/g, "");
      if (!day) return false;
      return day < cutoffNum;
    });
  }

  /**
   * "最近 N 条" must be enforced across the whole timeline, not per page.
   * Per-page slice(0, n) would skip the tail of earlier pages when N spans
   * multiple pages (or when many already-private items force further scanning).
   * Identity here; runApiMode trims with remaining = n - hits.length.
   */
  function byRecentN(blogs) {
    return blogs;
  }

  function applyFilter(blogs, cfg) {
    if (!cfg) return blogs;
    switch (cfg.type) {
      case "date":
        return byDateRange(blogs, cfg);
      case "before":
        return byBeforeMonths(blogs, cfg);
      case "mid":
        return byMidRange(blogs, cfg);
      case "recent":
        return byRecentN(blogs, cfg);
      default:
        return blogs;
    }
  }

  /** Structural equality of two filter configs (used to guard run-after-preview). */
  function sameFilterCfg(a, b) {
    if (!a || !b || a.type !== b.type) return false;
    switch (a.type) {
      case "date":
        return (a.start || "") === (b.start || "") && (a.end || "") === (b.end || "");
      case "before":
        return Number(a.months) === Number(b.months);
      case "mid":
        return (a.startMid || "") === (b.startMid || "") && (a.endMid || "") === (b.endMid || "");
      case "recent":
        return Number(a.n) === Number(b.n);
      default:
        return false;
    }
  }

  // ===========================================================================
  // API executor (single source of truth for preview + run)
  // ===========================================================================

  /**
   * @param {object}   opts
   * @param {string}   opts.uid
   * @param {object}   opts.filterCfg   {type:"date"|"before"|"mid"|"recent", ...}
   * @param {boolean}  opts.dryRun      if true, never call modifyVisible
   * @param {function} opts.onLog       (msg, level) -> void
   * @param {function} opts.onProgress  (stats) -> void
   * @param {AbortSignal} opts.signal
   * @returns {Promise<object>} stats { success, skipped, failed, scanned, hits }
   */
  async function runApiMode(opts) {
    const { uid, filterCfg, dryRun, onLog, onProgress, signal } = opts;
    const stats = { success: 0, skipped: 0, failed: 0, scanned: 0, hits: [] };
    let page = 1;
    let sinceId = null;

    onLog(
      dryRun
        ? `【预览模式】开始扫描（不会修改任何微博）... 筛选: ${filterCfg.type}`
        : `【执行模式】开始批量设为仅自己可见 ... 筛选: ${filterCfg.type}`,
      "info"
    );

    while (page <= CONFIG.MAX_PAGES_FALLBACK) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");

      // Fetch this page, retrying on rate-limit with a long pause.
      let pageData = null;
      for (let attempt = 1; attempt <= CONFIG.MAX_PAGE_RETRY; attempt++) {
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        try {
          pageData = await fetchBlogPage({ uid, page, sinceId }, signal);
          break;
        } catch (err) {
          if (err.name === "AbortError") throw err;
          if (err.code === "AUTH") throw err; // stop everything on auth failure
          if (err.code === "RISK" && attempt < CONFIG.MAX_PAGE_RETRY) {
            onLog(
              `第 ${page} 页被限流: ${err.message}，暂停 ${CONFIG.RATE_LIMITED_WAIT_MS / 1000}s 后重试（${attempt}/${CONFIG.MAX_PAGE_RETRY}）...`,
              "warn"
            );
            await sleep(CONFIG.RATE_LIMITED_WAIT_MS, signal);
            continue;
          }
          onLog(`第 ${page} 页拉取失败: ${err.message}，终止扫描。`, "error");
          pageData = null;
          break;
        }
      }
      if (!pageData) break;

      const list = pageData.list || [];
      if (list.length === 0) {
        onLog(`已扫描全部微博（第 ${page} 页为空），结束。`, "info");
        break;
      }

      // Filter this page. For "recent N", take only what's still needed so the
      // timeline stays contiguous across pages (no per-page slice that skips tails).
      let matched = applyFilter(list, filterCfg);
      if (filterCfg.type === "recent") {
        const remaining = filterCfg.n - stats.hits.length;
        if (remaining <= 0) break;
        matched = matched.slice(0, remaining);
        // Count only the prefix we actually walk — mymblog still returns ~20/page,
        // but "已扫描" should not jump to 20 when the user only asked for N=10.
        stats.scanned += matched.length;
      } else {
        stats.scanned += list.length;
      }
      onProgress({ ...stats });
      await yieldToRender();

      for (const blog of matched) {
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        await yieldToRender(); // let the browser paint log/counters

        const mid = String(blog.mid || blog.id);
        const day = toDayStr(parseWeiboDate(blog.created_at));
        const preview = {
          mid,
          date: day,
          visible: visibleText(blog),
          isPrivate: isPrivate(blog),
          text: (blog.text_raw || "").slice(0, 40),
        };
        stats.hits.push(preview);

        if (isPrivate(blog)) {
          stats.skipped++;
          // 已锁定的不刷屏：前 3 条 + 每 50 条打一次进度
          if (stats.skipped <= 3 || stats.skipped % 50 === 0) {
            onLog(`跳过已锁定 ${stats.skipped} 条（最近 [${mid}] ${day}）`, "muted");
          }
          onProgress({ ...stats });
          continue;
        }

        if (dryRun) {
          onLog(`待锁 [${mid}] ${day} (${visibleText(blog)}) ${(blog.text_raw || "").slice(0, 20)}`, "hit");
          onProgress({ ...stats });
          continue;
        }

        // Real execution with retry + backoff
        let done = false;
        for (let attempt = 1; attempt <= CONFIG.MAX_RETRY; attempt++) {
          if (signal.aborted) throw new DOMException("Aborted", "AbortError");
          try {
            onLog(`处理中 [${mid}] 尝试 ${attempt}/${CONFIG.MAX_RETRY}`, "info");
            await modifyVisible(mid, signal);
            stats.success++;
            onLog(`✓ 已锁定 [${mid}] ${day}`, "success");
            done = true;
            break;
          } catch (err) {
            if (err.name === "AbortError") throw err;
            if (err.code === "AUTH") {
              onLog(`鉴权失败，终止: ${err.message}`, "error");
              throw err;
            }
            if (err.code === "RISK") {
              // Rate-limited: needs a long pause, not a short backoff.
              if (attempt >= CONFIG.MAX_RETRY) {
                onLog(`✗ 风控/失败 [${mid}]: ${err.message}（已达最大重试）`, "error");
                break;
              }
              onLog(
                `限流 [${mid}]，暂停 ${CONFIG.RATE_LIMITED_WAIT_MS / 1000}s 后重试（${attempt}/${CONFIG.MAX_RETRY}）`,
                "warn"
              );
              await sleep(CONFIG.RATE_LIMITED_WAIT_MS, signal);
              continue;
            }
            // PERM：服务端永久拒绝（该微博类型不支持变更可见范围），重试必然失败。
            if (err.code === "PERM") {
              onLog(`✗ 不支持变更 [${mid}]: ${err.message}（不重试）`, "error");
              break;
            }
            const wait = CONFIG.RETRY_BASE_WAIT_MS * Math.pow(2, attempt - 1);
            onLog(`重试 [${mid}] ${err.message}，${wait / 1000}s 后重试`, "warn");
            await sleep(wait, signal);
          }
        }
        if (!done) stats.failed++;

        onProgress({ ...stats });
        // Human-like jitter on top of the window limiter, so request gaps
        // aren't perfectly regular (regularity is itself a bot signal).
        await sleep(randomDelayMs(1.0), signal);
      }

      // "最近 N 条": stop once we have N timeline items (private ones count toward N).
      if (filterCfg.type === "recent" && stats.hits.length >= filterCfg.n) {
        onLog(`已达「最近 ${filterCfg.n} 条」目标，停止扫描。`, "info");
        break;
      }

      sinceId = pageData.since_id;
      if (!sinceId) {
        onLog(`无 since_id，结束扫描。`, "info");
        break;
      }
      page++;
      // No extra sleep here: the global rateLimiter inside fetchBlogPage
      // already paces pagination.
    }

    onLog(
      `完成 — 成功 ${stats.success} · 跳过 ${stats.skipped} · 失败 ${stats.failed} · 待锁 ${stats.hits.filter((h) => !h.isPrivate).length}` +
        (dryRun ? "（预览，未实际修改）" : ""),
      "summary"
    );
    return stats;
  }

  /**
   * Preview collector for time-range filters ("时间预设"/"日期范围"). Uses the
   * searchProfile endpoint so the server does the date filtering — far fewer
   * requests than mymblog full-pagination + client-side filter.
   *
   * Stats/hits shape matches runApiMode so lockByIds reuses them unchanged.
   * Always behaves as a dry-run collector (real locking is lockByIds's job);
   * the `dryRun` flag only toggles the startup log line, kept for signature
   * parity with runApiMode.
   *
   * Pagination (re-verified 2026-08-29 via live searchProfile):
   *   - page/max_id/since_id are ignored; shrink `endtime` to walk older.
   *   - data.total 不可信（2026-08-29 实测）：大时间窗下是饱和近似值（~1000±10，
   *     数值还会抖动），与窗口真实命中数脱钩（实测仅 47 条的窗口报 total=1007；
   *     按相同游标走法收出 1242+ 条唯一 mid 仍未到底，total 仍报 1007）。禁止用
   *     hits.length >= total 做早停；终止只靠空列表 / 本段无新 mid / 游标低于
   *     starttime / MAX_PAGES_FALLBACK / 用户停止。
   *   - 游标含边界推进（curEnd = oldestEpoch，不再 -1）：同秒组被 50 条分页
   *     边界切开时，余下帖子能在下一段取回（seenMids 去重）。
   *   - `已扫描` counts unique mids only (not raw list.length across slices).
   *
   * @param {object} opts
   * @param {string}  opts.uid
   * @param {number}  [opts.starttime]  unix sec; omit = no lower bound
   * @param {number}  opts.endtime      unix sec
   * @param {function} opts.onLog
   * @param {function} opts.onProgress
   * @param {AbortSignal} opts.signal
   * @returns {Promise<object>} stats
   */
  async function runApiModeSearchProfile(opts) {
    const { uid, starttime, endtime, onLog, onProgress, signal } = opts;
    const stats = { success: 0, skipped: 0, failed: 0, scanned: 0, hits: [] };
    const seenMids = new Set();
    let curEnd = endtime;
    let slice = 0;

    onLog(
      `【预览模式】用 searchProfile 按时间服务端筛选（不会修改任何微博）...` +
        (starttime ? ` 区间: ${starttime}~${endtime}` : ` 截止: ${endtime}`),
      "info"
    );

    while (slice < CONFIG.MAX_PAGES_FALLBACK) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      slice++;

      // Fetch this time slice, retrying on rate-limit with a long pause.
      let pageData = null;
      for (let attempt = 1; attempt <= CONFIG.MAX_PAGE_RETRY; attempt++) {
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        try {
          pageData = await fetchSearchProfilePage({ uid, starttime, endtime: curEnd }, signal);
          break;
        } catch (err) {
          if (err.name === "AbortError") throw err;
          if (err.code === "AUTH") throw err;
          if (err.code === "RISK" && attempt < CONFIG.MAX_PAGE_RETRY) {
            onLog(
              `第 ${slice} 段被限流: ${err.message}，暂停 ${CONFIG.RATE_LIMITED_WAIT_MS / 1000}s 后重试（${attempt}/${CONFIG.MAX_PAGE_RETRY}）...`,
              "warn"
            );
            await sleep(CONFIG.RATE_LIMITED_WAIT_MS, signal);
            continue;
          }
          onLog(`第 ${slice} 段拉取失败: ${err.message}，终止扫描。`, "error");
          pageData = null;
          break;
        }
      }
      if (!pageData) break;

      const list = pageData.list || [];
      if (list.length === 0) {
        onLog(`已扫描全部微博（第 ${slice} 段为空），结束。`, "info");
        break;
      }

      await yieldToRender();

      // Process only mids not seen in a prior slice.
      let newCount = 0;
      let oldestEpoch = null;
      for (const blog of list) {
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        await yieldToRender();

        const mid = String(blog.mid || blog.id);
        // Track the oldest (smallest epoch) seen this slice for cursor advance.
        const t = parseWeiboDate(blog.created_at);
        const epoch = t ? Math.floor(t.getTime() / 1000) : null;
        if (epoch != null && (oldestEpoch == null || epoch < oldestEpoch)) oldestEpoch = epoch;

        if (seenMids.has(mid)) continue; // already collected in an earlier slice
        seenMids.add(mid);
        newCount++;
        stats.scanned++; // unique mids only — do not count boundary re-fetches

        const day = toDayStr(t);
        const preview = {
          mid,
          date: day,
          visible: visibleText(blog),
          isPrivate: isPrivate(blog),
          text: (blog.text_raw || "").slice(0, 40),
        };
        stats.hits.push(preview);

        if (isPrivate(blog)) {
          stats.skipped++;
          // 已锁定的不刷屏：前 3 条 + 每 50 条打一次进度
          if (stats.skipped <= 3 || stats.skipped % 50 === 0) {
            onLog(`跳过已锁定 ${stats.skipped} 条（最近 [${mid}] ${day}）`, "muted");
          }
        } else {
          onLog(`待锁 [${mid}] ${day} (${visibleText(blog)}) ${(blog.text_raw || "").slice(0, 20)}`, "hit");
        }
        onProgress({ ...stats });
      }

      if (newCount === 0) {
        // Every item this slice was already seen → stop (no progress).
        onLog(`本段无新微博（已全部覆盖），结束扫描。`, "info");
        break;
      }

      if (oldestEpoch == null) {
        onLog(`无法继续推进时间游标，结束扫描。`, "info");
        break;
      }
      // 含边界推进（curEnd = oldestEpoch，不再 -1）：若 50 条分页边界恰好切开
      // 同一秒发布的多条微博，-1 会让余下同秒帖子既不在本段也不在下段，被静默
      // 跳过；含边界推进时下一段必然带回它们（seenMids 去重，重复边界条目不会
      // 重复收集，stats.scanned 本来就只计新 mid）。代价是每段最多多带 1-2 条
      // 已见条目；窗口取空后由空列表或上面 newCount===0 终止，最多多花一次
      // 收尾请求，正确性优先。
      const nextEnd = oldestEpoch;
      if (nextEnd > curEnd) {
        onLog(`无法继续推进时间游标，结束扫描。`, "info");
        break;
      }
      if (starttime != null && nextEnd < starttime) {
        // nextEnd == starttime 时继续走：起点秒上的同秒组可能被分页边界切开，
        // 下一段（endtime=starttime）要把余下帖子取回后才由无新 mid 终止。
        onLog(`时间游标已低于起始时间，结束扫描。`, "info");
        break;
      }
      curEnd = nextEnd;
    }

    onLog(
      `完成 — 成功 ${stats.success} · 跳过 ${stats.skipped} · 失败 ${stats.failed} · 待锁 ${stats.hits.filter((h) => !h.isPrivate).length}` +
        "（预览，未实际修改）",
      "summary"
    );
    return stats;
  }

  /**
   * Lock a list of weibos by mid, reusing the mids gathered during preview
   * (avoids a second pagination sweep — halves request count + rate-limit exposure).
   *
   * Already-private items (preview snapshot) are bulk-counted into `skipped`
   * once at start — not walked one-by-one. Per-item "跳过" logs were already
   * emitted during preview; re-walking thousands of skips with yieldToRender
   * made "完成" hang long after real locks finished.
   *
   * isPrivate is the PREVIEW value, not re-fetched at run time; if you change a
   * post's visibility manually between preview and run, that is NOT re-checked.
   *
   * @param {Array<{mid:string, isPrivate:boolean, date?:string}>} hits
   */
  async function lockByIds(hits, { onLog, onProgress, signal }) {
    const stats = { success: 0, skipped: 0, failed: 0, scanned: hits.length, hits };
    // 已锁定的只计总数，不进逐条循环（避免千级跳过仍 rAF + onProgress 拖尾）
    const toLock = [];
    for (const item of hits) {
      if (item.isPrivate) stats.skipped++;
      else toLock.push(item);
    }
    onLog(
      `— 执行开始（真实修改），待锁 ${toLock.length} 条` +
        (stats.skipped ? `，已锁定跳过 ${stats.skipped} 条` : "") +
        ` —`,
      "info"
    );
    onProgress({ ...stats });

    for (const item of toLock) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      await yieldToRender(); // let the browser paint log/counters
      const mid = String(item.mid);
      const day = item.date || "";

      let done = false;
      for (let attempt = 1; attempt <= CONFIG.MAX_RETRY; attempt++) {
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        try {
          onLog(`处理中 [${mid}] 尝试 ${attempt}/${CONFIG.MAX_RETRY}`, "info");
          await modifyVisible(mid, signal);
          stats.success++;
          // Mutate preview snapshot so a second「执行」won't re-lock the same mid.
          item.isPrivate = true;
          onLog(`✓ 已锁定 [${mid}] ${day}`, "success");
          done = true;
          break;
        } catch (err) {
          if (err.name === "AbortError") throw err;
          if (err.code === "AUTH") {
            onLog(`鉴权失败，终止: ${err.message}`, "error");
            throw err;
          }
          if (err.code === "RISK") {
            if (attempt >= CONFIG.MAX_RETRY) {
              onLog(`✗ 风控/失败 [${mid}]: ${err.message}（已达最大重试）`, "error");
              break;
            }
            onLog(
              `限流 [${mid}]，暂停 ${CONFIG.RATE_LIMITED_WAIT_MS / 1000}s 后重试（${attempt}/${CONFIG.MAX_RETRY}）`,
              "warn"
            );
            await sleep(CONFIG.RATE_LIMITED_WAIT_MS, signal);
            continue;
          }
          // PERM：服务端永久拒绝（该微博类型不支持变更可见范围），重试必然失败。
          if (err.code === "PERM") {
            onLog(`✗ 不支持变更 [${mid}]: ${err.message}（不重试）`, "error");
            break;
          }
          const wait = CONFIG.RETRY_BASE_WAIT_MS * Math.pow(2, attempt - 1);
          onLog(`重试 [${mid}] ${err.message}，${wait / 1000}s 后重试`, "warn");
          await sleep(wait, signal);
        }
      }
      if (!done) stats.failed++;

      onProgress({ ...stats });
      // Human-like jitter on top of the window limiter, so request gaps
      // aren't perfectly regular (regularity is itself a bot signal).
      await sleep(randomDelayMs(1.0), signal);
    }

    onLog(
      `完成 — 成功 ${stats.success} · 跳过 ${stats.skipped} · 失败 ${stats.failed} · 共 ${stats.hits.length}`,
      "summary"
    );
    return stats;
  }

  // ===========================================================================
  // UI (Shadow DOM)
  // ===========================================================================

  const PANEL_ID = "__weibo_batch_locker_host__";

  function createPanel() {
    if (document.getElementById(PANEL_ID)) return;

    const host = document.createElement("div");
    host.id = PANEL_ID;
    host.style.cssText =
      "all:initial;position:fixed;top:80px;right:24px;z-index:2147483647;";
    document.body.appendChild(host);

    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = STYLE + BUILD_PANEL_HTML();

    // --- wire up state ---
    const state = {
      mode: "idle", // idle | previewing | running
      abortCtrl: null,
      lastPreview: null, // { hits, filterCfg, at } from the most recent dry-run
    };

    const $ = (sel) => root.querySelector(sel);
    const els = {
      filterRadios: Array.from(root.querySelectorAll('input[name="wbl-filter"]')),
      filterPanels: {
        date: $("#wbl-date-panel"),
        before: $("#wbl-before-panel"),
        mid: $("#wbl-mid-panel"),
        recent: $("#wbl-recent-panel"),
      },
      delay: $("#wbl-delay"),
      previewBtn: $("#wbl-preview"),
      runBtn: $("#wbl-run"),
      stopBtn: $("#wbl-stop"),
      clearBtn: $("#wbl-clear"),
      minimizeBtn: $("#wbl-min"),
      body: $("#wbl-body"),
      counts: {
        success: $("#wbl-c-success"),
        skipped: $("#wbl-c-skipped"),
        failed: $("#wbl-c-failed"),
        scanned: $("#wbl-c-scanned"),
        hits: $("#wbl-c-hits"),
      },
      log: $("#wbl-log"),
      uidHint: $("#wbl-uid"),
    };

    // uid: re-read on each action + SPA route change (weibo is SPA)
    let lastUidHint = undefined; // undefined = never set; null = shown as unknown
    function refreshUidHint(opts) {
      const quiet = opts && opts.quiet;
      const uid = getUid();
      els.uidHint.textContent = uid
        ? `当前 UID: ${uid}`
        : "未识别 UID（请确认已登录，或打开 /u/<你的uid>）";
      // Log only on transition unknown → known (avoid SPA spam)
      if (!quiet && uid && lastUidHint !== uid && (lastUidHint === null || lastUidHint === undefined)) {
        if (lastUidHint === null) log(`已识别 UID: ${uid}`, "info");
      }
      lastUidHint = uid;
      return uid;
    }
    refreshUidHint({ quiet: true });
    onSpaNavigate(() => refreshUidHint());

    // filter switching
    function currentFilterCfg() {
      const type = els.filterRadios.find((r) => r.checked)?.value || "recent";
      if (type === "date") {
        return {
          type: "date",
          start: $("#wbl-date-start").value.trim(),
          end: $("#wbl-date-end").value.trim(),
        };
      }
      if (type === "before") {
        return {
          type: "before",
          months: parseInt($("#wbl-before-months").value, 10) || 1,
        };
      }
      if (type === "mid") {
        return {
          type: "mid",
          startMid: $("#wbl-mid-start").value.trim(),
          endMid: $("#wbl-mid-end").value.trim(),
        };
      }
      return { type: "recent", n: Math.max(1, parseInt($("#wbl-recent-n").value, 10) || 10) };
    }
    function syncFilterPanels() {
      const type = els.filterRadios.find((r) => r.checked)?.value || "recent";
      Object.entries(els.filterPanels).forEach(([k, el]) => {
        el.style.display = k === type ? "" : "none";
      });
    }
    els.filterRadios.forEach((r) => r.addEventListener("change", syncFilterPanels));
    syncFilterPanels();

    // "时间预设": show the dynamically computed cutoff day next to the dropdown.
    const beforeCutoffEl = $("#wbl-before-cutoff");
    const beforeMonthsEl = $("#wbl-before-months");
    function refreshBeforeCutoff() {
      const m = parseInt(beforeMonthsEl.value, 10) || 1;
      // Strictly older than cutoff day (endtime = cutoff 00:00:00); not "及更早".
      beforeCutoffEl.textContent = `（锁定早于 ${cutoffDayMonthsAgo(m)} 的微博）`;
    }
    beforeMonthsEl.addEventListener("change", refreshBeforeCutoff);
    refreshBeforeCutoff();

    // Rate limit: bind the panel input to the global limiter.
    function syncRateLimit() {
      const m = Math.max(1, parseInt(els.delay.value, 10) || CONFIG.RATE_MAX);
      rateLimiter.setMax(m);
    }
    els.delay.addEventListener("change", syncRateLimit);
    syncRateLimit();

    // logging
    function log(msg, level) {
      const line = document.createElement("div");
      line.className = `wbl-log-line wbl-${level || "info"}`;
      const ts = new Date().toLocaleTimeString();
      line.textContent = `[${ts}] ${msg}`;
      els.log.appendChild(line);
      els.log.scrollTop = els.log.scrollHeight;
      // cap log size
      while (els.log.children.length > 500) els.log.removeChild(els.log.firstChild);
    }
    function setCounts(stats) {
      if (!stats) return;
      els.counts.success.textContent = stats.success;
      els.counts.skipped.textContent = stats.skipped;
      els.counts.failed.textContent = stats.failed;
      els.counts.scanned.textContent = stats.scanned;
      // 「待锁」= 命中且尚未仅自己可见（type!=1）。已锁定的只进「跳过」，不进此计数。
      const lockable = Array.isArray(stats.hits)
        ? stats.hits.filter((h) => !h.isPrivate).length
        : 0;
      els.counts.hits.textContent = lockable;
    }

    function setMode(mode) {
      state.mode = mode;
      const busy = mode === "previewing" || mode === "running";
      els.previewBtn.disabled = busy;
      els.runBtn.disabled = busy;
      els.stopBtn.disabled = !busy;
      els.clearBtn.disabled = busy;
      root.querySelectorAll("input, select").forEach((i) => (i.disabled = busy));
    }

    function validateCfg(cfg, uid) {
      if (!uid) return "未识别 UID，请确认已登录 weibo.com（或打开 /u/<你的uid> 后再试）。";
      if (!getXsrfToken()) return "读取不到 XSRF-TOKEN，请确认已登录 weibo.com。";
      if (cfg.type === "date") {
        const dRe = /^\d{4}-\d{2}-\d{2}$/;
        if (cfg.start && !dRe.test(cfg.start)) return "起始日期格式应为 YYYY-MM-DD";
        if (cfg.end && !dRe.test(cfg.end)) return "结束日期格式应为 YYYY-MM-DD";
        if (cfg.start && cfg.end && cfg.start > cfg.end) return "起始日期不能晚于结束日期";
      }
      if (cfg.type === "mid") {
        if (cfg.startMid && !/^\d+$/.test(cfg.startMid)) return "起始 mid 应为纯数字";
        if (cfg.endMid && !/^\d+$/.test(cfg.endMid)) return "结束 mid 应为纯数字";
        if (cfg.startMid && cfg.endMid && cmpMid(cfg.startMid, cfg.endMid) > 0)
          return "起始 mid 不能大于结束 mid";
        if (!cfg.startMid && !cfg.endMid)
          return "请至少填写起始 mid 或结束 mid（双空会扫全时间线）";
      }
      if (cfg.type === "before") {
        if (!(cfg.months >= 1)) return "时间预设的月数应大于 0";
      }
      return null;
    }

    // --- actions ---
    async function doPreview() {
      const uid = refreshUidHint();
      const cfg = currentFilterCfg();
      const err = validateCfg(cfg, uid);
      if (err) {
        log(err, "error");
        return;
      }
      setMode("previewing");
      state.abortCtrl = new AbortController();
      log("— 预览开始 —", "info");
      try {
        let stats;
        if (cfg.type === "date" || cfg.type === "before") {
          // Time-range filters: let the server do the date filtering via
          // searchProfile instead of pulling the whole timeline.
          let spOpts;
          if (cfg.type === "date") {
            if (!cfg.start && !cfg.end) {
              log("请至少填写起始或结束日期。", "error");
              setMode("idle");
              return;
            }
            spOpts = {
              uid,
              starttime: cfg.start ? dateStrToEpochSec(cfg.start, false) : undefined,
              endtime: cfg.end ? dateStrToEpochSec(cfg.end, true) : nowEpochSec(),
              onLog: log,
              onProgress: setCounts,
              signal: state.abortCtrl.signal,
            };
          } else {
            // "时间预设 N 个月前": lock everything strictly older than cutoff.
            const cutoffDay = cutoffDayMonthsAgo(Number(cfg.months));
            spOpts = {
              uid,
              starttime: undefined, // no lower bound
              endtime: dateStrToEpochSec(cutoffDay, false),
              onLog: log,
              onProgress: setCounts,
              signal: state.abortCtrl.signal,
            };
          }
          stats = await runApiModeSearchProfile(spOpts);
        } else {
          // "recent N" / "mid 范围": no server-side equivalent, fall back to
          // full mymblog pagination + client-side filter.
          stats = await runApiMode({
            uid,
            filterCfg: cfg,
            dryRun: true,
            onLog: log,
            onProgress: setCounts,
            signal: state.abortCtrl.signal,
          });
        }
        state.lastPreview = { hits: stats.hits, filterCfg: cfg, at: Date.now() };
        const lockable = stats.hits.filter((h) => !h.isPrivate).length;
        log(
          `预览完成 — 扫描 ${stats.scanned} · 待锁 ${lockable} · 已是仅自己可见 ${stats.skipped}`,
          "summary"
        );
        if (lockable > 0) {
          log(`点「执行」将锁定上述 ${lockable} 条（已锁定的会自动跳过）`, "info");
        } else {
          log(`没有需要锁定的微博。`, "info");
        }
      } catch (e) {
        if (e.name === "AbortError") log("预览已停止", "warn");
        else if (e.code === "AUTH") log(`鉴权错误: ${e.message}（请重新登录）`, "error");
        else log(`预览出错: ${e.message}`, "error");
      } finally {
        setMode("idle");
      }
    }

    async function doRun() {
      refreshUidHint(); // keep hint fresh; locking uses mids from lastPreview
      const cfg = currentFilterCfg();
      const err = validateCfg(cfg, getUid());
      if (err) {
        log(err, "error");
        return;
      }
      // Reuse the mids from the last preview instead of re-scanning.
      if (!state.lastPreview) {
        log("请先点「预览」扫描命中微博，再点「执行」。", "warn");
        return;
      }
      if (!sameFilterCfg(state.lastPreview.filterCfg, cfg)) {
        log("筛选条件与上次预览不一致，请重新点「预览」后再执行。", "warn");
        return;
      }
      const hits = state.lastPreview.hits;
      const toLock = hits.filter((h) => !h.isPrivate).length;
      const alreadyPrivate = hits.length - toLock;
      if (toLock === 0) {
        log("命中的微博均已锁定，无需操作。", "summary");
        return;
      }
      const ageMin = Math.round((Date.now() - state.lastPreview.at) / 60000);
      const ok = confirm(
        `将把 ${toLock} 条微博设为「仅自己可见」（可恢复）。\n` +
          `其中已锁定的 ${alreadyPrivate} 条会自动跳过。\n` +
          (ageMin > 0 ? `（依据 ${ageMin} 分钟前的预览数据，如期间手动改动过，执行时会自动跳过/失败）\n` : "") +
          `\n确认执行？`
      );
      if (!ok) {
        log("已取消执行", "warn");
        return;
      }
      // Real run: lock by the previewed mids directly (no re-scan).
      setMode("running");
      state.abortCtrl = new AbortController();
      try {
        await lockByIds(hits, {
          onLog: log,
          onProgress: setCounts,
          signal: state.abortCtrl.signal,
        });
      } catch (e) {
        if (e.name === "AbortError") log("执行已停止（已完成的不会回滚）", "warn");
        else if (e.code === "AUTH") log(`鉴权错误: ${e.message}（请重新登录）`, "error");
        else log(`执行出错: ${e.message}`, "error");
      } finally {
        setMode("idle");
      }
    }

    function doStop() {
      if (state.abortCtrl) {
        state.abortCtrl.abort();
        log("收到停止指令，正在中止当前请求...", "warn");
      }
    }

    els.previewBtn.addEventListener("click", doPreview);
    els.runBtn.addEventListener("click", doRun);
    els.stopBtn.addEventListener("click", doStop);
    els.clearBtn.addEventListener("click", () => {
      els.log.innerHTML = "";
      setCounts({ success: 0, skipped: 0, failed: 0, scanned: 0, hits: [] });
      state.lastPreview = null; // drop cached mids so「执行」不能用旧预览
      log("已清空日志与预览缓存，请重新预览后再执行。", "info");
    });

    // minimize / drag
    let minimized = false;
    els.minimizeBtn.addEventListener("click", () => {
      minimized = !minimized;
      els.body.style.display = minimized ? "none" : "";
      els.minimizeBtn.textContent = minimized ? "＋" : "—";
    });

    let dragging = false;
    let dx = 0;
    let dy = 0;
    const header = $("#wbl-header");
    header.addEventListener("mousedown", (e) => {
      if (e.target === els.minimizeBtn) return;
      dragging = true;
      const rect = host.getBoundingClientRect();
      dx = e.clientX - rect.left;
      dy = e.clientY - rect.top;
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      host.style.left = `${e.clientX - dx}px`;
      host.style.top = `${e.clientY - dy}px`;
      host.style.right = "auto";
    });
    window.addEventListener("mouseup", () => (dragging = false));

    setMode("idle");
    log("面板已加载。默认 dry-run 预览，点「执行」会二次确认。", "info");
    const bootUid = getUid();
    if (bootUid) log(`当前 UID: ${bootUid}`, "info");
    else log("提示：未识别到 UID，请确认已登录，或打开 https://weibo.com/u/<你的uid>", "warn");
  }

  // ===========================================================================
  // Stylesheet + HTML (kept inline for a single-file userscript)
  // ===========================================================================

  const STYLE = `
  <style>
    :host, * { box-sizing: border-box; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
    .wbl-panel {
      width: 380px; background: #1f2329; color: #e6e6e6;
      border: 1px solid #3a3f4b; border-radius: 10px;
      box-shadow: 0 8px 32px rgba(0,0,0,.4); font-size: 13px; line-height: 1.5;
      overflow: hidden;
    }
    .wbl-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 12px; background: #2a2f38; cursor: move; user-select: none;
      border-bottom: 1px solid #3a3f4b;
    }
    .wbl-title { font-weight: 600; font-size: 13px; }
    .wbl-title small { color: #9aa0aa; font-weight: 400; margin-left: 6px; }
    .wbl-min { background: transparent; color: #9aa0aa; border: none; cursor: pointer; font-size: 16px; line-height: 1; padding: 0 4px; }
    .wbl-body { padding: 10px 12px 12px; max-height: 70vh; overflow-y: auto; }
    .wbl-section { margin-bottom: 10px; }
    .wbl-label { display: block; color: #9aa0aa; font-size: 11px; margin-bottom: 4px; text-transform: uppercase; letter-spacing: .3px; }
    .wbl-radios { display: flex; gap: 12px; flex-wrap: wrap; }
    .wbl-radios label { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
    .wbl-row { display: flex; gap: 6px; align-items: center; margin-top: 4px; }
    .wbl-panel input[type=text], .wbl-panel input[type=date], .wbl-panel input[type=number], .wbl-panel select {
      background: #2c313a; border: 1px solid #3a3f4b; color: #e6e6e6;
      border-radius: 5px; padding: 4px 7px; font-size: 12px; width: 100%;
    }
    .wbl-panel input:disabled, .wbl-panel select:disabled { opacity: .5; }
    .wbl-btns { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0; }
    .wbl-btn {
      flex: 1; min-width: 70px; padding: 7px 8px; border-radius: 6px; border: none;
      cursor: pointer; font-size: 12px; font-weight: 600; transition: opacity .15s;
    }
    .wbl-btn:disabled { opacity: .4; cursor: not-allowed; }
    .wbl-preview { background: #3b6ea8; color: #fff; }
    .wbl-run { background: #d97706; color: #fff; }
    .wbl-stop { background: #c0392b; color: #fff; }
    .wbl-clear { background: #4a4f5a; color: #fff; }
    .wbl-counts { display: grid; grid-template-columns: repeat(5, 1fr); gap: 4px; margin: 8px 0; }
    .wbl-count { background: #2c313a; border-radius: 5px; padding: 5px 4px; text-align: center; }
    .wbl-count b { display: block; font-size: 15px; }
    .wbl-count span { font-size: 10px; color: #9aa0aa; }
    .wbl-c-success b { color: #34d399; }
    .wbl-c-skipped b { color: #9aa0aa; }
    .wbl-c-failed b { color: #f87171; }
    .wbl-c-hits b { color: #60a5fa; }
    .wbl-log {
      background: #15181d; border: 1px solid #2c313a; border-radius: 6px;
      padding: 6px 8px; height: 180px; overflow-y: auto; font-family: Consolas, monospace;
      font-size: 11px; line-height: 1.6;
    }
    .wbl-log-line { white-space: pre-wrap; word-break: break-all; }
    .wbl-info { color: #cbd5e1; }
    .wbl-hit { color: #93c5fd; }
    .wbl-success { color: #34d399; }
    .wbl-muted { color: #6b7280; }
    .wbl-warn { color: #fbbf24; }
    .wbl-error { color: #f87171; }
    .wbl-summary { color: #c4b5fd; font-weight: 600; border-top: 1px solid #2c313a; margin-top: 4px; padding-top: 4px; }
    .wbl-uid { font-size: 11px; color: #6b7280; margin-bottom: 6px; }
    .wbl-hint { font-size: 10px; color: #6b7280; margin-top: 6px; }
  </style>`;

  function BUILD_PANEL_HTML() {
    return `
    <div class="wbl-panel">
      <div class="wbl-header" id="wbl-header">
        <span class="wbl-title">微博批量锁 <small>v0.6.8</small></span>
        <button class="wbl-min" id="wbl-min" title="收起/展开">—</button>
      </div>
      <div class="wbl-body" id="wbl-body">
        <div class="wbl-uid" id="wbl-uid"></div>

        <div class="wbl-section">
          <span class="wbl-label">筛选方式</span>
          <div class="wbl-radios">
            <label><input type="radio" name="wbl-filter" value="recent" checked> 最近N条</label>
            <label><input type="radio" name="wbl-filter" value="before"> 时间预设</label>
            <label><input type="radio" name="wbl-filter" value="date"> 日期范围</label>
            <label><input type="radio" name="wbl-filter" value="mid"> mid范围</label>
          </div>
          <div id="wbl-recent-panel" class="wbl-row">
            <input type="number" id="wbl-recent-n" value="10" min="1" placeholder="N">
            <span class="wbl-hint" style="margin:0">条（按时间倒序）</span>
          </div>
          <div id="wbl-before-panel" class="wbl-row" style="display:none">
            <select id="wbl-before-months">
              <option value="1">1 个月前</option>
              <option value="3" selected>3 个月前</option>
              <option value="6">半年前 (6个月)</option>
              <option value="12">1 年前 (12个月)</option>
            </select>
            <span class="wbl-hint" id="wbl-before-cutoff" style="margin:0"></span>
          </div>
          <div id="wbl-date-panel" class="wbl-row" style="display:none">
            <input type="date" id="wbl-date-start" placeholder="起始">
            <span>~</span>
            <input type="date" id="wbl-date-end" placeholder="结束">
          </div>
          <div id="wbl-mid-panel" class="wbl-row" style="display:none">
            <input type="text" id="wbl-mid-start" placeholder="起始 mid" inputmode="numeric">
            <span>~</span>
            <input type="text" id="wbl-mid-end" placeholder="结束 mid" inputmode="numeric">
          </div>
        </div>

        <div class="wbl-section">
          <span class="wbl-label">请求限速：每 10 秒最多
            <input type="number" id="wbl-delay" value="3" min="1" max="10" step="1" style="width:50px;display:inline-block;vertical-align:middle">
            次请求</span>
          <div class="wbl-hint">越小越保守（默认 3 ≈ 每 3.3 秒 1 次）。被风控过就调小到 1~2。</div>
        </div>

        <div class="wbl-btns">
          <button class="wbl-btn wbl-preview" id="wbl-preview">预览(dry-run)</button>
          <button class="wbl-btn wbl-run" id="wbl-run">执行</button>
          <button class="wbl-btn wbl-stop" id="wbl-stop" disabled>停止</button>
          <button class="wbl-btn wbl-clear" id="wbl-clear">清空</button>
        </div>

        <div class="wbl-counts">
          <div class="wbl-count wbl-c-success"><b id="wbl-c-success">0</b><span>成功</span></div>
          <div class="wbl-count wbl-c-skipped"><b id="wbl-c-skipped">0</b><span>跳过</span></div>
          <div class="wbl-count wbl-c-failed"><b id="wbl-c-failed">0</b><span>失败</span></div>
          <div class="wbl-count"><b id="wbl-c-scanned">0</b><span>已扫描</span></div>
          <div class="wbl-count wbl-c-hits"><b id="wbl-c-hits">0</b><span>待锁</span></div>
        </div>

        <div class="wbl-log" id="wbl-log"></div>
        <div class="wbl-hint">默认 dry-run 不改数据；「执行」会先统计再二次确认。</div>
      </div>
    </div>`;
  }

  // ===========================================================================
  // Bootstrap
  // ===========================================================================

  function boot() {
    // Only inject on weibo.com pages where the panel makes sense.
    // Avoid iframe / login pages.
    if (window.top !== window.self) return;
    if (!/weibo\.com/.test(window.location.hostname)) return;
    if (/passport|login|sso/i.test(window.location.pathname)) return;

    // SPA: weibo may render body late; wait for it.
    const tryInject = () => {
      if (document.body && !document.getElementById(PANEL_ID)) {
        createPanel();
      }
    };
    if (document.body) tryInject();
    else document.addEventListener("DOMContentLoaded", tryInject, { once: true });
  }

  boot();
})();
