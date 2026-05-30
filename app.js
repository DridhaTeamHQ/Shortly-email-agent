// Shortly dashboard — review, approve, manage subscribers, send digest.

const cfg = window.SHORTLY;
const DAILY_CAP = cfg.dailyCap ?? 10;

// ---------- helpers ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function esc(s = "") {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2800);
}

async function api(method, path, body) {
  const headers = { "Content-Type": "application/json" };
  if (cfg.anonKey) {
    headers["apikey"] = cfg.anonKey;
    headers["Authorization"] = `Bearer ${cfg.anonKey}`;
  }
  const r = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

const todayUtc = () => new Date().toISOString().slice(0, 10);
const isApprovedToday = (a) =>
  a.status === "approved" && (a.reviewed_at ?? "").slice(0, 10) === todayUtc();

// ---------- state ----------
const state = {
  articles: [],
  subscribers: [],
  digests: [],
  section: "review",
  search: "",
  filterTopic: "",
  filterSection: "",
  selected: new Set(),
  selectedSubscribers: new Set(),
  dragId: null
};

// ---------- computed ----------
function approvedTodayCount() {
  return state.articles.filter(isApprovedToday).length;
}

function sectionCounts() {
  const approved = state.articles.filter(isApprovedToday);
  return {
    wrapped: approved.length
  };
}

function filteredArticles(statusFilter) {
  let items = state.articles.filter((a) => a.status === statusFilter);
  const q = state.search.toLowerCase().trim();
  if (q) {
    items = items.filter(
      (a) =>
        (a.title || "").toLowerCase().includes(q) ||
        (a.edited_title || "").toLowerCase().includes(q) ||
        (a.summary || "").toLowerCase().includes(q) ||
        (a.edited_summary || "").toLowerCase().includes(q) ||
        (a.topic || "").toLowerCase().includes(q) ||
        (a.source || "").toLowerCase().includes(q)
    );
  }
  if (state.filterTopic) {
    items = items.filter((a) => a.topic === state.filterTopic);
  }
  if (state.filterSection) {
    items = items.filter((a) => (a.section || "wrapped") === state.filterSection);
  }
  return items;
}

function uniqueTopics() {
  const topics = new Set();
  state.articles.forEach((a) => { if (a.topic) topics.add(a.topic); });
  return [...topics].sort();
}

function selectedSubscriberCount() {
  return state.subscribers.filter((s) => s.status === "subscribed" && state.selectedSubscribers.has(s.id)).length;
}

function updateSubscriberSelectionUi() {
  const count = selectedSubscriberCount();
  const bar = $("#subscriberBulkBar");
  const label = $("#subscriberBulkCount");
  const selectAll = $("#subSelectAll");
  if (label) {
    label.textContent = count > 0
      ? `${count} recipient${count === 1 ? "" : "s"} selected`
      : "All subscribed recipients will receive the digest";
  }
  if (bar) {
    bar.classList.toggle("show", count > 0);
  }
  if (selectAll) {
    const subscribed = state.subscribers.filter((s) => s.status === "subscribed");
    const allChecked = subscribed.length > 0 && subscribed.every((s) => state.selectedSubscribers.has(s.id));
    selectAll.checked = allChecked;
    selectAll.indeterminate = !allChecked && count > 0;
  }
}

// ---------- rendering ----------
function refreshChrome() {
  const approved = approvedTodayCount();
  const counts = sectionCounts();
  const pending = state.articles.filter((a) => a.status === "summarized").length;
  const rejected = state.articles.filter((a) => a.status === "rejected").length;
  const subs = state.subscribers.filter((s) => s.status === "subscribed").length;

  $("#badgeReview").textContent = pending;
  $("#badgeApproved").textContent = `${approved}/${DAILY_CAP}`;
  $("#badgeRejected").textContent = rejected;
  $("#badgeSubs").textContent = subs;

  const send = $("#sendDigest");
  const selectedSubs = selectedSubscriberCount();
  send.textContent = selectedSubs > 0
    ? `Send (${counts.wrapped}) to ${selectedSubs}`
    : `Send (${counts.wrapped})`;
  send.disabled = approved === 0 || subs === 0;

  const preview = $("#previewDigest");
  preview.style.display = approved > 0 ? "" : "none";

  const titles = {
    review: ["Review queue", `Wrapped: ${counts.wrapped}/${DAILY_CAP} | ${pending} pending`],
    approved: ["Approved", `${counts.wrapped} Wrapped article${counts.wrapped === 1 ? "" : "s"} ready`],
    rejected: ["Rejected", `${rejected} articles removed from queue`],
    history: ["Digest History", "All past digests and delivery stats"],
    analytics: ["Analytics", "Overview of your newsletter performance"],
    subscribers: ["Subscribers", `${subs} active subscriber${subs === 1 ? "" : "s"}`],
    scraper: ["Scraper", "Submit articles for summarization"]
  };
  const [t, sub] = titles[state.section] || ["", ""];
  $("#sectionTitle").textContent = t;
  $("#sectionSub").textContent = sub;
}

function populateTopicFilter() {
  const sel = $("#filterTopic");
  const current = sel.value;
  const topics = uniqueTopics();
  sel.innerHTML = `<option value="">All topics</option>` +
    topics.map((t) => `<option value="${esc(t)}" ${t === current ? "selected" : ""}>${esc(t)}</option>`).join("");
}

function cardHtml(a, mode) {
  const headline = a.edited_title || a.title || "";
  const text = a.edited_summary || a.summary || "";
  const date = new Date(a.scraped_at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const time = new Date(a.scraped_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const source = a.source ? `<span class="source-pill">${esc(a.source)}</span>` : "";
  const topic = a.topic ? `<span class="topic-chip">${esc(a.topic)}</span>` : "";
  const sec = "wrapped";
  const atCap = approvedTodayCount() >= DAILY_CAP;
  const checked = state.selected.has(a.id) ? "checked" : "";
  const draggable = mode === "approved" ? 'draggable="true"' : "";

  // Section picker
  const sectionPicker = mode !== "rejected" ? `
    <div class="section-picker">
      <label class="section-label">Section:</label>
      <select data-role="section" disabled>
        <option value="wrapped" selected>Wrapped</option>
      </select>
    </div>` : "";

  // Bulk checkbox (only in review mode)
  const checkbox = mode === "review" ? `<input type="checkbox" class="card-check" data-id="${a.id}" ${checked}>` : "";

  let actions = "";
  if (mode === "review") {
    actions = `
      <div class="actions">
        ${sectionPicker}
        <button class="btn-save" data-action="edit">Save</button>
        <button class="btn-reject" data-action="reject">Reject</button>
        <button class="btn-approve" data-action="approve" ${atCap ? "disabled" : ""}>
          ${atCap ? "Limit" : "Approve"}
        </button>
      </div>`;
  } else if (mode === "approved") {
    actions = `
      <div class="actions">
        ${sectionPicker}
        <button class="btn-save" data-action="edit">Save</button>
        <button class="btn-reject" data-action="reject">Remove</button>
      </div>`;
  }

  const sectionTag = `<span class="tag section-${sec}">${sec}</span>`;
  const readonly = mode === "rejected" ? "readonly" : "";
  const headlineReadonly = mode === "rejected" ? "readonly" : "";

  // Read time estimate
  const words = text.split(/\s+/).filter(Boolean).length;
  const readTime = Math.max(1, Math.ceil(words / 200));

  return `
    <article class="card ${checked ? "selected" : ""}" data-id="${a.id}" ${draggable}>
      <header>
        ${checkbox}
          <div class="card-head">
            <div class="chips">${source}${topic}${sectionTag}<span class="tag ${a.status}">${a.status}</span></div>
            <input class="headline-input" data-role="headline" type="text" value="${esc(headline)}" ${headlineReadonly} />
            <div class="meta">
              ${date} &middot; ${time}
              &middot; <a href="${esc(a.url)}" target="_blank" rel="noreferrer">Source</a>
            &middot; ${readTime} min read
          </div>
        </div>
      </header>
      <textarea data-role="summary" rows="4" ${readonly}>${esc(text)}</textarea>
      ${actions}
    </article>`;
}

function renderReview() {
  const items = filteredArticles("summarized");
  const node = $("#reviewList");
  node.innerHTML = items.length
    ? items.map((a) => cardHtml(a, "review")).join("")
    : `<p class="muted">No articles to review${state.search ? " matching your search" : ""}.</p>`;
}

function renderApproved() {
  const items = state.articles.filter(isApprovedToday);
  const node = $("#approvedList");
  node.innerHTML = items.length
    ? items.map((a) => cardHtml(a, "approved")).join("")
    : `<p class="muted">Nothing approved yet today.</p>`;
  attachDragListeners();
}

function renderRejected() {
  const items = state.articles.filter((a) => a.status === "rejected");
  const node = $("#rejectedList");
  node.innerHTML = items.length
    ? items.map((a) => cardHtml(a, "rejected")).join("")
    : `<p class="muted">No rejected articles.</p>`;
}

function renderSubscribers() {
  const subscribed = state.subscribers.filter((s) => s.status === "subscribed");
  const allChecked = subscribed.length > 0 && subscribed.every((s) => state.selectedSubscribers.has(s.id));
  const rows = state.subscribers
    .map(
      (s) => `
      <tr data-id="${s.id}">
        <td>${s.status === "subscribed" ? `<input type="checkbox" class="sub-check" data-id="${s.id}" ${state.selectedSubscribers.has(s.id) ? "checked" : ""}>` : ""}</td>
        <td>${esc(s.email)}</td>
        <td>${esc(s.full_name || "")}</td>
        <td><span class="dot ${s.status}"></span>${esc(s.status)}</td>
        <td class="row-actions">
          ${s.status === "subscribed"
            ? `<button class="btn-ghost" data-action="unsubscribe">Unsubscribe</button>`
            : `<button class="btn-ghost" data-action="subscribe">Re-subscribe</button>`}
          <button class="btn-ghost" data-action="delete">Delete</button>
        </td>
      </tr>`
    )
    .join("");
  $("#subRows").innerHTML = rows || `<tr><td colspan="5" class="muted" style="padding:18px">No subscribers yet.</td></tr>`;
  const selectAll = $("#subSelectAll");
  if (selectAll) {
    selectAll.checked = allChecked;
    selectAll.indeterminate = !allChecked && selectedSubscriberCount() > 0;
  }
  updateSubscriberSelectionUi();
}

function renderHistory() {
  if (state.digests.length === 0) {
    $("#historyRows").innerHTML = `<tr><td colspan="6" class="muted" style="padding:20px;text-align:center">No digests sent yet.</td></tr>`;
    return;
  }
  const rows = state.digests.map((d) => {
    const date = new Date(d.sent_at).toLocaleDateString("en-US", {
      weekday: "short", month: "short", day: "numeric", year: "numeric"
    });
    const time = new Date(d.sent_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    const total = (d.sent || 0) + (d.failed || 0);
    const rate = total > 0 ? Math.round((d.sent / total) * 100) : 0;
    const statusBadge = d.failed > 0
      ? `<span class="history-badge fail">${rate}% delivered</span>`
      : `<span class="history-badge success">All delivered</span>`;
    return `<tr>
      <td>${date}<br><span class="muted" style="font-size:11px">${time}</span></td>
      <td>${(d.article_ids || []).length}</td>
      <td>${d.recipients || 0}</td>
      <td>${d.sent || 0}</td>
      <td>${d.failed || 0}</td>
      <td>${statusBadge}</td>
    </tr>`;
  }).join("");
  $("#historyRows").innerHTML = rows;
}

function renderAnalytics() {
  const subs = state.subscribers.filter((s) => s.status === "subscribed").length;
  const totalArticles = state.articles.length;
  const totalDigests = state.digests.length;
  const totalSent = state.digests.reduce((s, d) => s + (d.sent || 0), 0);
  const totalFailed = state.digests.reduce((s, d) => s + (d.failed || 0), 0);
  const deliveryRate = (totalSent + totalFailed) > 0
    ? Math.round((totalSent / (totalSent + totalFailed)) * 100)
    : 0;

  $("#statDigests").textContent = totalDigests;
  $("#statArticles").textContent = totalArticles;
  $("#statSubscribers").textContent = subs;
  $("#statDeliveryRate").textContent = deliveryRate + "%";

  // Recent digests chart (last 10)
  const recent = state.digests.slice(0, 10);
  if (recent.length === 0) {
    $("#analyticsRows").innerHTML = `<tr><td colspan="4" class="muted" style="padding:20px;text-align:center">No data yet.</td></tr>`;
    return;
  }
  const rows = recent.map((d) => {
    const date = new Date(d.sent_at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const total = (d.sent || 0) + (d.failed || 0);
    const rate = total > 0 ? Math.round((d.sent / total) * 100) + "%" : "-";
    return `<tr><td>${date}</td><td>${d.sent || 0}</td><td>${d.failed || 0}</td><td>${rate}</td></tr>`;
  }).join("");
  $("#analyticsRows").innerHTML = rows;
}

function renderAll() {
  refreshChrome();
  populateTopicFilter();
  renderReview();
  renderApproved();
  renderRejected();
  renderSubscribers();
  renderHistory();
  renderAnalytics();
  updateBulkBar();
}

// ---------- data loaders ----------
async function loadArticles() {
  // Load each relevant status separately to avoid high-rank pending articles
  // pushing summarized articles past the limit
  const [review, approved, rejected, sent] = await Promise.all([
    api("GET", `${cfg.list}?status=summarized&limit=100`),
    api("GET", `${cfg.list}?status=approved&limit=50`),
    api("GET", `${cfg.list}?status=rejected&limit=50`),
    api("GET", `${cfg.list}?status=sent&limit=100`)
  ]);
  // Merge and dedupe by id
  const map = new Map();
  [review, approved, rejected, sent].forEach((res) => {
    (res.articles || []).forEach((a) => map.set(a.id, a));
  });
  state.articles = [...map.values()];
}

async function loadSubscribers() {
  const data = await api("GET", cfg.subscribers);
  state.subscribers = data.subscribers || [];
  const validIds = new Set(state.subscribers.filter((s) => s.status === "subscribed").map((s) => s.id));
  state.selectedSubscribers.forEach((id) => {
    if (!validIds.has(id)) state.selectedSubscribers.delete(id);
  });
}

async function loadDigests() {
  try {
    // Use Supabase REST API directly for digests
    const base = cfg.list.replace("/list-articles", "");
    const headers = { "Content-Type": "application/json" };
    if (cfg.anonKey) {
      headers["apikey"] = cfg.anonKey;
      headers["Authorization"] = `Bearer ${cfg.anonKey}`;
    }
    const url = cfg.list.replace("list-articles", "").replace("functions/v1/", "rest/v1/");
    const supabaseUrl = url.replace(/\/functions\/.*/, "").replace(/\/rest\/.*/, "");
    // Build REST URL from the function URL
    const projectUrl = cfg.list.match(/(https:\/\/[^/]+)/)?.[1]?.replace(".functions.", ".");
    if (projectUrl) {
      const r = await fetch(`${projectUrl}/rest/v1/digests?select=*&order=sent_at.desc&limit=50`, {
        headers: {
          "apikey": cfg.anonKey,
          "Authorization": `Bearer ${cfg.anonKey}`
        }
      });
      if (r.ok) {
        state.digests = await r.json();
      }
    }
  } catch (e) {
    console.warn("Could not load digests:", e);
  }
}

async function reload() {
  try {
    await Promise.all([loadArticles(), loadSubscribers(), loadDigests()]);
    renderAll();
  } catch (e) {
    toast(`Load failed: ${e.message}`);
  }
}

// ---------- actions ----------
async function handleArticleAction(card, action) {
  const id = card.dataset.id;
  const headline = card.querySelector("input[data-role=headline]")?.value.trim();
  const summary = card.querySelector("textarea")?.value.trim();
  const section = card.querySelector("select[data-role=section]")?.value || "wrapped";
  const body = { id, action, reviewer: cfg.reviewer, section };
  if (action === "edit" || action === "approve") body.edited_title = headline;
  if (action === "edit" || action === "approve") body.edited_summary = summary;
  try {
    await api("POST", cfg.review, body);
    state.selected.delete(id);
    await reload();
    toast(action === "edit" ? "Summary saved." : `Article ${action}d.`);
  } catch (e) {
    toast(`Failed: ${e.message}`);
  }
}

async function handleSubscriberAction(row, action) {
  const id = row.dataset.id;
  try {
    if (action === "delete") {
      await api("POST", cfg.subscribers, { action: "delete", id });
    } else {
      const status = action === "subscribe" ? "subscribed" : "unsubscribed";
      await api("POST", cfg.subscribers, { action: "update", id, status });
    }
    await reload();
  } catch (e) {
    toast(`Failed: ${e.message}`);
  }
}

// ---------- bulk actions ----------
function updateBulkBar() {
  const bar = $("#bulkBar");
  const count = state.selected.size;
  if (count > 0) {
    bar.classList.add("show");
    $("#bulkCount").textContent = `${count} selected`;
  } else {
    bar.classList.remove("show");
  }
}

async function bulkAction(action) {
  if (state.selected.size === 0) return;
  const ids = [...state.selected];
  toast(`Processing ${ids.length} articles...`);
  try {
    for (const id of ids) {
      await api("POST", cfg.review, { id, action, reviewer: cfg.reviewer });
    }
    state.selected.clear();
    await reload();
    toast(`${ids.length} articles ${action}d.`);
  } catch (e) {
    toast(`Failed: ${e.message}`);
  }
}

// ---------- drag & drop ----------
function attachDragListeners() {
  const cards = $$("#approvedList .card[draggable]");
  cards.forEach((card) => {
    card.addEventListener("dragstart", (e) => {
      state.dragId = card.dataset.id;
      card.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
    });
    card.addEventListener("dragend", () => {
      card.classList.remove("dragging");
      $$(".card.drag-over").forEach((c) => c.classList.remove("drag-over"));
      state.dragId = null;
    });
    card.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      card.classList.add("drag-over");
    });
    card.addEventListener("dragleave", () => {
      card.classList.remove("drag-over");
    });
    card.addEventListener("drop", (e) => {
      e.preventDefault();
      card.classList.remove("drag-over");
      if (!state.dragId || state.dragId === card.dataset.id) return;

      // Reorder in state
      const list = state.articles.filter(isApprovedToday);
      const fromIdx = list.findIndex((a) => a.id === state.dragId);
      const toIdx = list.findIndex((a) => a.id === card.dataset.id);
      if (fromIdx === -1 || toIdx === -1) return;

      // Swap rank_score values locally first, then persist both updates.
      const tempScore = list[fromIdx].rank_score;
      list[fromIdx].rank_score = list[toIdx].rank_score;
      list[toIdx].rank_score = tempScore;

      renderApproved();
      Promise.all([
        api("POST", cfg.review, {
          id: list[fromIdx].id,
          action: "reorder",
          reviewer: cfg.reviewer,
          rank_score: list[fromIdx].rank_score
        }),
        api("POST", cfg.review, {
          id: list[toIdx].id,
          action: "reorder",
          reviewer: cfg.reviewer,
          rank_score: list[toIdx].rank_score
        })
      ])
        .then(() => reload())
        .then(() => toast("Reordered."))
        .catch((err) => {
          toast(`Reorder failed: ${err.message}`);
          reload();
        });
      state.dragId = null;
    });
  });
}

// ---------- email preview ----------
function collectLiveSummaryOverrides() {
  const overrides = new Map();
  $$(".card[data-id] textarea[data-role=summary]").forEach((node) => {
    const card = node.closest(".card");
    const id = card?.dataset.id;
    if (id) overrides.set(id, node.value.trim());
  });
  return overrides;
}

function collectLiveHeadlineOverrides() {
  const overrides = new Map();
  $$(".card[data-id] input[data-role=headline]").forEach((node) => {
    const card = node.closest(".card");
    const id = card?.dataset.id;
    if (id) overrides.set(id, node.value.trim());
  });
  return overrides;
}

function generatePreviewHtml() {
  const liveHeadlines = collectLiveHeadlineOverrides();
  const liveSummaries = collectLiveSummaryOverrides();
  const approved = state.articles.filter(isApprovedToday);
  if (approved.length === 0) return "<p>No articles approved yet.</p>";

  const wrapped = approved.slice(0, DAILY_CAP);
  const previewBaseUrl =
    window.location.origin && window.location.origin !== "null"
      ? `${window.location.origin}/`
      : new URL(".", window.location.href).href;
  const previewBannerUrl = `${new URL("assets/email-banner.jpg", previewBaseUrl).href}?v=${Date.now()}`;
  const previewFooterLogoUrl = `${new URL("assets/footer-logo.png", previewBaseUrl).href}?v=${Date.now()}`;

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric"
  });
  const shareBase = (cfg.siteUrl || window.location.origin || "").replace(/\/+$/, "");
  const shareUrl = shareBase ? `${shareBase}/subscribe.html?utm_source=email&utm_medium=share&utm_campaign=subscribe` : "";
  const shareMessage = "Click here to subscribe to Shortly Daily Wrap:";
  const twitterUrl = shareUrl
    ? `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareMessage)}&url=${encodeURIComponent(shareUrl)}`
    : `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareMessage)}`;
  const linkedinUrl = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(shareUrl || window.location.href)}`;

  function renderItems(articles) {
    return articles.map((a, i) => {
      const headline = liveHeadlines.get(a.id) || (a.edited_title || a.title || "").trim();
      const text = liveSummaries.get(a.id) || (a.edited_summary || a.summary || "").trim();
      return `<tr><td style="padding:24px 0;${i < articles.length - 1 ? "border-bottom:1px solid #ede7f6;" : ""}">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
          <td style="width:40px;vertical-align:top;padding-top:6px">
            <div style="width:32px;height:32px;border-radius:50%;background:#7c3aed;color:#ffffff;font-size:14px;font-weight:700;text-align:center;line-height:32px">${i + 1}</div>
          </td>
          <td style="padding-left:14px">
            <h2 style="font-size:18px;line-height:1.35;margin:0 0 10px;color:#6d28d9;font-weight:700;font-family:'Roboto Serif',Georgia,'Times New Roman',serif">${esc(headline)}</h2>
            <p style="font-size:15px;line-height:1.7;color:#4a4a68;margin:0;font-family:Roboto,Arial,sans-serif">${esc(text)}</p>
          </td>
        </tr></table>
      </td></tr>`;
    }).join("");
  }

  function renderSection(title, subtitle, articles) {
    if (articles.length === 0) return "";
    return `<div style="margin-bottom:20px;border-radius:18px;overflow:hidden;background:#ffffff;border:1px solid #e8e0f5">
      <div style="padding:10px 28px 8px">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
          ${renderItems(articles)}
        </table>
      </div>
    </div>`;
  }

  // Calculate read time
  const allText = wrapped
    .map((a) => liveSummaries.get(a.id) || a.edited_summary || a.summary || "")
    .join(" ");
  const wordCount = allText.split(/\s+/).filter(Boolean).length;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><base href="${previewBaseUrl}"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;600;700;800&family=Roboto+Serif:wght@400;500;600;700;800&display=swap" rel="stylesheet"></head>
  <body style="margin:0;background:#f5f3ff;padding:0;font-family:Roboto,Arial,sans-serif;color:#2d0f57">
    <div style="max-width:640px;margin:0 auto">
      <img src="${previewBannerUrl}" alt="Shortly Daily Wrap" width="640" style="display:block;width:100%;max-width:640px;height:auto;border-radius:0 0 16px 16px">
      <div style="background:#ffffff;border-radius:18px;padding:28px 30px;margin:20px 0 20px;border:1px solid #e8e0f5;border-left:4px solid #7c3aed">
        <p style="margin:0 0 10px;color:#6d28d9;font-size:18px;line-height:1.45;font-weight:700;font-family:Roboto,Arial,sans-serif">Hi &lt;NAME&gt;,</p>
        <p style="margin:0;color:#6b6b8a;font-size:16px;line-height:1.65;font-weight:400;font-family:Roboto,Arial,sans-serif">
          Here are 10 things that deserve your attention. The biggest stories, minus the noise. Grab your coffee &mdash; you'll be caught up SHORTLY!
        </p>
      </div>
      ${renderSection("Shortly Wrapped", `${wrapped.length} stories to catch up on`, wrapped)}
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-top:4px;margin-bottom:20px">
        <tr><td style="text-align:center;padding:10px 20px 14px">
          <img src="${previewFooterLogoUrl}" alt="Shortly" style="display:block;width:96px;max-width:100%;height:auto;margin:0 auto 8px">
          <p style="margin:0 0 10px;color:#9a9ab0;font-size:12px;line-height:1.5;font-family:Roboto,Arial,sans-serif">
            Curated news, summarized daily.<br>
            You're receiving this because you subscribed to Shortly.
          </p>
            <p style="margin:0;font-size:12px;color:#9a9ab0;font-family:Roboto,Arial,sans-serif">
              <a href="${twitterUrl}" target="_blank" rel="noreferrer" style="color:#7c3aed;text-decoration:underline;font-family:Roboto,Arial,sans-serif">Share on X</a> &nbsp;|&nbsp;
              <a href="${linkedinUrl}" target="_blank" rel="noreferrer" style="color:#7c3aed;text-decoration:underline;font-family:Roboto,Arial,sans-serif">LinkedIn</a>
            </p>
          </td></tr>
        </table>
    </div>
  </body></html>`;
}

