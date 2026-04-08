const statsGrid = document.getElementById("statsGrid");
const eventList = document.getElementById("eventList");
const payloadPreview = document.getElementById("payloadPreview");
const typeFilter = document.getElementById("typeFilter");
const sourceFilter = document.getElementById("sourceFilter");
const refreshBtn = document.getElementById("refreshBtn");
const lastRefresh = document.getElementById("lastRefresh");
const eventsAccepted = document.getElementById("eventsAccepted");
const serverStatus = document.getElementById("serverStatus");

let activeEventId = null;
let useCases = {};
let sources = [];

function niceDate(iso) {
  return new Date(iso).toLocaleString();
}

function renderStats(stats) {
  const cards = [{ key: "total", label: "Total Events", value: stats.total }];

  for (const [key, label] of Object.entries(stats.labels)) {
    cards.push({ key, label, value: stats.byUseCase[key] || 0 });
  }

  const sourceCards = Object.entries(stats.bySource || {}).map(([source, value]) => ({
    key: `source-${source}`,
    label: `Source: ${source}`,
    value
  }));

  statsGrid.innerHTML = [...cards, ...sourceCards]
    .map(
      (item) => `
      <article class="card stat-card">
        <h3>${item.label}</h3>
        <p>${item.value}</p>
      </article>
    `
    )
    .join("");

  eventsAccepted.textContent = `Events accepted: ${stats.total}`;
}

function renderFilters() {
  const selectedType = typeFilter.value;
  const selectedSource = sourceFilter.value;

  typeFilter.innerHTML = [
    `<option value="">All use cases</option>`,
    ...Object.entries(useCases).map(([key, label]) => `<option value="${key}">${label}</option>`)
  ].join("");

  sourceFilter.innerHTML = [
    `<option value="">All sources</option>`,
    ...sources.map((source) => `<option value="${source}">${source}</option>`)
  ].join("");

  typeFilter.value = selectedType;
  sourceFilter.value = selectedSource;
}

function renderEvents(events) {
  if (!events.length) {
    eventList.innerHTML = `<div class="event-item"><h4>No events yet</h4><div class="event-meta">Waiting for Meta callback data...</div></div>`;
    payloadPreview.textContent = "No payload selected.";
    return;
  }

  if (!activeEventId || !events.find((event) => event.id === activeEventId)) {
    activeEventId = events[0].id;
  }

  eventList.innerHTML = events
    .map((event) => {
      const activeClass = event.id === activeEventId ? "active" : "";
      return `
      <article class="event-item ${activeClass}" data-id="${event.id}">
        <h4>${event.useCaseLabel}</h4>
        <div class="event-meta">
          <span>Source: ${event.sourceObject}</span>
          <span>Field: ${event.field || "n/a"}</span>
          <span>${niceDate(event.receivedAt)}</span>
        </div>
      </article>
    `;
    })
    .join("");

  const current = events.find((event) => event.id === activeEventId) || events[0];
  payloadPreview.textContent = JSON.stringify(current.payload, null, 2);

  for (const item of eventList.querySelectorAll(".event-item")) {
    item.addEventListener("click", () => {
      activeEventId = item.dataset.id;
      renderEvents(events);
    });
  }
}

async function refresh() {
  try {
    const [healthRes, statsRes] = await Promise.all([fetch("/health"), fetch("/api/stats")]);

    if (!healthRes.ok || !statsRes.ok) {
      throw new Error("Could not load dashboard data");
    }

    const stats = await statsRes.json();
    useCases = stats.labels || {};
    renderStats(stats);

    const query = new URLSearchParams({ limit: "100" });
    if (typeFilter.value) query.set("type", typeFilter.value);
    if (sourceFilter.value) query.set("source", sourceFilter.value);

    const eventsRes = await fetch(`/api/events?${query.toString()}`);
    const eventsPayload = await eventsRes.json();

    sources = eventsPayload.sources || [];
    renderFilters();
    renderEvents(eventsPayload.events || []);

    serverStatus.textContent = "Server connected";
    serverStatus.style.background = "rgba(59, 215, 183, .15)";
    serverStatus.style.borderColor = "rgba(59, 215, 183, .5)";
    lastRefresh.textContent = `Last refresh: ${niceDate(new Date().toISOString())}`;
  } catch (error) {
    serverStatus.textContent = "Server unavailable";
    serverStatus.style.background = "rgba(255, 96, 96, .16)";
    serverStatus.style.borderColor = "rgba(255, 96, 96, .45)";
    payloadPreview.textContent = `Error: ${error.message}`;
  }
}

refreshBtn.addEventListener("click", refresh);
typeFilter.addEventListener("change", refresh);
sourceFilter.addEventListener("change", refresh);

refresh();
setInterval(refresh, 15000);
