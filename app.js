// Shortly dashboard — review, approve, manage subscribers, send digest.

const cfg = window.SHORTLY;
const DAILY_CAP = cfg.dailyCap ?? 10;
const AGENT_TOKEN_KEY = "shortly-agent-shared-token";
let dashboardBooted = false;

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
  const container = $("#toastContainer");
  if (!container) return;
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  container.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => t.remove(), 220);
  }, 2800);
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

function ensureAuthGate() {
  let gate = $("#authGate");
  if (gate) return gate;

  gate = document.createElement("div");
  gate.id = "authGate";
  gate.style.cssText = [
    "position:fixed",
    "inset:0",
    "z-index:9999",
    "display:flex",
    "align-items:center",
    "justify-content:center",
    "padding:24px",
    "background:rgba(252,251,247,0.96)"
  ].join(";");
  gate.innerHTML = `
    <div style="max-width:520px;width:100%;background:#ffffff;border:2px solid #111111;border-radius:16px;padding:28px 26px;box-shadow:0 18px 48px rgba(0,0,0,0.08);font-family:Inter,Arial,sans-serif">
      <p id="authGateTitle" style="margin:0 0 10px;font-size:24px;line-height:1.2;font-weight:800;color:#191919">Email Agent Login Required</p>
      <p id="authGateText" style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#2f2f39">Open this dashboard from Shortly Agents to continue.</p>
      <a id="authGateLink" href="${esc(cfg.agentAppUrl || "https://shortlyagents.vercel.app")}" style="display:inline-block;background:#6d28d9;color:#ffffff;text-decoration:none;font-weight:700;border-radius:10px;padding:11px 16px">Open Shortly Agents</a>
    </div>`;
  document.body.appendChild(gate);
  return gate;
}

function setAuthGate(message, busy = false) {
  const gate = ensureAuthGate();
  $("#authGateText").textContent = message;
  const link = $("#authGateLink");
  link.style.display = busy ? "none" : "";
  gate.style.display = "flex";
}

function unlockDashboardUi() {
  ensureAuthGate().style.display = "none";
  $(".app").style.display = "";
}

async function verifyAgentToken(token) {
  if (!cfg.verifyToken) throw new Error("Missing verifyToken endpoint");
  return api("POST", cfg.verifyToken, { token });
}

async function unlockWithToken(token) {
  setAuthGate("Verifying access token...", true);
  await verifyAgentToken(token);
  localStorage.setItem(AGENT_TOKEN_KEY, token);
  unlockDashboardUi();
  if (!dashboardBooted) {
    dashboardBooted = true;
    await reload();
  }
}

function listenForSharedToken() {
  window.addEventListener("message", async (event) => {
    const allowedOrigin = cfg.agentAppUrl ? new URL(cfg.agentAppUrl).origin : null;
    if (allowedOrigin && event.origin !== allowedOrigin) return;
    const token = event.data?.token;
    if (event.data?.type !== "shortly-agent-token" || typeof token !== "string" || !token.trim()) return;
    try {
      await unlockWithToken(token.trim());
    } catch (error) {
      setAuthGate(error instanceof Error ? error.message : "Invalid token.", false);
    }
  });
}