function showPreview() {
  const html = generatePreviewHtml();
  const iframe = $("#previewFrame");
  const doc = iframe.contentDocument || iframe.contentWindow.document;
  doc.open();
  doc.write(html);
  doc.close();
  $("#previewModal").classList.add("show");
}

// ---------- dark mode ----------
function initTheme() {
  const saved = localStorage.getItem("shortly-theme");
  if (saved === "dark") {
    document.documentElement.setAttribute("data-theme", "dark");
    updateThemeButton(true);
  }
}

function toggleTheme() {
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  if (isDark) {
    document.documentElement.removeAttribute("data-theme");
    localStorage.setItem("shortly-theme", "light");
  } else {
    document.documentElement.setAttribute("data-theme", "dark");
    localStorage.setItem("shortly-theme", "dark");
  }
  updateThemeButton(!isDark);
}


// ---------- section nav ----------
function updateThemeButton(isDark) {
  $("#themeIcon").textContent = isDark ? "\u2600" : "\u263E";
  $("#themeLabel").textContent = isDark ? "Light mode" : "Dark mode";
}

function showSection(name) {
  state.section = name;
  $$(".section").forEach((s) => s.classList.toggle("active", s.dataset.section === name));
  $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.section === name));
  refreshChrome();
}

// ---------- mobile menu ----------
function closeMenu() {
  $("#sidebar")?.classList.remove("open");
  $("#backdrop")?.classList.remove("show");
}
function openMenu() {
  $("#sidebar")?.classList.add("open");
  $("#backdrop")?.classList.add("show");
}

