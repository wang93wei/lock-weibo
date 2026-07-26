// ==UserScript==
// @name         微博批量锁脚本 (设为仅自己可见)
// @namespace    https://github.com/weibo/weibo-batch-locker
// @version      0.3.0
// @description  在 weibo.com 登录态下，按「最近N条 / 时间预设(1月/3月/半年/1年前) / 发布日期范围 / mid 范围」筛选，批量将自己的微博设为「仅自己可见」(visible.type=1)。默认 dry-run 预览，二次确认后执行，可随时停止。
// @author       AlanWang
// @match        https://weibo.com/*
// @run-at       document-idle
// @grant        none
// @license      MIT
// ==/UserScript==

/* global window, document, fetch, URLSearchParams, AbortController, confirm */

/*
 * Interface contracts (verified first-hand 2026-07-27, see
 * .trellis/tasks/07-27-weibo-batch-locker/research/weibo-api-notes.md):
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
    DEFAULT_DELAY_SEC: 1.5, // delay between each modifyVisible call
    PAGE_DELAY_MS: 800, // delay between pagination requests (dry-run + run)
    RATE_LIMITED_WAIT_MS: 30000, // pause length when weibo rate-limits us
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

  /** Read the logged-in user's uid from the current URL. */
  function getUid() {
    const m = window.location.pathname.match(/\/u\/(\d+)/);
    if (m) return m[1];
    const m2 = window.location.pathname.match(/\/profile\/(\d+)/);
    if (m2) return m2[1];
    return null;
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

  /** True if the weibo is already "仅自己可见". Always returns a boolean. */
  function isPrivate(blog) {
    return Boolean(blog && blog.visible && blog.visible.type === CONFIG.PRIVATE_TYPE);
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

  /** Random delay around `baseSec` (±20%). */
  function randomDelayMs(baseSec) {
    return Math.round(baseSec * (0.8 + Math.random() * 0.4) * 1000);
  }

  // ===========================================================================
  // API layer
  // ===========================================================================

  function apiHeaders(isPost) {
    const h = {
      "x-requested-with": "XMLHttpRequest",
      "x-xsrf-token": getXsrfToken(),
    };
    if (isPost) h["content-type"] = "application/x-www-form-urlencoded";
    return h;
  }

  /** Fetch one page of the user's own weibo timeline. Returns data.data. */
  async function fetchBlogPage({ uid, page, sinceId }, signal) {
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
    if (!res.ok) throw new Error(`modifyVisible HTTP ${res.status}`);
    const data = await res.json();
    if (!(data.ok > 0)) {
      const e = new Error(`modifyVisible ok=${data.ok} ${data.msg || ""}`.trim());
      // ok<=0 with a rate/frequency message is rate-limiting; otherwise treat as risk too.
      e.code = /频次|频繁|过快|limit|too many/i.test(data.msg || "") ? "RISK" : "RISK";
      throw e;
    }
    return data;
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

  function byRecentN(blogs, { n }) {
    return blogs.slice(0, n); // mymblog is already newest-first
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

  // ===========================================================================
  // API executor (single source of truth for preview + run)
  // ===========================================================================

  /**
   * @param {object}   opts
   * @param {string}   opts.uid
   * @param {object}   opts.filterCfg   {type:"date"|"mid"|"recent", ...}
   * @param {boolean}  opts.dryRun      if true, never call modifyVisible
   * @param {number}   opts.delaySec    delay between real modifications
   * @param {function} opts.onLog       (msg, level) -> void
   * @param {function} opts.onProgress  (stats) -> void
   * @param {AbortSignal} opts.signal
   * @returns {Promise<object>} stats { success, skipped, failed, scanned, hits }
   */
  async function runApiMode(opts) {
    const { uid, filterCfg, dryRun, delaySec, onLog, onProgress, signal } = opts;
    const stats = { success: 0, skipped: 0, failed: 0, scanned: 0, hits: [] };
    let page = 1;
    let sinceId = null;
    let recentHitCount = 0; // for "recent N" we count non-skipped hits

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

      const matched = applyFilter(list, filterCfg);
      stats.scanned += list.length;

      for (const blog of matched) {
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");

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
          onLog(`跳过 [${mid}] ${day} (已是仅自己可见)`, "muted");
          onProgress({ ...stats });
          continue;
        }

        if (dryRun) {
          onLog(`命中 [${mid}] ${day} (${visibleText(blog)}) ${(blog.text_raw || "").slice(0, 20)}`, "hit");
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
            const wait = CONFIG.RETRY_BASE_WAIT_MS * Math.pow(2, attempt - 1);
            onLog(`重试 [${mid}] ${err.message}，${wait / 1000}s 后重试`, "warn");
            await sleep(wait, signal);
          }
        }
        if (!done) stats.failed++;

        onProgress({ ...stats });
        await sleep(randomDelayMs(delaySec), signal);
      }

      // "recent N": stop once we have enough non-skipped hits.
      if (filterCfg.type === "recent") {
        recentHitCount = stats.hits.length - stats.skipped;
        if (recentHitCount >= filterCfg.n) {
          onLog(`已达「最近 ${filterCfg.n} 条」目标，停止扫描。`, "info");
          break;
        }
      }

      sinceId = pageData.since_id;
      if (!sinceId) {
        onLog(`无 since_id，结束扫描。`, "info");
        break;
      }
      page++;
      // Throttle pagination to avoid tripping weibo's rate limiter.
      await sleep(CONFIG.PAGE_DELAY_MS, signal);
    }

    onLog(
      `完成 — 成功 ${stats.success} · 跳过 ${stats.skipped} · 失败 ${stats.failed} · 命中 ${stats.hits.length}` +
        (dryRun ? "（预览，未实际修改）" : ""),
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

    // uid hint
    const uid = getUid();
    els.uidHint.textContent = uid ? `当前 UID: ${uid}` : "未识别 UID（请打开 /u/<你的uid>）";

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
      beforeCutoffEl.textContent = `（锁定 ${cutoffDayMonthsAgo(m)} 及更早）`;
    }
    beforeMonthsEl.addEventListener("change", refreshBeforeCutoff);
    refreshBeforeCutoff();

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
      els.counts.hits.textContent = stats.hits.length;
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

    function validateCfg(cfg) {
      if (!uid) return "未识别 UID，请打开 https://weibo.com/u/<你的uid> 页面后再用。";
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
      }
      if (cfg.type === "before") {
        if (!(cfg.months >= 1)) return "时间预设的月数应大于 0";
      }
      return null;
    }

    // --- actions ---
    async function doPreview() {
      const cfg = currentFilterCfg();
      const err = validateCfg(cfg);
      if (err) {
        log(err, "error");
        return;
      }
      setMode("previewing");
      state.abortCtrl = new AbortController();
      log("— 预览开始 —", "info");
      try {
        const stats = await runApiMode({
          uid,
          filterCfg: cfg,
          dryRun: true,
          delaySec: parseFloat(els.delay.value) || CONFIG.DEFAULT_DELAY_SEC,
          onLog: log,
          onProgress: setCounts,
          signal: state.abortCtrl.signal,
        });
        log(`预览命中 ${stats.hits.length} 条（其中 ${stats.skipped} 条已是仅自己可见）`, "summary");
      } catch (e) {
        if (e.name === "AbortError") log("预览已停止", "warn");
        else if (e.code === "AUTH") log(`鉴权错误: ${e.message}（请重新登录）`, "error");
        else log(`预览出错: ${e.message}`, "error");
      } finally {
        setMode("idle");
      }
    }

    async function doRun() {
      const cfg = currentFilterCfg();
      const err = validateCfg(cfg);
      if (err) {
        log(err, "error");
        return;
      }
      // Re-preview quietly to count hits first (cheap, no modification)
      setMode("previewing");
      state.abortCtrl = new AbortController();
      log("— 先统计命中数量 —", "info");
      let preStats;
      try {
        preStats = await runApiMode({
          uid,
          filterCfg: cfg,
          dryRun: true,
          delaySec: parseFloat(els.delay.value) || CONFIG.DEFAULT_DELAY_SEC,
          onLog: () => {},
          onProgress: setCounts,
          signal: state.abortCtrl.signal,
        });
      } catch (e) {
        if (e.name === "AbortError") log("已停止", "warn");
        else log(`统计出错: ${e.message}`, "error");
        setMode("idle");
        return;
      }
      const toLock = preStats.hits.filter((h) => !h.isPrivate).length;
      if (toLock === 0) {
        log("没有需要锁定的微博（命中均为已锁定或空）", "summary");
        setMode("idle");
        return;
      }
      const ok = confirm(
        `将把 ${toLock} 条微博设为「仅自己可见」（可恢复）。\n` +
          `其中已锁定的 ${preStats.skipped} 条会自动跳过。\n\n确认执行？`
      );
      if (!ok) {
        log("已取消执行", "warn");
        setMode("idle");
        return;
      }
      // Real run
      setMode("running");
      state.abortCtrl = new AbortController();
      log("— 执行开始（真实修改）—", "info");
      try {
        await runApiMode({
          uid,
          filterCfg: cfg,
          dryRun: false,
          delaySec: parseFloat(els.delay.value) || CONFIG.DEFAULT_DELAY_SEC,
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
    if (!uid) log("提示：当前页未识别到 UID，请打开 https://weibo.com/u/<你的uid>", "warn");
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
        <span class="wbl-title">微博批量锁 <small>v0.3.0</small></span>
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
          <span class="wbl-label">每条修改延时（秒，随机±20%）· 翻页固定 0.8s</span>
          <input type="number" id="wbl-delay" value="1.5" min="0.5" step="0.1" style="width:80px">
        </div>

        <div class="wbl-btns">
          <button class="wbl-btn wbl-preview" id="wbl-preview">🔍 预览(dry-run)</button>
          <button class="wbl-btn wbl-run" id="wbl-run">🔒 执行</button>
          <button class="wbl-btn wbl-stop" id="wbl-stop" disabled>⏹ 停止</button>
          <button class="wbl-btn wbl-clear" id="wbl-clear">清空</button>
        </div>

        <div class="wbl-counts">
          <div class="wbl-count wbl-c-success"><b id="wbl-c-success">0</b><span>成功</span></div>
          <div class="wbl-count wbl-c-skipped"><b id="wbl-c-skipped">0</b><span>跳过</span></div>
          <div class="wbl-count wbl-c-failed"><b id="wbl-c-failed">0</b><span>失败</span></div>
          <div class="wbl-count"><b id="wbl-c-scanned">0</b><span>已扫描</span></div>
          <div class="wbl-count wbl-c-hits"><b id="wbl-c-hits">0</b><span>命中</span></div>
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