async function bootAuth() {
  $(".app").style.display = "none";
  ensureAuthGate();
  listenForSharedToken();

  const url = new URL(window.location.href);
  const tokenFromUrl = url.searchParams.get("token") || url.searchParams.get("shared_token");
  const storedToken = localStorage.getItem(AGENT_TOKEN_KEY);
  const token = tokenFromUrl || storedToken;

  if (!token) {
    unlockDashboardUi();
    if (!dashboardBooted) {
      dashboardBooted = true;
      await reload();
    }
    return;
  }

  try {
    await unlockWithToken(token);
    if (tokenFromUrl) {
      url.searchParams.delete("token");
      url.searchParams.delete("shared_token");
      window.history.replaceState({}, "", url.toString());
    }
  } catch (error) {
    localStorage.removeItem(AGENT_TOKEN_KEY);
    unlockDashboardUi();
    if (!dashboardBooted) {
      dashboardBooted = true;
      await reload();
    }
    toast(error instanceof Error ? error.message : "Invalid shared token. Opened dashboard normally.");
  }
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

  const canSelect = mode === "review" || mode === "approved";
  const checkbox = canSelect ? `<input type="checkbox" class="card-check" data-id="${a.id}" ${checked}>` : "";

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
        <td>${esc(s.phone_number || "")}</td>
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
  $("#subRows").innerHTML = rows || `<tr><td colspan="6" class="muted" style="padding:18px">No subscribers yet.</td></tr>`;
  const selectAll = $("#subSelectAll");
  if (selectAll) {
    selectAll.checked = allChecked;
    selectAll.indeterminate = !allChecked && selectedSubscriberCount() > 0;
  }
  updateSubscriberSelectionUi();
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === "\"") {
      if (inQuotes && line[i + 1] === "\"") {
        current += "\"";
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === "," && !inQuotes) {
      values.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  values.push(current.trim());
  return values;
}

function parseSubscriberCsv(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];
  const normalizeHeader = (header) => header.toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s+/g, "_");
  const headers = parseCsvLine(lines[0]).map((header) => normalizeHeader(header));
  const emailIndex = headers.findIndex((header) => ["email", "e-mail"].includes(header));
  const nameIndex = headers.findIndex((header) => ["name", "full_name", "full_name_(optional)", "full_name_optional"].includes(header));
  const phoneIndex = headers.findIndex((header) => ["phone", "phone_number", "phone_no", "mobileno", "mobile", "mobile_number"].includes(header));
  if (emailIndex === -1) return [];
  return lines
    .slice(1)
    .map((line) => {
      const cols = parseCsvLine(line);
      return {
        email: cols[emailIndex] || "",
        full_name: nameIndex >= 0 ? cols[nameIndex] || "" : "",
        phone_number: phoneIndex >= 0 ? cols[phoneIndex] || "" : ""
      };
    })
    .filter((row) => row.email);
}

async function parseSubscriberFile(file) {
  const normalizeHeader = (header) => String(header).toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s+/g, "_");
  const name = file.name.toLowerCase();
  if (name.endsWith(".csv")) {
    return parseSubscriberCsv(await file.text());
  }

  if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
    if (!window.XLSX) {
      throw new Error("Excel reader failed to load. Refresh and try again.");
    }
    const buffer = await file.arrayBuffer();
    const workbook = window.XLSX.read(buffer, { type: "array" });
    const firstSheet = workbook.SheetNames[0];
    if (!firstSheet) return [];
    const rows = window.XLSX.utils.sheet_to_json(workbook.Sheets[firstSheet], { defval: "" });
    return rows
      .map((row) => {
        const normalized = Object.fromEntries(
          Object.entries(row).map(([key, value]) => [
            normalizeHeader(key),
            String(value ?? "").trim()
          ])
        );
        return {
          email: normalized.email || normalized["e-mail"] || "",
          full_name: normalized.name || normalized.full_name || "",
          phone_number: normalized.phone || normalized.phone_number || normalized.phone_no || normalized.mobileno || normalized.mobile || normalized.mobile_number || ""
        };
      })
      .filter((row) => row.email);
  }

  throw new Error("Unsupported file type. Use CSV, XLSX, or XLS.");
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
  const selectedReviewCards = [...document.querySelectorAll("#reviewList .card-check:checked")];
  const count = selectedReviewCards.length;
  if (count > 0) {
    bar.classList.add("show");
    $("#bulkCount").textContent = `${count} selected`;
  } else {
    bar.classList.remove("show");
  }
}