// ---------- wire up ----------
initTheme();

$("#menuToggle")?.addEventListener("click", () => {
  $("#sidebar").classList.contains("open") ? closeMenu() : openMenu();
});
$("#backdrop")?.addEventListener("click", closeMenu);

$$(".nav-item").forEach((btn) =>
  btn.addEventListener("click", () => {
    showSection(btn.dataset.section);
    closeMenu();
  })
);

// Theme toggle
$("#themeToggle").addEventListener("click", toggleTheme);

// Search & filter
$("#searchArticles").addEventListener("input", (e) => {
  state.search = e.target.value;
  renderReview();
});
$("#filterTopic").addEventListener("change", (e) => {
  state.filterTopic = e.target.value;
  renderReview();
});
$("#filterSection").addEventListener("change", (e) => {
  state.filterSection = e.target.value;
  renderReview();
});

// Bulk actions
$("#bulkApprove").addEventListener("click", () => bulkAction("approve"));
$("#bulkReject").addEventListener("click", () => bulkAction("reject"));
$("#bulkClear").addEventListener("click", () => {
  state.selected.clear();
  renderReview();
  updateBulkBar();
});

// Article action delegation (+ checkbox handling)
["#reviewList", "#approvedList", "#rejectedList"].forEach((sel) => {
  $(sel).addEventListener("click", (e) => {
    // Handle checkbox
    const check = e.target.closest(".card-check");
    if (check) {
      const id = check.dataset.id;
      if (check.checked) state.selected.add(id);
      else state.selected.delete(id);
      check.closest(".card")?.classList.toggle("selected", check.checked);
      updateBulkBar();
      return;
    }
    // Handle action button
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const card = btn.closest(".card");
    handleArticleAction(card, btn.dataset.action);
  });
});

