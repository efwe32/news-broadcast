(() => {
  const STYLES = ["柔和", "温婉", "空灵", "狐媚", "御姐", "少女"];
  const FILTERS = [
    { id: "all", label: "全部" },
    { id: "ai", label: "人工智能" },
    { id: "breaking", label: "突发" },
    { id: "weibo", label: "微博" },
    { id: "douyin", label: "抖音" },
    { id: "toutiao", label: "头条" },
    { id: "world", label: "国际" },
    { id: "tech", label: "科技" },
    { id: "web3", label: "Web3" },
  ];
  const HALF_HOUR_MS = 30 * 60 * 1000;
  const HEARD_TTL_MS = 18 * 60 * 60 * 1000;
  const STORAGE_KEY = "news_broadcast_state_v1";
  const SILENT_WAV =
    "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQQAAAAAAA==";

  const state = {
    broadcastOn: false,
    style: "狐媚",
    filter: "all",
    intervalMs: 60000,
    items: [],
    priority: [],
    aiItems: [],
    sources: {},
    okSources: [],
    failedSources: [],
    fetchedAt: null,
    provider: null,
    queue: [],
    playing: false,
    heard: {},
    knownIds: new Set(),
    firstSnapshot: true,
    lastHalfHourAt: 0,
    notify: false,
    audioUnlocked: false,
    lastError: null,
  };

  const $ = (id) => document.getElementById(id);
  const player = $("player");

  function loadPersisted() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (s.style && STYLES.includes(s.style)) state.style = s.style;
      if (s.intervalMs) state.intervalMs = s.intervalMs;
      if (s.heard && typeof s.heard === "object") {
        const now = Date.now();
        for (const [k, t] of Object.entries(s.heard)) {
          if (now - t < HEARD_TTL_MS) state.heard[k] = t;
        }
      }
      if (Array.isArray(s.knownIds)) s.knownIds.forEach((id) => state.knownIds.add(id));
      if (s.lastHalfHourAt) state.lastHalfHourAt = s.lastHalfHourAt;
      state.firstSnapshot = !!s.firstSnapshot || state.knownIds.size === 0;
    } catch (_) {}
  }

  function persist() {
    const payload = {
      style: state.style,
      intervalMs: state.intervalMs,
      heard: state.heard,
      knownIds: [...state.knownIds].slice(-800),
      lastHalfHourAt: state.lastHalfHourAt,
      firstSnapshot: state.firstSnapshot,
    };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(payload)); } catch (_) {}
  }

  function titleKey(title) {
    return String(title || "").replace(/\s+/g, "").toLowerCase();
  }

  function wasHeard(title) {
    const k = titleKey(title);
    const t = state.heard[k];
    if (!t) return false;
    if (Date.now() - t > HEARD_TTL_MS) {
      delete state.heard[k];
      return false;
    }
    return true;
  }

  function markHeard(title) {
    state.heard[titleKey(title)] = Date.now();
    persist();
  }

  function fmtTime(iso) {
    if (iso == null || iso === "") return "—";
    try {
      const d = typeof iso === "number" ? new Date(iso) : new Date(iso);
      if (Number.isNaN(d.getTime())) return String(iso);
      return d.toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" });
    } catch {
      return String(iso);
    }
  }

  function heatStr(v) {
    if (v == null) return "";
    if (typeof v === "number") {
      if (v >= 10000) return (v / 10000).toFixed(1).replace(/\.0$/, "") + "万";
      return String(v);
    }
    return String(v);
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, "&#39;");
  }

  let toastTimer = null;
  function toast(msg, isErr) {
    const el = $("toast");
    el.textContent = msg;
    el.classList.toggle("hidden", false);
    el.classList.toggle("err", !!isErr);
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), 4200);
  }

  function setNowPlaying(text, mode) {
    const wrap = $("nowPlaying");
    const el = $("nowPlayingText");
    el.textContent = text;
    wrap.classList.toggle("playing", mode === "playing");
    wrap.classList.toggle("error", mode === "error");
  }

  async function unlockAudio() {
    if (state.audioUnlocked) return true;
    try {
      const prev = player.src;
      player.src = SILENT_WAV;
      player.muted = false;
      player.volume = 1;
      await player.play();
      player.pause();
      player.currentTime = 0;
      if (prev) player.src = prev;
      else player.removeAttribute("src");
      state.audioUnlocked = true;
      return true;
    } catch (e) {
      console.warn("audio unlock failed", e);
      return false;
    }
  }

  function flattenFromSources(sources) {
    const items = [];
    for (const [sid, block] of Object.entries(sources || {})) {
      if (!block || block.ok === false) continue;
      for (const it of block.items || []) {
        const row = { ...it, source: it.source || sid };
        if (!row.source_label) row.source_label = block.name || sid;
        items.push(row);
      }
    }
    items.sort((a, b) => {
      const score = (x) =>
        (x.ai ? 0 : 1) * 1000 +
        (x.breaking ? 0 : 1) * 100 +
        (x.rising ? 0 : 1) * 10 -
        (x.heat || 0) / 1e9;
      return score(a) - score(b);
    });
    return items;
  }

  function normalizeNewsPayload(data) {
    let items = Array.isArray(data.items) ? data.items.slice() : [];
    let sources = data.sources || {};
    if (!items.length && sources && typeof sources === "object") {
      items = flattenFromSources(sources);
    }
    // also accept nested result.items
    if (!items.length && data.result && Array.isArray(data.result.items)) {
      items = data.result.items.slice();
      sources = data.result.sources || sources;
    }
    const priority = Array.isArray(data.priority)
      ? data.priority
      : items.filter((x) => x.ai || x.breaking || x.rising).slice(0, 20);
    const aiItems = Array.isArray(data.ai_items)
      ? data.ai_items
      : items.filter((x) => x.ai).slice(0, 15);
    const okSources = Array.isArray(data.ok) ? data.ok : [];
    const failedSources = Array.isArray(data.failed) ? data.failed : [];
    return {
      items,
      priority,
      aiItems,
      sources,
      okSources,
      failedSources,
      fetchedAt: data.fetched_at || data.pulse_fetched_at || null,
      provider: data.provider || (data.pulse_stats ? "pulse" : null),
    };
  }

  function renderVoices() {
    const box = $("voicePicker");
    box.innerHTML = "";
    STYLES.forEach((s) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = s;
      b.className = s === state.style ? "active" : "";
      b.onclick = () => {
        state.style = s;
        persist();
        renderVoices();
        toast(`音色已切换：${s}`);
      };
      box.appendChild(b);
    });
  }

  function renderFilters() {
    const box = $("filters");
    box.innerHTML = "";
    FILTERS.forEach((f) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = f.label;
      b.className = f.id === state.filter ? "active" : "";
      b.onclick = () => {
        state.filter = f.id;
        renderFilters();
        renderFeed();
      };
      box.appendChild(b);
    });
  }

  function renderInterval() {
    document.querySelectorAll("#intervalPicker button").forEach((b) => {
      b.classList.toggle("active", Number(b.dataset.ms) === state.intervalMs);
      b.onclick = () => {
        state.intervalMs = Number(b.dataset.ms);
        persist();
        renderInterval();
        restartPoll();
      };
    });
  }

  function renderSources() {
    const box = $("sourcesBar");
    const countEl = $("sourcesCount");
    const ok = state.okSources || [];
    const failed = state.failedSources || [];
    if (!ok.length && !failed.length && state.sources) {
      const chips = Object.entries(state.sources).map(([id, block]) => {
        const n = (block.items || []).length;
        const good = block.ok !== false && n > 0;
        return `<span class="src-chip ${good ? "ok" : "fail"}"><span class="dot"></span>${escapeHtml(block.name || id)}<span class="n">${n}</span></span>`;
      });
      box.innerHTML = chips.length ? chips.join("") : '<div class="empty">暂无新闻源</div>';
      countEl.textContent = chips.length ? `${chips.length} 个源` : "";
      return;
    }
    if (!ok.length && !failed.length) {
      box.innerHTML = '<div class="empty">暂无新闻源 · 请刷新</div>';
      countEl.textContent = "";
      return;
    }
    const parts = [];
    ok.forEach((s) => {
      const n = s.count != null ? s.count : ((state.sources[s.id] || {}).items || []).length;
      parts.push(`<span class="src-chip ok"><span class="dot"></span>${escapeHtml(s.name || s.id)}<span class="n">${n} 条</span></span>`);
    });
    failed.forEach((s) => {
      const name = typeof s === "string" ? s : (s.name || s.id || "失败源");
      parts.push(`<span class="src-chip fail"><span class="dot"></span>${escapeHtml(name)}<span class="n">失败</span></span>`);
    });
    box.innerHTML = parts.join("");
    const live = ok.filter((s) => (s.count || 0) > 0).length;
    countEl.textContent = `正常 ${ok.length} · 有数据 ${live}`;
  }

  function cardHTML(it) {
    const tags = [];
    if (it.ai) tags.push('<span class="tag ai">AI</span>');
    if (it.rising) tags.push('<span class="tag rising">上升</span>');
    if (it.breaking) tags.push('<span class="tag break">突发</span>');
    if (it._isNew) tags.push('<span class="tag new">新上榜</span>');
    const heat = heatStr(it.heat ?? it.raw_heat);
    const url = it.url ? `<a class="link-btn" href="${escapeAttr(it.url)}" target="_blank" rel="noopener">打开</a>` : "";
    return `
      <article class="card" data-id="${escapeAttr(it.id || it.title)}">
        <h3 class="card-title">${escapeHtml(it.title)}</h3>
        <div class="card-meta">
          <span class="tag">${escapeHtml(it.source_label || it.source || "")}</span>
          ${heat ? `<span>热度 ${escapeHtml(heat)}</span>` : ""}
          ${it.rank != null ? `<span>#${it.rank}</span>` : ""}
          ${tags.join("")}
        </div>
        <div class="card-actions">
          <button class="play-btn" type="button" data-speak="${escapeAttr(it.title)}">播报</button>
          ${url}
        </div>
      </article>`;
  }

  function filteredItems() {
    const f = state.filter;
    let list = state.items;
    if (f === "all") return list;
    if (f === "ai") return list.filter((x) => x.ai);
    if (f === "breaking") return list.filter((x) => x.breaking || (x.labels || []).includes("breaking") || (x.labels || []).includes("hot"));
    return list.filter((x) => x.source === f);
  }

  function bindCardButtons(root) {
    root.querySelectorAll(".play-btn").forEach((btn) => {
      btn.onclick = async () => {
        await unlockAudio();
        const text = btn.getAttribute("data-speak");
        enqueue([{ text: `热点：${text}。`, title: text, kind: "card" }], true, true);
      };
    });
  }

  function emptyHTML(msg, withRetry) {
    return `<div class="empty${withRetry ? " error" : ""}"><div>${escapeHtml(msg)}</div>${
      withRetry ? '<button type="button" class="retry-btn" id="btnRetryNews">重试加载</button>' : ""
    }</div>`;
  }

  function bindRetry(root) {
    const btn = root.querySelector("#btnRetryNews");
    if (btn) btn.onclick = () => fetchNews().catch(() => {});
  }

  function renderPriority() {
    const box = $("priorityList");
    const list = state.priority.length ? state.priority : state.aiItems;
    if (!list.length) {
      box.innerHTML = emptyHTML(state.lastError ? `优先区加载失败：${state.lastError}` : "暂无优先条目", !!state.lastError);
      bindRetry(box);
      return;
    }
    box.innerHTML = list.slice(0, 12).map(cardHTML).join("");
    bindCardButtons(box);
  }

  function renderFeed() {
    const list = filteredItems();
    const label = FILTERS.find((x) => x.id === state.filter)?.label || "全部";
    $("feedTitle").textContent = label + "热点";
    $("feedCount").textContent = list.length ? `${list.length} 条` : "";
    const box = $("feedList");
    if (!list.length) {
      const msg = state.lastError
        ? `加载失败：${state.lastError}`
        : (state.items.length ? "当前筛选下暂无数据" : "暂无热点数据，请检查网络后重试");
      box.innerHTML = emptyHTML(msg, true);
      bindRetry(box);
      return;
    }
    box.innerHTML = list.slice(0, 60).map(cardHTML).join("");
    bindCardButtons(box);
  }

  function updateMeta() {
    $("updateTime").textContent = "更新时间 " + fmtTime(state.fetchedAt);
    const badge = $("providerBadge");
    badge.textContent = state.provider === "pulse" ? "Pulse 同源" : (state.provider || "—");
    badge.className = "badge " + (state.provider === "pulse" ? "ok" : "muted");
    $("queueStatus").textContent = state.playing
      ? `播报中 · 队列 ${state.queue.length}`
      : (state.queue.length ? `排队 ${state.queue.length}` : "队列空闲");
    $("heardCount").textContent = `已听过 ${Object.keys(state.heard).length} 条（18小时内自动跳过；手动播报除外）`;
  }

  async function fetchNews() {
    setNowPlaying("正在拉取新闻源…", null);
    try {
      const res = await fetch("/api/news?top_n=10", { cache: "no-store" });
      if (!res.ok) throw new Error("接口 HTTP " + res.status);
      const data = await res.json();
      const norm = normalizeNewsPayload(data);
      state.items = norm.items;
      state.priority = norm.priority;
      state.aiItems = norm.aiItems;
      state.sources = norm.sources;
      state.okSources = norm.okSources;
      state.failedSources = norm.failedSources;
      state.fetchedAt = norm.fetchedAt;
      state.provider = norm.provider;
      state.lastError = null;

      for (const it of state.items) {
        const id = it.id || it.title;
        it._isNew = !state.firstSnapshot && id && !state.knownIds.has(id);
      }

      renderSources();
      renderPriority();
      renderFeed();
      updateMeta();

      if (!state.items.length) {
        setNowPlaying("新闻源已响应，但条目为空", "error");
        toast("新闻列表为空，请稍后重试", true);
      } else {
        setNowPlaying(
          state.playing
            ? $("nowPlayingText").textContent
            : `已接入 ${state.items.length} 条热点 · ${state.okSources.length || Object.keys(state.sources).length} 个源`,
          null
        );
      }

      if (state.broadcastOn) {
        handleLiveQueue();
        maybeHalfHour();
      }

      for (const it of state.items) {
        const id = it.id || it.title;
        if (id) state.knownIds.add(id);
      }
      if (state.firstSnapshot) state.firstSnapshot = false;
      persist();
    } catch (e) {
      state.lastError = e.message || String(e);
      renderSources();
      renderPriority();
      renderFeed();
      updateMeta();
      setNowPlaying(`新闻加载失败：${state.lastError}`, "error");
      toast(`新闻加载失败：${state.lastError}`, true);
      throw e;
    }
  }

  function cleanForTts(text) {
    let t = String(text || "");
    t = t.replace(/https?:\/\/\S+/g, "");
    t = t.replace(/[#＃*_`~\[\]()（）【】<>]/g, "");
    t = t.replace(/\s{2,}/g, " ").trim();
    t = t.replace(/&/g, "和").replace(/\//g, "、");
    t = t.replace(/[|｜]+/g, "，");
    return t;
  }

  function compactChars(text) {
    return String(text || "").replace(/\s+/g, "");
  }

  /** One short detail sentence from summary; empty if none / overlap-only. */
  function detailFromSummary(title, summary) {
    let raw = cleanForTts(summary);
    if (!raw) return "";
    raw = raw.replace(
      /(凤凰网|中华网|中国科技网|央视网|新华网|人民网|观察者网|界面新闻|第一财经|美国之音|新浪科技|网易|澎湃新闻)\s*$/g,
      ""
    ).trim();
    const t = cleanForTts(title);
    const tn = compactChars(t);
    let sn = compactChars(raw);
    if (!sn || sn === tn) return "";
    if (tn.includes(sn)) return "";
    if (sn.includes(tn) && sn.length - tn.length < 12) return "";

    let detail = raw;
    let i = 0;
    while (i < tn.length && i < sn.length && tn[i] === sn[i]) i++;
    if (i >= Math.min(6, Math.floor(tn.length * 0.45))) {
      let kept = 0;
      let pos = 0;
      for (; pos < raw.length && kept < i; pos++) {
        if (!/\s/.test(raw[pos])) kept++;
      }
      detail = raw.slice(pos).replace(/^[，,：:\-—、\s]+/, "").trim();
    }
    sn = compactChars(detail);
    if (!detail || sn.length < 10) return "";
    if (tn.includes(sn) || sn === tn) return "";

    // Prefer ~40–80 chars; allow shorter useful clauses (>=10).
    if (sn.length > 80) {
      let count = 0;
      let cutAt = detail.length;
      for (let pos = 0; pos < detail.length; pos++) {
        if (!/\s/.test(detail[pos])) count++;
        if (count >= 80) {
          cutAt = pos + 1;
          break;
        }
      }
      let cut = detail.slice(0, cutAt);
      const minKeep = 36;
      let best = -1;
      for (const sep of ["。", "！", "？", "；", "，", "、", " "]) {
        const idx = cut.lastIndexOf(sep);
        if (idx >= minKeep) {
          best = idx;
          break;
        }
      }
      detail = (best >= 0 ? cut.slice(0, best) : cut).replace(/[，、；\s]+$/g, "").trim();
    }
    sn = compactChars(detail);
    if (sn.length < 10) return "";
    if (!/[。！？]$/.test(detail)) detail += "。";
    return detail;
  }

  const SOURCE_SPEAK_NAMES = {
    weibo: "微博", douyin: "抖音", toutiao: "头条",
    world: "国际", tech: "科技", web3: "Web3", ai: "AI要闻",
    cctv: "央视", domestic: "国内", kr36: "三十六氪",
  };

  function sourceLeadIn(it) {
    const sid = it.source || "";
    const name = SOURCE_SPEAK_NAMES[sid] || it.source_label || sid || "热点";
    return `来自${name}。`;
  }

  function speakLineForItem(it) {
    const title = cleanForTts(it.title || "");
    const detail = detailFromSummary(it.title, it.summary);
    const lead = sourceLeadIn(it);
    return detail ? `${lead}${title}。${detail}` : `${lead}${title}。`;
  }

  function handleLiveQueue() {
    const candidates = [];
    const pool = [
      ...(state.priority || []),
      ...state.items.filter((x) => x._isNew && ["world", "tech", "web3", "ai"].includes(x.source)),
    ];
    const seen = new Set();
    for (const it of pool) {
      const k = titleKey(it.title);
      if (!k || seen.has(k) || wasHeard(it.title)) continue;
      seen.add(k);
      candidates.push(it);
    }
    const batch = candidates.slice(0, 5).map((it) => ({
      text: speakLineForItem(it),
      title: it.title,
      kind: "live",
    }));
    if (batch.length) {
      enqueue(batch, false, false);
      if (state.notify && Notification.permission === "granted") {
        try {
          new Notification("新闻播报", { body: batch[0].title, silent: true });
        } catch (_) {}
      }
    }
  }

  function maybeHalfHour() {
    const now = Date.now();
    if (state.lastHalfHourAt && now - state.lastHalfHourAt < HALF_HOUR_MS) return;
    if (!state.lastHalfHourAt) {
      state.lastHalfHourAt = now - HALF_HOUR_MS + 8000;
      persist();
      return;
    }
    state.lastHalfHourAt = now;
    persist();
    const script = buildHalfHourScript();
    if (script) enqueue([{ text: script, title: "__half_hour__", kind: "half_hour" }], false, true);
  }

  function buildHalfHourScript() {
    const order = ["weibo", "douyin", "toutiao"];
    const names = { weibo: "微博", douyin: "抖音", toutiao: "头条" };
    const parts = ["半小时热搜。"];
    let any = false;
    for (const sid of order) {
      const block = state.sources[sid];
      if (!block || block.ok === false) continue;
      const items = (block.items || []).slice(0, 10);
      if (!items.length) continue;
      any = true;
      parts.push(`来自${names[sid]}。`);
      items.forEach((it, i) => {
        const title = cleanForTts(it.title || "");
        const detail = detailFromSummary(it.title, it.summary);
        parts.push(detail ? `${i + 1}，${title}。${detail}` : `${i + 1}，${title}。`);
      });
    }
    return any ? parts.join("") : null;
  }

  /** @param force if true, ignore wasHeard (manual 播报 / 播报本区) */
  function enqueue(items, front, force) {
    const filtered = items.filter((x) => {
      if (force) return true;
      if (x.title === "__half_hour__") return true;
      return !wasHeard(x.title);
    });
    if (!filtered.length) {
      if (force) toast("没有可播报的内容", true);
      else toast("这些条目最近已听过，已自动跳过");
      return;
    }
    if (front) state.queue.unshift(...filtered);
    else state.queue.push(...filtered);
    updateMeta();
    drainQueue();
  }

  async function drainQueue() {
    if (state.playing) return;
    const next = state.queue.shift();
    if (!next) {
      updateMeta();
      return;
    }
    state.playing = true;
    updateMeta();
    setNowPlaying(`正在播报：${next.title === "__half_hour__" ? "半小时热搜" : next.title}`, "playing");
    try {
      await playTTS(next.text);
      if (next.title && next.title !== "__half_hour__") markHeard(next.title);
      setNowPlaying(
        state.queue.length ? `下一条准备中（队列 ${state.queue.length}）` : "本段播报完成",
        null
      );
    } catch (e) {
      console.warn("tts play failed", e);
      const msg = e.message || String(e);
      setNowPlaying(`播报失败：${msg}`, "error");
      toast(`播报失败：${msg}`, true);
    } finally {
      state.playing = false;
      updateMeta();
      setTimeout(() => drainQueue(), 280);
    }
  }

  async function fetchTTSBlob(text) {
    const body = JSON.stringify({ text, style: state.style });
    let res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "audio/mpeg" },
      body,
      cache: "no-store",
    });
    // Some tunnels flake on POST — fall back to GET
    if (!res.ok) {
      const q = new URLSearchParams({ text: text.slice(0, 800), style: state.style });
      res = await fetch(`/api/tts?${q.toString()}`, {
        method: "GET",
        headers: { Accept: "audio/mpeg" },
        cache: "no-store",
      });
    }
    if (!res.ok) {
      let detail = "";
      try { detail = await res.text(); } catch (_) {}
      throw new Error(detail || `语音接口 ${res.status}`);
    }
    const buf = await res.arrayBuffer();
    if (!buf || buf.byteLength < 64) throw new Error("语音数据为空");
    const ctype = res.headers.get("content-type") || "audio/mpeg";
    return new Blob([buf], { type: ctype.split(";")[0].trim() || "audio/mpeg" });
  }

  async function playTTS(text) {
    await unlockAudio();
    const blob = await fetchTTSBlob(text);
    const url = URL.createObjectURL(blob);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        player.removeEventListener("ended", onEnd);
        player.removeEventListener("error", onErr);
        try { URL.revokeObjectURL(url); } catch (_) {}
        if (err) reject(err);
        else resolve();
      };
      const onEnd = () => finish(null);
      const onErr = () => finish(new Error("音频播放出错"));
      player.addEventListener("ended", onEnd);
      player.addEventListener("error", onErr);
      player.src = url;
      player.load();
      const p = player.play();
      if (p && typeof p.then === "function") {
        p.catch(async (err) => {
          // retry once after unlock
          const ok = await unlockAudio();
          if (!ok) return finish(new Error("浏览器拦截自动播放，请再点一次播报"));
          player.play().catch(() => finish(new Error(err.message || "无法播放音频")));
        });
      }
    });
  }

  $("btnBroadcast").onclick = async () => {
    await unlockAudio();
    state.broadcastOn = !state.broadcastOn;
    const btn = $("btnBroadcast");
    btn.classList.toggle("on", state.broadcastOn);
    btn.classList.toggle("off", !state.broadcastOn);
    btn.setAttribute("aria-pressed", String(state.broadcastOn));
    btn.querySelector(".label").textContent = state.broadcastOn ? "播报开" : "播报关";
    if (state.broadcastOn) {
      setNowPlaying("播报已开启，监听新热点中…", "playing");
      handleLiveQueue();
      if (!state.lastHalfHourAt) {
        state.lastHalfHourAt = Date.now() - HALF_HOUR_MS + 5000;
        persist();
      }
      // kick a short demo line if queue empty so user hears 狐媚 immediately
      if (!state.queue.length && !state.playing && state.items.length) {
        const it = (state.priority[0] || state.items[0]);
        enqueue([{ text: speakLineForItem(it), title: it.title, kind: "kickoff" }], true, true);
      }
    } else {
      state.queue = [];
      try { player.pause(); } catch (_) {}
      state.playing = false;
      setNowPlaying("播报已关闭", null);
    }
    updateMeta();
  };

  $("btnRefresh").onclick = async () => {
    try {
      await fetchNews();
      toast("已刷新新闻");
    } catch (_) {}
  };
  $("btnSettings").onclick = () => $("settingsPanel").classList.toggle("hidden");
  $("btnNotify").onclick = async () => {
    if (!("Notification" in window)) {
      toast("当前浏览器不支持通知", true);
      return;
    }
    const p = await Notification.requestPermission();
    state.notify = p === "granted";
    $("btnNotify").textContent = state.notify ? "通知开" : "通知";
  };
  $("btnPlayPriority").onclick = async () => {
    await unlockAudio();
    const list = (state.priority.length ? state.priority : state.aiItems).slice(0, 8);
    if (!list.length) {
      toast("本区暂无条目，请先刷新新闻", true);
      setNowPlaying("本区为空，无法播报", "error");
      return;
    }
    enqueue(
      list.map((it) => ({ text: speakLineForItem(it), title: it.title, kind: "priority" })),
      true,
      true // force — 播报本区 must always play
    );
  };

  let pollTimer = null;
  function restartPoll() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      fetchNews().catch(() => {});
    }, state.intervalMs);
  }

  setInterval(() => {
    if (state.broadcastOn) maybeHalfHour();
  }, 60 * 1000);

  // unlock on first pointer interaction anywhere
  const unlockOnce = () => { unlockAudio(); };
  document.addEventListener("pointerdown", unlockOnce, { once: true, passive: true });

  loadPersisted();
  renderVoices();
  renderFilters();
  renderInterval();
  renderSources();
  updateMeta();
  setNowPlaying("正在加载新闻源…", null);
  fetchNews()
    .catch(() => {})
    .finally(restartPoll);
})();