async function bulkAction(action) {
  const ids = [...document.querySelectorAll("#reviewList .card-check:checked")]
    .map((check) => check.dataset.id)
    .filter(Boolean);
  if (ids.length === 0) return;
  toast(`Processing ${ids.length} articles...`);
  try {
    const payloads = ids.map((id) => {
      const card = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
      return {
        id,
        action,
        reviewer: cfg.reviewer,
        edited_title: card?.querySelector('[data-role="headline"]')?.value || undefined,
        edited_summary: card?.querySelector('[data-role="summary"]')?.value || undefined,
        section: card?.querySelector('[data-role="section"]')?.value || undefined
      };
    });
    const results = await Promise.allSettled(
      payloads.map((body) => api("POST", cfg.review, body))
    );
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.length - succeeded;
    if (succeeded > 0) {
      payloads.forEach(({ id }) => state.selected.delete(id));
      await reload();
    }
    if (failed > 0) {
      const firstError = results.find((r) => r.status === "rejected");
      toast(`${succeeded} article${succeeded === 1 ? "" : "s"} ${action}d, ${failed} failed${firstError ? `: ${firstError.reason.message}` : "."}`);
      return;
    }
    toast(`${succeeded} article${succeeded === 1 ? "" : "s"} ${action}d.`);
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
  const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(`${shareMessage} ${shareUrl}`.trim())}`;
  const xIcon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M18.901 2H21.98l-6.73 7.693L23.167 22h-6.197l-4.85-7.356L5.68 22H2.6l7.2-8.23L1.5 2h6.355l4.384 6.689L18.901 2Zm-1.087 18.145h1.706L6.93 3.759H5.1l12.714 16.386Z" fill="#6d28d9"/></svg>`;
  const linkedinIcon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6.94 8.5H3.56V20h3.38V8.5Zm.22-3.56C7.15 3.77 6.3 3 5.26 3S3.38 3.77 3.38 4.94s.83 1.94 1.85 1.94h.03c1.06 0 1.9-.77 1.9-1.94ZM20.62 12.65c0-3.46-1.85-5.07-4.32-5.07-1.99 0-2.88 1.1-3.37 1.87V8.5H9.55c.04.63 0 11.5 0 11.5h3.38v-6.42c0-.34.02-.68.12-.92.27-.68.88-1.39 1.9-1.39 1.34 0 1.88 1.02 1.88 2.52V20H20.2v-6.35Z" fill="#6d28d9"/></svg>`;
  const whatsappIcon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20.52 3.48A11.86 11.86 0 0 0 12.07 0C5.51 0 .18 5.33.18 11.88c0 2.1.55 4.16 1.58 5.97L0 24l6.33-1.66a11.86 11.86 0 0 0 5.74 1.47h.01c6.55 0 11.88-5.33 11.88-11.88 0-3.17-1.24-6.14-3.44-8.45Zm-8.45 18.3h-.01a9.94 9.94 0 0 1-5.07-1.39l-.36-.21-3.76.99 1-3.66-.23-.37a9.9 9.9 0 0 1-1.53-5.26c0-5.47 4.45-9.92 9.93-9.92 2.65 0 5.14 1.03 7.01 2.9a9.85 9.85 0 0 1 2.9 7.02c0 5.47-4.45 9.92-9.91 9.92Zm5.44-7.42c-.3-.15-1.8-.89-2.08-.99-.28-.1-.48-.15-.69.15-.2.3-.79.99-.96 1.19-.18.2-.35.23-.65.08-.3-.15-1.27-.47-2.42-1.5a9 9 0 0 1-1.67-2.07c-.18-.3-.02-.46.13-.61.13-.13.3-.35.45-.53.15-.18.2-.3.3-.5.1-.2.05-.38-.02-.53-.08-.15-.69-1.66-.94-2.28-.25-.6-.5-.52-.69-.53h-.58c-.2 0-.53.08-.81.38-.28.3-1.06 1.03-1.06 2.5s1.09 2.89 1.24 3.1c.15.2 2.14 3.26 5.18 4.57.72.31 1.29.5 1.73.64.73.23 1.39.2 1.92.12.59-.09 1.8-.74 2.05-1.45.25-.71.25-1.32.17-1.45-.08-.13-.28-.2-.58-.35Z" fill="#6d28d9"/></svg>`;

  function renderItems(articles) {
    return articles.map((a, i) => {
      const headline = liveHeadlines.get(a.id) || (a.edited_title || a.title || "").trim();
      const text = liveSummaries.get(a.id) || (a.edited_summary || a.summary || "").trim();
      return `<tr><td style="padding:0 0 16px">
        <div style="background:#ffffff;border:3px solid #111111;border-radius:12px;padding:18px 18px 18px 16px">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
            <td style="width:44px;vertical-align:top;padding-top:2px">
              <div style="width:36px;height:36px;border-radius:50%;background:#efe7ff;color:#6d28d9;border:2px solid #6d28d9;font-size:15px;font-weight:700;text-align:center;line-height:32px">${i + 1}</div>
            </td>
            <td style="padding-left:14px">
              <h2 style="font-size:18px;line-height:1.28;margin:0 0 10px;color:#191919;font-weight:700;font-family:'Roboto Serif',Georgia,'Times New Roman',serif">${esc(headline)}</h2>
              <p style="font-size:15px;line-height:1.72;color:#2f2f39;margin:0;font-family:Roboto,Arial,sans-serif">${esc(text)}</p>
            </td>
          </tr></table>
        </div>
      </td></tr>`;
    }).join("");
  }

  function renderLabelBar(text, bg) {
    return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 18px;padding:0 10px"><tr>
      <td style="width:220px">
        <div style="background:${bg};color:#ffffff;border:3px solid #111111;font-size:14px;font-weight:800;letter-spacing:0.02em;text-transform:uppercase;text-align:center;padding:4px 12px;font-family:Roboto,Arial,sans-serif">${text}</div>
      </td>
      <td style="border-bottom:3px solid #111111">&nbsp;</td>
    </tr></table>`;
  }

  function renderSection(title, subtitle, articles) {
    if (articles.length === 0) return "";
    return `${renderLabelBar("Quick Hits. Daily Wrap", "#6d28d9")}<div style="margin-bottom:22px;border-radius:22px;background:transparent">
      <div style="padding:0">
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
  <body style="margin:0;background:#fcfbf7;padding:0;font-family:Roboto,Arial,sans-serif;color:#191919">
    <div style="max-width:640px;margin:0 auto">
      <img src="${previewBannerUrl}" alt="Shortly Daily Wrap" width="640" style="display:block;width:100%;max-width:640px;height:auto;border-radius:0 0 16px 16px">
      ${renderLabelBar("From the Shortly Team", "#0f9d69")}
      <div style="background:#ffffff;border-radius:12px;padding:26px 28px;margin:0 0 24px;border:3px solid #111111">
        <p style="margin:0 0 12px;color:#191919;font-size:18px;line-height:1.3;font-weight:700;font-family:'Roboto Serif',Georgia,'Times New Roman',serif">Hi &lt;NAME&gt;,</p>
        <p style="margin:0;color:#2f2f39;font-size:16px;line-height:1.7;font-weight:400;font-family:Roboto,Arial,sans-serif">
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
            <p style="margin:0 0 8px;font-size:12px;color:#9a9ab0;font-family:Roboto,Arial,sans-serif">Can be forwarded to others.</p>
            <div style="text-align:center">
              <a href="${twitterUrl}" target="_blank" rel="noreferrer" style="display:inline-block;margin:0 6px;text-decoration:none;vertical-align:middle">${xIcon}</a>
              <a href="${linkedinUrl}" target="_blank" rel="noreferrer" style="display:inline-block;margin:0 6px;text-decoration:none;vertical-align:middle">${linkedinIcon}</a>
              <a href="${whatsappUrl}" target="_blank" rel="noreferrer" style="display:inline-block;margin:0 6px;text-decoration:none;vertical-align:middle">${whatsappIcon}</a>
            </div>
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
  const phone_number = $("#subPhone").value.trim();
  if (!email) return;
  try {
    await api("POST", cfg.subscribers, { action: "add", email, full_name, phone_number });
    $("#subEmail").value = "";
    $("#subName").value = "";
    $("#subPhone").value = "";
    await reload();
    toast("Subscriber added.");
  } catch (e) {
    toast(`Failed: ${e.message}`);
  }
});