// Subscriber actions
$("#subRows").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  handleSubscriberAction(btn.closest("tr"), btn.dataset.action);
});

$("#subRows").addEventListener("change", (e) => {
  const check = e.target.closest(".sub-check");
  if (!check) return;
  if (check.checked) state.selectedSubscribers.add(check.dataset.id);
  else state.selectedSubscribers.delete(check.dataset.id);
  refreshChrome();
  renderSubscribers();
});

$("#subSelectAll").addEventListener("change", (e) => {
  const checked = e.target.checked;
  state.subscribers
    .filter((s) => s.status === "subscribed")
    .forEach((s) => {
      if (checked) state.selectedSubscribers.add(s.id);
      else state.selectedSubscribers.delete(s.id);
    });
  refreshChrome();
  renderSubscribers();
});

$("#clearRecipientSelection").addEventListener("click", () => {
  state.selectedSubscribers.clear();
  refreshChrome();
  renderSubscribers();
});

// Add subscriber form
$("#subForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#subEmail").value.trim();
  const full_name = $("#subName").value.trim();
  if (!email) return;
  try {
    await api("POST", cfg.subscribers, { action: "add", email, full_name });
    $("#subEmail").value = "";
    $("#subName").value = "";
    await reload();
    toast("Subscriber added.");
  } catch (e) {
    toast(`Failed: ${e.message}`);
  }
});

// Fetch Today button — scrape + summarize in one click
$("#fetchToday").addEventListener("click", async () => {
  const btn = $("#fetchToday");
  const btnText = $("#fetchBtnText");
  const resultBox = $("#fetchResult");
  btn.disabled = true;
  resultBox.classList.add("hidden");

  try {
    // Step 1: Scrape RSS feeds
    btnText.innerHTML = `<span class="spinner"></span> Scraping feeds...`;
    const scrapeRes = await api("POST", cfg.scrape, {});
    const scrapeInfo = `Scraped ${scrapeRes.scraped ?? 0} articles, ${scrapeRes.inserted ?? 0} new.`;

    // Step 2: Summarize with GPT-4o
    btnText.innerHTML = `<span class="spinner"></span> Summarizing...`;
    const sumRes = await api("POST", cfg.summarize, {});
    const sumInfo = `Summarized ${sumRes.summarized ?? 0}, Top 50: ${sumRes.top_50 ?? 0}, Failed: ${sumRes.failed ?? 0}`;

    // Step 3: Second summarize pass for rate-limited articles
    if (sumRes.failed > 0) {
      btnText.innerHTML = `<span class="spinner"></span> Retry (${sumRes.failed} remaining)...`;
      const retryRes = await api("POST", cfg.summarize, {});
      const retryInfo = `Retry: ${retryRes.summarized ?? 0} more summarized.`;
      resultBox.textContent = `${scrapeInfo}\n${sumInfo}\n${retryInfo}`;
    } else {
      resultBox.textContent = `${scrapeInfo}\n${sumInfo}`;
    }

    resultBox.classList.remove("hidden");
    await reload();
    showSection("review");
    toast(`Done! ${sumRes.summarized ?? 0} articles ready for review.`);
  } catch (e) {
    toast(`Failed: ${e.message}`);
    resultBox.textContent = `Error: ${e.message}`;
    resultBox.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btnText.textContent = "Fetch & Summarize";
  }
});