$("#importCsvBtn").addEventListener("click", async () => {
  const file = $("#subCsvFile").files?.[0];
  if (!file) {
    toast("Choose a CSV, XLSX, or XLS file first.");
    return;
  }
  try {
    const subscribers = await parseSubscriberFile(file);
    if (!subscribers.length) {
      toast("No valid rows found.");
      return;
    }
    const res = await api("POST", cfg.subscribers, { action: "import", subscribers });
    $("#subCsvFile").value = "";
    await reload();
    toast(`Imported ${res.imported ?? subscribers.length} subscribers.`);
  } catch (e) {
    toast(`Import failed: ${e.message}`);
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

$("#buildCorporateCase").addEventListener("click", async () => {
  const btn = $("#buildCorporateCase");
  const btnText = $("#corporateCaseBtnText");
  const resultBox = $("#corporateCaseResult");
  btn.disabled = true;
  btnText.textContent = "Researching...";
  resultBox.classList.add("hidden");
  try {
    if (!cfg.corporateCase) throw new Error("Missing corporate case endpoint");
    const response = await api("POST", cfg.corporateCase, {});
    const item = response.case;
    const checklist = (item.editor_checklist || []).map((entry) => "- " + entry).join("\n");
    const inferences = (item.inference_notes || []).map((entry) => "- " + entry).join("\n") || "- None flagged";
    resultBox.textContent = [
      item.headline,
      item.source + " | " + item.source_url,
      "Company: " + (item.company || "Not identified") + " | Type: " + item.case_type,
      "",
      "SUMMARY",
      item.summary,
      "",
      "DETAIL",
      item.detail,
      "",
      "COMPARISON / ANALOGY",
      item.comparison_or_analogy || "Not provided",
      "",
      "BULL CASE",
      item.bull_case || "Not provided",
      "",
      "BEAR CASE",
      item.bear_case || "Not provided",
      "",
      "OPEN QUESTION",
      item.open_question || "Not provided",
      "",
      "INFERENCES TO VERIFY",
      inferences,
      "",
      "EDITOR CHECKLIST",
      checklist,
      "",
      "Scanned " + (response.scanned || 0) + " candidates."
    ].join("\n");
    resultBox.classList.remove("hidden");
    toast("Corporate case draft created.");
  } catch (e) {
    resultBox.textContent = "Error: " + e.message;
    resultBox.classList.remove("hidden");
    toast("Failed: " + e.message);
  } finally {
    btn.disabled = false;
    btnText.textContent = "Build case study";
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
  const selectedIds = [...state.selectedSubscribers];
  const approvedArticles = state.articles.filter(isApprovedToday);
  const selectedArticleIds = approvedArticles
    .filter((article) => state.selected.has(article.id))
    .map((article) => article.id);
  const subCount = selectedIds.length || state.subscribers.filter((s) => s.status === "subscribed").length;
  const sendMsg = selectedArticleIds.length
    ? `\n\nSending ${selectedArticleIds.length} selected article${selectedArticleIds.length === 1 ? "" : "s"} first, then filling the remaining slots.`
    : `\n\nNo articles selected, so the digest will use approved articles and fill remaining slots automatically.`;
  if (!confirm(`Send digest to ${subCount} subscribers?${sendMsg}`)) return;
  try {
    const res = await api("POST", cfg.digest, {
      manual: true,
      ...(selectedArticleIds.length ? { article_ids: selectedArticleIds } : {}),
      ...(selectedIds.length ? { subscriber_ids: selectedIds } : {})
    });
    const autoMsg = res.autoSelected ? " (with auto-selected articles)" : "";
    state.selectedSubscribers.clear();
    state.selected.clear();
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
bootAuth();