// Scraper form
$("#scrapeForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = {
    title: $("#scTitle").value.trim(),
    url: $("#scUrl").value.trim(),
    source: $("#scSource").value.trim() || "Shortly",
    topic: $("#scTopic").value.trim(),
    raw_content: $("#scRaw").value.trim()
  };
  toast("Summarizing...");
  try {
    const res = await api("POST", cfg.submit, payload);
    const out = $("#scraperResult");
    out.textContent = JSON.stringify(res, null, 2);
    out.classList.remove("hidden");
    $("#scrapeForm").reset();
    await reload();
    toast("Article queued for review.");
  } catch (e) {
    toast(`Failed: ${e.message}`);
  }
});

// Preview button
$("#previewDigest").addEventListener("click", showPreview);
$("#closePreview").addEventListener("click", () => {
  $("#previewModal").classList.remove("show");
});
$("#previewModal").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) $("#previewModal").classList.remove("show");
});

// Send digest
$("#sendDigest").addEventListener("click", async () => {
  const approved = approvedTodayCount();
  const selectedIds = [...state.selectedSubscribers];
  const subCount = selectedIds.length || state.subscribers.filter((s) => s.status === "subscribed").length;
  const fallbackMsg = approved < DAILY_CAP
    ? `\n\nOnly ${approved}/${DAILY_CAP} approved — the rest will be auto-selected by rank.`
    : "";
  if (!confirm(`Send digest to ${subCount} subscribers?${fallbackMsg}`)) return;
  try {
    const res = await api("POST", cfg.digest, selectedIds.length ? { subscriber_ids: selectedIds } : {});
    const autoMsg = res.autoSelected ? " (with auto-selected articles)" : "";
    state.selectedSubscribers.clear();
    toast(`Sent to ${res.sent ?? 0} subscribers${autoMsg}.`);
    await reload();
    showSection("review");
  } catch (e) {
    toast(`Failed: ${e.message}`);
  }
});

// Keyboard shortcut: Escape closes modal
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    $("#previewModal").classList.remove("show");
  }
});

// Initial load
reload();
