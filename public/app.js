const form = document.getElementById("trip-form");
const itinerarySection = document.getElementById("itinerary");
const messagesSection = document.getElementById("messages");
const activitySection = document.getElementById("activity");
const activityList = document.getElementById("activity-list");
const progressSection = document.getElementById("progress");
const stageSummariesSection = document.getElementById("stage-summaries");
const stageSummariesList = document.getElementById("stage-summaries-list");
const toolMonitorSection = document.getElementById("tool-monitor");
const toolMonitorList = document.getElementById("tool-monitor-list");
const startDateInput = form?.querySelector('input[name="startDate"]');
const endDateInput = form?.querySelector('input[name="endDate"]');
const tripLengthInput = form?.querySelector('input[name="tripLengthDays"]');
const TOOL_MONITOR_TYPES = new Set([
  "tool_call_started",
  "tool_call_completed",
  "web_search_called",
  "web_search_output",
  "tool_called",
  "tool_output"
]);

let currentPlan = null;
const activityGroups = new Map();
const activityGroupMeta = new Map();
let activeAgentKey = null;
let activeAgentStartTime = null;
let activeAgentTimer = null;
let itineraryMap = null;
let itineraryMapLayer = null;
let mapRenderToken = 0;
const geocodeCache = new Map();
const toolSummaryGroups = new Map();
const STAGE_FLOW = ["initialization", "research", "safety", "composition", "done"];
const STAGE_LABELS = {
  initialization: "Initialization",
  research: "Research",
  safety: "Safety",
  composition: "Composition",
  done: "Done"
};
const stageState = {
  active: null,
  completed: new Set()
};
const stageSummariesByStage = new Map();

if (tripLengthInput) {
  tripLengthInput.readOnly = true;
}

startDateInput?.addEventListener("change", syncTripLengthFromDates);
endDateInput?.addEventListener("change", syncTripLengthFromDates);
syncTripLengthFromDates();

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const payload = formToPayload(new FormData(form));
  if (!payload.activities.length) {
    setMessage("Enter at least one activity category.", true);
    return;
  }
  const submitButton = form.querySelector("button[type='submit']");
  submitButton.disabled = true;
  resetTimeline();
  itinerarySection.classList.add("hidden");
  setMessage("Generating itinerary with agents...");

  try {
    const data = await streamPlan(payload);

    currentPlan = {
      ...data,
      requestedActivityCategories: payload.activities,
      activitySelections: {},
      activityConfirmed: false,
      confirmedActivities: []
    };
    setMessage("Draft itinerary created. Please confirm each component.");
    renderItinerary(currentPlan);
  } catch (error) {
    setMessage(error.message || "Unexpected error", true);
  } finally {
    submitButton.disabled = false;
  }
});

async function streamPlan(payload) {
  const response = await fetch("/api/plan-stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const data = await safeJson(response);
    throw new Error(apiErrorMessage(data, "Failed to generate itinerary"));
  }

  if (!response.body) {
    throw new Error("Streaming response body is unavailable.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let finalResult = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    pending += decoder.decode(value, { stream: true });
    const chunks = pending.split("\n\n");
    pending = chunks.pop() || "";

    for (const chunk of chunks) {
      const event = parseSseChunk(chunk);
      if (!event) continue;

      if (event.name === "activity") {
        addActivity(event.data);
      }

      if (event.name === "result") {
        finalResult = event.data;
      }

      if (event.name === "done") {
        updateStageProgress({ type: "stage_completed", stage: "done" });
      }

      if (event.name === "error") {
        throw new Error(apiErrorMessage(event.data, "Failed to generate itinerary"));
      }
    }
  }

  if (!finalResult) {
    throw new Error("Planning stream ended without itinerary result.");
  }

  return finalResult;
}

function parseSseChunk(chunk) {
  const lines = chunk
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) return null;

  let name = "message";
  const dataLines = [];

  for (const line of lines) {
    if (line.startsWith("event:")) {
      name = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }

  const raw = dataLines.join("\n");
  let data = raw;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = { message: raw };
  }

  return { name, data };
}

// ── Live-agent badge helpers ─────────────────────────────────────
function setActiveAgentBadge(agentKey) {
  clearActiveAgentBadge();
  activeAgentKey = agentKey;
  activeAgentStartTime = Date.now();
  // If the group already exists, show badge immediately
  _activateBadgeNode(agentKey);
  // Tick every second to update elapsed time
  activeAgentTimer = setInterval(() => {
    if (!activeAgentKey || !activeAgentStartTime) return;
    const meta = activityGroupMeta.get(activeAgentKey);
    if (!meta?.liveElapsed) return;
    const secs = Math.floor((Date.now() - activeAgentStartTime) / 1000);
    meta.liveElapsed.textContent = secs >= 60
      ? `${Math.floor(secs / 60)}m ${secs % 60}s`
      : `${secs}s`;
  }, 1000);
}

function clearActiveAgentBadge() {
  if (activeAgentTimer) { clearInterval(activeAgentTimer); activeAgentTimer = null; }
  if (activeAgentKey) {
    const meta = activityGroupMeta.get(activeAgentKey);
    if (meta?.liveBadge) meta.liveBadge.hidden = true;
  }
  activeAgentKey = null;
  activeAgentStartTime = null;
}

function _activateBadgeNode(agentKey) {
  const meta = activityGroupMeta.get(agentKey);
  if (!meta?.liveBadge) return;
  meta.liveBadge.hidden = false;
  meta.liveElapsed.textContent = "0s";
}
// ─────────────────────────────────────────────────────────────────

function resetTimeline() {
  activitySection.classList.remove("hidden");
  activityList.innerHTML = "";
  activityGroups.clear();
  activityGroupMeta.clear();
  clearActiveAgentBadge();
  toolSummaryGroups.clear();
  stageSummariesByStage.clear();
  if (stageSummariesList) stageSummariesList.innerHTML = "";
  if (stageSummariesSection) stageSummariesSection.classList.add("hidden");
  stageState.active = null;
  stageState.completed.clear();
  renderProgressStepper();
  toolMonitorSection.classList.remove("hidden");
  toolMonitorList.innerHTML = "";
}

function addActivity(eventData) {
  const event = eventData ?? {};
  const eventType = event.type || "activity";
  updateStageProgress(event);
  const title = event.agent
    ? `[${eventType}] ${event.agent}: ${event.message || "Update"}`
    : `[${eventType}] ${event.message || "Update"}`;

  const item = document.createElement("li");
  item.className = "activity-item";

  const time = new Date().toLocaleTimeString();
  const stageSummary =
    eventType === "stage_completed" && event.stage_summary
      ? renderStageSummaryCard(event.stage, event.stage_summary)
      : "";
  if (eventType === "stage_completed" && event.stage_summary) {
    upsertStageSummary(event.stage, event.stage_summary);
  }
  const summary =
    !stageSummary && event.summary
      ? `<div class="activity-summary">${escapeHtml(JSON.stringify(event.summary))}</div>`
      : "";
  const details = [
    renderDetailBlock("Tool Source", event.source),
    renderDetailBlock("Tool Family", event.toolFamily),
    renderDetailBlock("Tool Phase", event.phase),
    renderDetailBlock("Prompt", event.prompt),
    renderDetailBlock("Response", event.response),
    renderDetailBlock("Stage Summary JSON", event.stage_summary ? safeStringify(event.stage_summary) : null),
    renderDetailBlock("Tool Arguments", event.arguments),
    renderDetailBlock("Tool Output", event.output),
    renderDetailBlock("Raw LLM Run Item", event.rawItem),
    renderDetailBlock("Full Event JSON", safeStringify(event))
  ]
    .filter(Boolean)
    .join("");

  item.innerHTML = `
    <div class="activity-time">${escapeHtml(time)} • ${escapeHtml(event.stage || "general")}</div>
    <div>${escapeHtml(title)}</div>
    ${stageSummary}
    ${summary}
    ${details}
  `;

  const groupKey = event.agent || "System";
  const groupUL = ensureActivityGroup(groupKey);
  groupUL.appendChild(item);

  const meta = activityGroupMeta.get(groupKey);
  if (meta) {
    meta.count += 1;
    meta.countNode.textContent = `${meta.count}`;
  }

  if (TOOL_MONITOR_TYPES.has(eventType)) {
    addToolMonitorItem(event);
  }
}

function renderStageSummaryCard(stage, summary) {
  if (!summary || typeof summary !== "object") return "";

  const label = `${toTitleCase(stage || "Stage")} summary`;
  const rows = Object.entries(summary)
    .map(([key, value]) => {
      const printable = Array.isArray(value) ? value.join(", ") : String(value);
      return `<li><strong>${escapeHtml(humanizeKey(key))}:</strong> ${escapeHtml(printable)}</li>`;
    })
    .join("");

  if (!rows) return "";

  return `
    <div class="activity-summary">
      <div><strong>${escapeHtml(label)}</strong></div>
      <ul class="list">${rows}</ul>
    </div>
  `;
}

function upsertStageSummary(stage, summary) {
  if (!stage || !summary || typeof summary !== "object") return;
  stageSummariesByStage.set(stage, summary);
  renderStageSummariesPanel();
}

function renderStageSummariesPanel() {
  if (!stageSummariesSection || !stageSummariesList) return;

  if (stageSummariesByStage.size === 0) {
    stageSummariesSection.classList.add("hidden");
    stageSummariesList.innerHTML = "";
    return;
  }

  stageSummariesSection.classList.remove("hidden");

  const orderedStages = STAGE_FLOW.filter((stage) => stageSummariesByStage.has(stage));
  const html = orderedStages
    .map((stage) => {
      const summary = stageSummariesByStage.get(stage);
      const rows = Object.entries(summary)
        .map(([key, value]) => {
          const printable = Array.isArray(value) ? value.join(", ") : String(value);
          return `<li><strong>${escapeHtml(humanizeKey(key))}:</strong> ${escapeHtml(printable)}</li>`;
        })
        .join("");

      return `
        <article class="stage-summary-card">
          <h4>${escapeHtml((STAGE_LABELS[stage] || toTitleCase(stage)) + " Summary")}</h4>
          <ul class="list">${rows}</ul>
        </article>
      `;
    })
    .join("");

  stageSummariesList.innerHTML = html;
}

function humanizeKey(value) {
  return String(value || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase();
}

function toTitleCase(value) {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function updateStageProgress(event) {
  if (!event || !event.type || !event.stage) return;

  if (event.type === "stage_started") {
    stageState.active = event.stage;
    if (event.agent) setActiveAgentBadge(String(event.agent));
  }

  if (event.type === "stage_completed") {
    stageState.completed.add(event.stage);
    clearActiveAgentBadge();
    if (event.stage === "composition" || event.stage === "final") {
      stageState.completed.add("done");
      stageState.active = null;
    }
  }

  renderProgressStepper();
}

function renderProgressStepper() {
  if (!progressSection) return;

  const html = STAGE_FLOW.map((stage) => {
    const isCompleted = stageState.completed.has(stage);
    const isActive = stageState.active === stage && !isCompleted;
    const indicator = isCompleted ? "✅" : isActive ? "⏳" : "⬜";
    const classes = ["timeline-step"];
    if (isCompleted) classes.push("is-complete");
    if (isActive) classes.push("is-active");
    const connectorClass = isCompleted ? "timeline-connector is-complete" : "timeline-connector";
    const label = STAGE_LABELS[stage] || toTitleCase(stage);
    const connector = stage === STAGE_FLOW[STAGE_FLOW.length - 1] ? "" : `<span class="${connectorClass}"></span>`;

    return `
      <div class="${classes.join(" ")}">
        <span class="timeline-badge">${indicator}</span>
        <span class="timeline-label">${escapeHtml(label)}</span>
        ${connector}
      </div>
    `;
  }).join("");

  progressSection.innerHTML = `<div class="timeline-steps">${html}</div>`;
}

function ensureActivityGroup(agentName) {
  const key = String(agentName || "System");
  if (activityGroups.has(key)) {
    return activityGroups.get(key);
  }

  const groupItem = document.createElement("li");
  groupItem.className = "agent-group";

  const details = document.createElement("details");
  details.open = false;

  const summary = document.createElement("summary");
  summary.className = "agent-group-summary";

  const title = document.createElement("span");
  title.className = "agent-group-title";
  title.textContent = key;

  const count = document.createElement("span");
  count.className = "agent-group-count";
  count.textContent = "0";

  // Live-running badge (hidden by default)
  const liveBadge = document.createElement("span");
  liveBadge.className = "agent-live-badge";
  liveBadge.hidden = true;
  liveBadge.innerHTML =
    `<span class="agent-live-dot"></span>` +
    `<span class="agent-live-label">running</span>` +
    `\u00a0<span class="agent-live-elapsed">0s</span>`;
  const liveElapsed = liveBadge.querySelector(".agent-live-elapsed");

  summary.appendChild(title);
  summary.appendChild(liveBadge);
  summary.appendChild(count);

  const itemsList = document.createElement("ul");
  itemsList.className = "agent-group-items";

  details.appendChild(summary);
  details.appendChild(itemsList);
  groupItem.appendChild(details);
  activityList.appendChild(groupItem);

  activityGroups.set(key, itemsList);
  activityGroupMeta.set(key, {
    countNode: count,
    liveBadge,
    liveElapsed,
    count: 0
  });

  // If this agent was already marked active before its group was created, show badge now
  if (activeAgentKey === key) _activateBadgeNode(key);

  return itemsList;
}

function addToolMonitorItem(event) {
  const toolName = event.toolName || "unknown_tool";
  const bucket = ensureToolSummaryBucket(toolName);
  const timestamp = event.ts ? new Date(event.ts) : new Date();
  const time = timestamp.toLocaleTimeString();
  const hasError = detectToolEventError(event);

  bucket.count += 1;
  bucket.lastAt = timestamp;
  if (hasError) {
    bucket.errorCount += 1;
  }

  bucket.countNode.textContent = `${bucket.count}`;
  bucket.lastNode.textContent = time;
  bucket.errorNode.textContent = `${bucket.errorCount}`;

  const callItem = document.createElement("li");
  callItem.className = "tool-call-item";

  const callDetails = [
    renderDetailBlock("Arguments", event.arguments),
    renderDetailBlock("Output", event.output),
    renderDetailBlock("Raw Item", event.rawItem),
    renderDetailBlock("Full Event JSON", safeStringify(event))
  ]
    .filter(Boolean)
    .join("");

  const callTitle = `[${event.type || "tool"}] ${event.agent || "System"} • ${event.stage || "general"}`;
  callItem.innerHTML = `
    <div class="activity-time">${escapeHtml(time)}</div>
    <div>${escapeHtml(callTitle)}${hasError ? " <strong>• error</strong>" : ""}</div>
    ${callDetails}
  `;

  bucket.callsList.prepend(callItem);
}

function ensureToolSummaryBucket(toolName) {
  if (toolSummaryGroups.has(toolName)) {
    return toolSummaryGroups.get(toolName);
  }

  const item = document.createElement("li");
  item.className = "tool-summary-item";

  const details = document.createElement("details");
  details.open = false;

  const summary = document.createElement("summary");
  summary.className = "tool-summary-header";

  const nameNode = document.createElement("span");
  nameNode.className = "tool-summary-name";
  nameNode.textContent = toolName;

  const statsNode = document.createElement("span");
  statsNode.className = "tool-summary-stats";
  statsNode.innerHTML = `count: <strong>0</strong> • last: <strong>-</strong> • errors: <strong>0</strong>`;

  summary.appendChild(nameNode);
  summary.appendChild(statsNode);

  const body = document.createElement("div");
  body.className = "tool-summary-body";

  const callsList = document.createElement("ul");
  callsList.className = "tool-calls-list";

  body.appendChild(callsList);
  details.appendChild(summary);
  details.appendChild(body);
  item.appendChild(details);
  toolMonitorList.appendChild(item);

  const strongNodes = statsNode.querySelectorAll("strong");
  const bucket = {
    count: 0,
    errorCount: 0,
    lastAt: null,
    countNode: strongNodes[0],
    lastNode: strongNodes[1],
    errorNode: strongNodes[2],
    callsList
  };

  toolSummaryGroups.set(toolName, bucket);
  return bucket;
}

function detectToolEventError(event) {
  if (!event) return false;
  if (event.error) return true;

  const outputText = String(event.output || "");
  const messageText = String(event.message || "");
  const combined = `${outputText} ${messageText}`.toLowerCase();

  return combined.includes("error") || combined.includes("failed") || combined.includes("exception");
}

function renderDetailBlock(label, value) {
  if (!value) return "";
  return `<details><summary>${escapeHtml(label)}</summary><pre>${escapeHtml(String(value))}</pre></details>`;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formToPayload(formData) {
  const selectedCategories = String(formData.get("activityCategories") || "")
    .split(/[\n,;]+/)
    .map((value) => String(value).trim())
    .filter(Boolean);
  const mergedActivities = [...new Set(selectedCategories)];

  return {
    startCity: String(formData.get("startCity") || "").trim(),
    destinationCity: String(formData.get("destinationCity") || "").trim(),
    startDate: String(formData.get("startDate") || "").trim(),
    endDate: String(formData.get("endDate") || "").trim(),
    tripLengthDays: Number(formData.get("tripLengthDays")),
    activities: mergedActivities,
    weatherPreferences: String(formData.get("weatherPreferences") || "").trim(),
    airTravelClass: String(formData.get("airTravelClass") || "economy"),
    hotelStars: String(formData.get("hotelStars") || "3"),
    transportationNotes: String(formData.get("transportationNotes") || "").trim() || undefined
  };
}

function setMessage(message, isError = false) {
  messagesSection.classList.remove("hidden");
  messagesSection.innerHTML = `<p class="${isError ? "" : "muted"}">${escapeHtml(message)}</p>`;
}

function renderItinerary(planData) {
  const itinerary = planData.itinerary;
  itinerarySection.classList.remove("hidden");

  itinerarySection.innerHTML = `
    <h2>Itinerary Draft</h2>
    <p>${escapeHtml(itinerary.tripSummary)}</p>
    <p class="muted">${escapeHtml(itinerary.disclaimer || "")}</p>
    <div id="itinerary-status" class="muted"></div>
    <div id="components"></div>
    <h3>Map (Hotels & Activities)</h3>
    <p id="itinerary-map-status" class="muted">Loading map locations...</p>
    <div id="itinerary-map" class="itinerary-map"></div>
    <h3>Activities</h3>
    ${renderActivityCategoryOptions(planData)}
    <h3>Safety Concerns</h3>
    ${renderSimpleList(itinerary.safetyConcerns || [], { collapseReferences: true })}
    <h3>Packing List</h3>
    ${renderSimpleList(itinerary.packingList || [], { collapseReferences: true })}
    <h3>Estimated Cost Summary (USD)</h3>
    ${renderCostSummary(itinerary.estimatedCostSummary || {})}
    <div id="final-review"></div>
  `;

  const componentsRoot = document.getElementById("components");
  const confirmations = planData.confirmations || {};
  ["flight", "hotel", "carRental"].forEach((componentType) => {
    const component = itinerary.components?.[componentType];
    if (!component) return;

    const block = document.createElement("section");
    block.className = "card";

    const isConfirmed = !!confirmations[componentType];

    if (isConfirmed) {
      const confirmedOptionId = confirmations[componentType].optionId;
      const confirmedOption =
        (component.options || []).find((o) => o.id === confirmedOptionId) ||
        component.options?.[0];
      const priceStr = confirmedOption?.costUsd ? ` — ${formatUsd(confirmedOption.costUsd)}` : "";
      block.innerHTML = `
        <details class="confirmed-component">
          <summary class="confirmed-component-summary">
            <span class="confirmed-badge">✓ Confirmed</span>
            <span class="confirmed-component-title">${escapeHtml(componentType)}</span>
            ${confirmedOption ? `<span class="confirmed-component-label">${escapeHtml(confirmedOption.label || confirmedOption.id)}${escapeHtml(priceStr)}</span>` : ""}
          </summary>
          <div class="confirmed-component-body">
            ${confirmedOption ? renderOptionQuickFacts(componentType, confirmedOption) : ""}
            ${confirmedOption?.notes ? `<div class="muted">${escapeHtml(confirmedOption.notes)}</div>` : ""}
          </div>
        </details>
      `;
    } else {
      const optionsHtml = (component.options || [])
        .map(
          (option) => `
            <label class="option">
              <div class="inline">
                <input type="radio" name="${componentType}-option" value="${escapeHtml(option.id)}" ${
            option.id === component.recommendedOptionId ? "checked" : ""
          } />
                <strong>${escapeHtml(option.label || option.id)}</strong>
              </div>
              ${renderOptionQuickFacts(componentType, option)}
              <div class="muted">${escapeHtml(option.notes || "")}</div>
              <details>
                <summary>Show JSON</summary>
                <pre>${escapeHtml(JSON.stringify(option, null, 2))}</pre>
              </details>
            </label>
          `
        )
        .join("");

      block.innerHTML = `
        <h3>${escapeHtml(componentType)}</h3>
        <p>${escapeHtml(component.confirmationQuestion || "Please confirm this option")}</p>
        <div class="component-options">${optionsHtml}</div>
        <button data-component="${componentType}" class="confirm-btn">Confirm ${escapeHtml(componentType)}</button>
      `;
    }

    componentsRoot.appendChild(block);
  });

  renderItineraryMap(planData);
  attachActivityChoiceHandlers();
  attachActivityConfirmHandler();
  attachConfirmHandlers(planData.itineraryId);
  maybeRenderFinalAction(planData);
}

function attachConfirmHandlers(itineraryId) {
  document.querySelectorAll(".confirm-btn").forEach((button) => {
    button.addEventListener("click", async () => {
      const componentType = button.getAttribute("data-component");
      const selectedRadio = document.querySelector(`input[name="${componentType}-option"]:checked`);
      if (!selectedRadio) {
        setMessage(`Select an option for ${componentType} first.`, true);
        return;
      }

      button.disabled = true;

      try {
        const response = await fetch("/api/confirm-component", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            itineraryId,
            componentType,
            optionId: selectedRadio.value
          })
        });

        const data = await response.json();
        if (!response.ok) {
          throw new Error(apiErrorMessage(data, "Failed to confirm component"));
        }

        if (Array.isArray(data.activityEvents) && data.activityEvents.length > 0) {
          data.activityEvents.forEach((event) => addActivity(event));
        }

        if (data.itinerary) {
          currentPlan = {
            ...currentPlan,
            ...data,
            itinerary: data.itinerary
          };
          renderItinerary(currentPlan);
        }

        if (!data.nextComponentToConfirm) {
          currentPlan = { ...currentPlan, finalReview: data.finalReview ?? null };
          setItineraryStatus("All components confirmed. Please review final summary.");
          maybeRenderFinalAction(currentPlan);
        } else {
          setItineraryStatus(`Confirmed ${componentType}. Next: confirm ${data.nextComponentToConfirm}.`);
        }
      } catch (error) {
        button.disabled = false;
        setItineraryStatus(error.message || "Unexpected confirmation error", true);
      }
    });
  });
}

function setItineraryStatus(message, isError = false) {
  const status = document.getElementById("itinerary-status");
  if (!status) {
    setMessage(message, isError);
    return;
  }

  status.className = isError ? "" : "muted";
  status.textContent = message;
}

function maybeRenderFinalAction(planData) {
  const finalReviewRoot = document.getElementById("final-review");
  if (!finalReviewRoot) return;

  if (!planData.finalReview) {
    finalReviewRoot.innerHTML = "";
    return;
  }

  finalReviewRoot.innerHTML = `
    <h3>Final Review</h3>
    <p>${escapeHtml(planData.finalReview.finalSummary || "")}</p>
    <p><strong>${escapeHtml(planData.finalReview.finalConfirmationQuestion || "Confirm final itinerary?")}</strong></p>
    <p class="muted">${escapeHtml(planData.finalReview.purchaseReminder || "No purchases are made")}</p>
    <button id="final-approve">Approve Final Itinerary</button>
    <div id="final-itinerary-output"></div>
  `;

  const approveButton = document.getElementById("final-approve");
  approveButton?.addEventListener("click", async () => {
    approveButton.disabled = true;
    setItineraryStatus("Submitting final approval...");

    try {
      const response = await fetch("/api/final-confirmation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itineraryId: currentPlan.itineraryId, approved: true })
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(apiErrorMessage(data, "Final confirmation failed"));
      }

      approveButton.textContent = "Final Itinerary Approved";
      currentPlan = {
        ...currentPlan,
        finalConfirmed: true
      };
      renderFinalItineraryOutput(currentPlan, data);
      setMessage(data.message);
      setItineraryStatus(data.message);
    } catch (error) {
      approveButton.disabled = false;
      setMessage(error.message || "Unexpected final confirmation error", true);
      setItineraryStatus(error.message || "Unexpected final confirmation error", true);
    }
  });
}

function renderFinalItineraryOutput(planData, finalConfirmationResponse = {}) {
  const root = document.getElementById("final-itinerary-output");
  if (!root || !planData?.itinerary) return;

  const itinerary = planData.itinerary;
  const confirmations = planData.confirmations || {};

  const selectedFlight = findSelectedOption(itinerary.components?.flight, confirmations.flight?.optionId);
  const selectedHotel = findSelectedOption(itinerary.components?.hotel, confirmations.hotel?.optionId);
  const selectedCar = findSelectedOption(itinerary.components?.carRental, confirmations.carRental?.optionId);
  const confirmedActivities = getConfirmedActivityOptions(planData);
  const activitiesHtml = confirmedActivities.length
    ? `<ul class="list">${confirmedActivities
        .map(
          (activity) =>
            `<li>${escapeHtml(activity.category)}: ${escapeHtml(activity.name)} (${escapeHtml(
              formatUsd(activity.estimatedCostUsd) || "$0"
            )})</li>`
        )
        .join("")}</ul>`
    : `<div class="muted">No confirmed activities</div>`;

  root.innerHTML = `
    <section class="final-itinerary-card">
      <h4>Final Itinerary</h4>
      <p class="muted">Planning complete. No purchases were made.</p>

      <div class="final-item">
        <strong>Flight:</strong>
        <div>${escapeHtml(selectedFlight?.label || "Not selected")}</div>
        <div class="muted">${escapeHtml(formatUsd(selectedFlight?.costUsd) || "-")}</div>
      </div>

      <div class="final-item">
        <strong>Hotel:</strong>
        <div>${escapeHtml(selectedHotel?.label || "Not selected")}</div>
        <div class="muted">${escapeHtml(formatUsd(selectedHotel?.costUsd) || "-")}</div>
      </div>

      <div class="final-item">
        <strong>Car Rental:</strong>
        <div>${escapeHtml(selectedCar?.label || "Not selected")}</div>
        <div class="muted">${escapeHtml(formatUsd(selectedCar?.costUsd) || "$0")}</div>
      </div>

      <div class="final-item">
        <strong>Activities:</strong>
        ${activitiesHtml}
      </div>

      <div class="final-item">
        <strong>Total Estimated Cost:</strong>
        <div>${escapeHtml(formatUsd(itinerary.estimatedCostSummary?.totalUsd) || "$0")}</div>
      </div>

      <div class="final-item">
        <strong>Purchase Policy:</strong>
        <div class="muted">${escapeHtml(finalConfirmationResponse.noPurchasePolicy || "This app does not proceed with purchases.")}</div>
      </div>
    </section>
  `;
}

function findSelectedOption(component, confirmedOptionId) {
  if (!component?.options?.length) return null;
  const selectedId = confirmedOptionId || component.recommendedOptionId || component.options[0]?.id;
  return component.options.find((item) => item.id === selectedId) || component.options[0] || null;
}

function renderSimpleList(items, options = {}) {
  const collapseReferences = options.collapseReferences === true;
  if (!items.length) return "<p class=\"muted\">No items.</p>";

  const rows = items
    .map((item) => {
      if (!collapseReferences) {
        return `<li>${escapeHtml(String(item))}</li>`;
      }

      const parsed = splitContentAndReferences(item);
      const linksHtml = parsed.links.length
        ? `
          <details class="reference-links">
            <summary>Show references (${parsed.links.length})</summary>
            <ul class="list reference-links-list">
              ${parsed.links
                .map((link) => `<li><a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link)}</a></li>`)
                .join("")}
            </ul>
          </details>
        `
        : "";

      return `<li>${escapeHtml(parsed.text)}${linksHtml}</li>`;
    })
    .join("");

  return `<ul class=\"list\">${rows}</ul>`;
}

function splitContentAndReferences(item) {
  const urlRegex = /https?:\/\/[^\s)\]}>,]+/g;
  const extractedLinks = [];

  const pushLink = (value) => {
    if (!value) return;
    const asString = String(value).trim();
    if (!asString) return;
    if (!/^https?:\/\//i.test(asString)) return;
    if (!extractedLinks.includes(asString)) extractedLinks.push(asString);
  };

  if (typeof item === "string") {
    const found = item.match(urlRegex) || [];
    found.forEach(pushLink);
    const text = item.replace(urlRegex, "").replace(/\s{2,}/g, " ").trim();
    return {
      text: text || item,
      links: extractedLinks
    };
  }

  if (item && typeof item === "object") {
    const linkFields = [
      "references",
      "referenceLinks",
      "sourceLinks",
      "sources",
      "links",
      "urls",
      "source",
      "reference",
      "url"
    ];

    linkFields.forEach((field) => {
      const value = item[field];
      if (Array.isArray(value)) {
        value.forEach(pushLink);
      } else {
        pushLink(value);
      }
    });

    const text =
      item.concern ||
      item.item ||
      item.name ||
      item.description ||
      item.text ||
      JSON.stringify(item);

    const inferredFromText = String(text).match(urlRegex) || [];
    inferredFromText.forEach(pushLink);

    return {
      text: String(text).replace(urlRegex, "").replace(/\s{2,}/g, " ").trim() || String(text),
      links: extractedLinks
    };
  }

  const fallback = String(item);
  const found = fallback.match(urlRegex) || [];
  found.forEach(pushLink);
  return {
    text: fallback.replace(urlRegex, "").replace(/\s{2,}/g, " ").trim() || fallback,
    links: extractedLinks
  };
}

async function renderItineraryMap(planData) {
  const mapElement = document.getElementById("itinerary-map");
  const statusElement = document.getElementById("itinerary-map-status");
  if (!mapElement || !statusElement) return;

  if (!window.L) {
    statusElement.textContent = "Map is unavailable (leaflet library not loaded).";
    return;
  }

  const token = ++mapRenderToken;
  const destination = String(form?.querySelector('input[name="destinationCity"]')?.value || "").trim();
  const places = buildMapPlaces(planData, destination).slice(0, 16);

  if (places.length === 0) {
    mapElement.classList.add("hidden");
    statusElement.textContent = "No mappable hotel/activity locations available.";
    return;
  }

  mapElement.classList.remove("hidden");
  statusElement.textContent = "Resolving hotel and activity locations...";
  const map = ensureItineraryMap(mapElement);
  itineraryMapLayer.clearLayers();

  const points = [];
  for (const place of places) {
    const point = await geocodePlace(place.query);
    if (!point || token !== mapRenderToken) continue;
    points.push({ ...place, ...point });
  }

  if (token !== mapRenderToken) return;

  if (points.length === 0) {
    statusElement.textContent = "Could not resolve map coordinates for these hotels/activities.";
    return;
  }

  points.forEach((point) => {
    const color = point.type === "hotel" ? "#2563eb" : "#059669";
    const marker = window.L.circleMarker([point.lat, point.lon], {
      radius: 8,
      color,
      fillColor: color,
      fillOpacity: 0.75,
      weight: 2
    });

    marker.bindPopup(`
      <div>
        <strong>${escapeHtml(point.type === "hotel" ? "Hotel" : "Activity")}</strong><br/>
        ${escapeHtml(point.label)}
      </div>
    `);
    itineraryMapLayer.addLayer(marker);
  });

  const bounds = window.L.latLngBounds(points.map((point) => [point.lat, point.lon]));
  if (bounds.isValid()) {
    map.fitBounds(bounds.pad(0.2));
  }

  statusElement.textContent = `Showing ${points.length} mapped location${points.length === 1 ? "" : "s"}.`;
}

function buildMapPlaces(planData, destination) {
  const itinerary = planData?.itinerary || {};
  const hotelOptions = itinerary?.components?.hotel?.options || [];

  // Before confirmation: show ALL activities from itinerary (not filtered by category)
  // After confirmation: show only confirmed selections
  let activityOptions;
  if (planData?.activityConfirmed) {
    activityOptions = getConfirmedActivityOptions(planData);
  } else {
    // Use all itinerary activities directly so every activity appears on the map
    activityOptions = normalizeActivities(itinerary?.activities || []);
  }

  const seen = new Set();
  const places = [];

  const addPlace = (type, label, geocodeQuery) => {
    const cleanLabel = String(label || "").trim();
    if (!cleanLabel) return;
    const query = geocodeQuery || cleanLabel;
    const withDestination = destination && !query.toLowerCase().includes(destination.toLowerCase())
      ? `${query}, ${destination}`
      : query;
    const dedupeKey = `${type}:${withDestination.toLowerCase()}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    places.push({ type, label: cleanLabel, query: withDestination });
  };

  hotelOptions.forEach((option) => {
    addPlace("hotel", option.label || option.name || option.id);
  });

  activityOptions.forEach((activity) => {
    if (typeof activity === "string") {
      addPlace("activity", activity);
      return;
    }
    const label = `${activity.name || activity.title || ""}${activity.category ? ` (${activity.category})` : ""}`;
    // Prefer the location field for geocoding (more precise address/place)
    const geocodeQuery = activity.location || activity.name || activity.title || "";
    addPlace("activity", label, geocodeQuery);
  });

  return places;
}

function ensureItineraryMap(mapElement) {
  if (!itineraryMap || itineraryMap.getContainer() !== mapElement) {
    if (itineraryMap) {
      itineraryMap.remove();
      itineraryMap = null;
      itineraryMapLayer = null;
    }

    itineraryMap = window.L.map(mapElement, {
      zoomControl: true
    }).setView([48.8566, 2.3522], 12);

    window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(itineraryMap);

    itineraryMapLayer = window.L.layerGroup().addTo(itineraryMap);
  }

  setTimeout(() => {
    itineraryMap?.invalidateSize();
  }, 0);

  return itineraryMap;
}

async function geocodePlace(query) {
  const key = String(query || "").trim().toLowerCase();
  if (!key) return null;
  if (geocodeCache.has(key)) return geocodeCache.get(key);

  try {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      headers: {
        Accept: "application/json"
      }
    });
    if (!response.ok) {
      geocodeCache.set(key, null);
      return null;
    }

    const payload = await response.json();
    const first = Array.isArray(payload) ? payload[0] : null;
    if (!first?.lat || !first?.lon) {
      geocodeCache.set(key, null);
      return null;
    }

    const point = {
      lat: Number(first.lat),
      lon: Number(first.lon)
    };
    if (Number.isNaN(point.lat) || Number.isNaN(point.lon)) {
      geocodeCache.set(key, null);
      return null;
    }

    geocodeCache.set(key, point);
    return point;
  } catch {
    geocodeCache.set(key, null);
    return null;
  }
}

function renderCostSummary(costs) {
  const lines = [
    ["Flight", Number(costs.flightUsd) || 0],
    ["Hotel", Number(costs.hotelUsd) || 0],
    ["Car Rental", Number(costs.carRentalUsd) || 0],
    ["Activities", Number(costs.activitiesUsd) || 0]
  ];

  const rows = lines
    .map(([label, value]) => {
      return `
        <div class="cost-row">
          <span class="cost-label">${escapeHtml(label)}</span>
          <span class="cost-value">${escapeHtml(formatUsd(value) || "$0")}</span>
        </div>
      `;
    })
    .join("");

  const total = formatUsd(Number(costs.totalUsd) || 0) || "$0";

  return `
    <div class="cost-summary-card">
      ${rows}
      <div class="cost-row cost-total">
        <span class="cost-label">Total</span>
        <span class="cost-value">${escapeHtml(total)}</span>
      </div>
    </div>
  `;
}

function renderOptionQuickFacts(componentType, option) {
  const facts = [];

  if (componentType === "flight") {
    facts.push(
      ["Price", formatUsd(option.costUsd)],
      ["Airline", option.airline],
      ["Route", option.route],
      ["Class", option.class],
      ["Outbound", `${formatDateTime(option.outboundDepartureLocal)} → ${formatDateTime(option.outboundArrivalLocal)}`],
      ["Return", `${formatDateTime(option.returnDepartureLocal)} → ${formatDateTime(option.returnArrivalLocal)}`],
      ["Stay", formatStay(option.daysAtDestination, option.nightsAtDestination)]
    );
  } else if (componentType === "hotel") {
    facts.push(
      ["Total", formatUsd(option.costUsd)],
      ["Nightly", formatUsd(option.nightlyUsd)],
      ["Nights", option.nights],
      ["Stars", option.stars ? `${option.stars}★` : null]
    );
  } else if (componentType === "carRental") {
    facts.push(
      ["Total", formatUsd(option.costUsd)],
      ["Daily", formatUsd(option.dailyRateUsd)],
      ["Days", option.rentalDays],
      ["Company", option.company],
      ["Car Type", option.carType]
    );
  }

  const rows = facts
    .filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== "")
    .map(([label, value]) => {
      return `
        <div class="option-fact-row">
          <span class="option-fact-label">${escapeHtml(String(label))}</span>
          <span class="option-fact-value">${escapeHtml(String(value))}</span>
        </div>
      `;
    })
    .join("");

  if (!rows) return "";
  return `<div class="option-facts">${rows}</div>`;
}

function formatUsd(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  return `$${value.toLocaleString("en-US")}`;
}

function formatDateTime(value) {
  if (!value || typeof value !== "string") return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function formatStay(days, nights) {
  if (typeof days !== "number" && typeof nights !== "number") return null;
  const safeDays = typeof days === "number" ? days : 0;
  const safeNights = typeof nights === "number" ? nights : 0;
  return `${safeDays} day${safeDays === 1 ? "" : "s"} / ${safeNights} night${safeNights === 1 ? "" : "s"}`;
}

function renderActivityCategoryOptions(planData) {
  const optionSets = getActivityCategoryOptionSets(planData);
  if (!optionSets.length) return "<p class=\"muted\">No activities.</p>";

  const isConfirmed = Boolean(planData?.activityConfirmed);
  const cards = optionSets
    .map((set, categoryIndex) => {
      const category = set.category;
      const options = set.options;
      if (!options.length) return "";

      const currentSelection = (planData.activitySelections || {})[category] || options[0].id;
      const groupName = `activity-category-${slugify(category)}-${categoryIndex}`;

      const optionsHtml = options
        .map((activity) => {
          const isChecked = activity.id === currentSelection;
          return `
            <label class="option">
              <div class="inline">
                <input class="activity-choice-input" type="radio" name="${escapeHtml(groupName)}" data-category="${escapeHtml(category)}" value="${escapeHtml(activity.id)}" ${isChecked ? "checked" : ""} ${isConfirmed ? "disabled" : ""} />
                <strong>${escapeHtml(activity.name)}</strong>
              </div>
              <div class="option-facts">
                <div class="option-fact-row">
                  <span class="option-fact-label">Day</span>
                  <span class="option-fact-value">${escapeHtml(activity.scheduledDay || "Any day")}</span>
                </div>
                <div class="option-fact-row">
                  <span class="option-fact-label">Estimated Cost</span>
                  <span class="option-fact-value">${escapeHtml(formatUsd(activity.estimatedCostUsd) || "$0")}</span>
                </div>
              </div>
              ${activity.notes ? `<div class="muted">${escapeHtml(activity.notes)}</div>` : ""}
            </label>
          `;
        })
        .join("");

      return `
        <section class="card activity-category-card">
          <h4>${escapeHtml(toTitleCase(category))}</h4>
          <p class="muted">${isConfirmed ? "Confirmed" : "Choose one activity option."}</p>
          <div class="component-options">${optionsHtml}</div>
        </section>
      `;
    })
    .join("");

  const controls = `
    <div class="activity-confirm-wrap">
      <button id="confirm-activities-btn" ${isConfirmed ? "disabled" : ""}>${isConfirmed ? "Activities Confirmed" : "Confirm Activities"}</button>
      <div class="muted">${isConfirmed ? "Map now shows only confirmed activity options." : "Select one option per category, then confirm activities."}</div>
    </div>
  `;

  return (cards || "<p class=\"muted\">No activities for selected categories.</p>") + controls;
}

function attachActivityChoiceHandlers() {
  document.querySelectorAll(".activity-choice-input").forEach((input) => {
    input.addEventListener("change", () => {
      const category = input.getAttribute("data-category");
      if (!category) return;
      currentPlan.activitySelections = currentPlan.activitySelections || {};
      currentPlan.activitySelections[category] = input.value;
      if (currentPlan.activityConfirmed) {
        currentPlan.activityConfirmed = false;
        currentPlan.confirmedActivities = [];
      }
      renderItineraryMap(currentPlan);
    });
  });
}

function attachActivityConfirmHandler() {
  const button = document.getElementById("confirm-activities-btn");
  if (!button) return;
  button.addEventListener("click", () => {
    const selected = getSelectedActivityOptions(currentPlan);
    if (!selected.length) {
      setItineraryStatus("Choose at least one activity option before confirming activities.", true);
      return;
    }

    currentPlan.activityConfirmed = true;
    currentPlan.confirmedActivities = selected;
    setItineraryStatus("Activities confirmed. Map now shows only confirmed activity options.");
    renderItinerary(currentPlan);
  });
}

function getActivityCategoryOptionSets(planData) {
  const items = normalizeActivities(planData?.itinerary?.activities || []);
  if (!items.length) return [];

  const categories = (planData?.requestedActivityCategories || [])
    .map((value) => String(value).trim())
    .filter(Boolean);
  const categoriesToRender = categories.length ? categories : ["Activities"];

  planData.activitySelections = planData.activitySelections || {};

  return categoriesToRender
    .map((category) => {
      const options = pickActivityOptionsForCategory(items, category).slice(0, 3);
      if (options.length && !planData.activitySelections[category]) {
        planData.activitySelections[category] = options[0].id;
      }
      return { category, options };
    })
    .filter((set) => set.options.length > 0);
}

function getSelectedActivityOptions(planData) {
  const optionSets = getActivityCategoryOptionSets(planData);
  return optionSets
    .map((set) => {
      const selectedId = planData?.activitySelections?.[set.category] || set.options[0]?.id;
      const selected = set.options.find((option) => option.id === selectedId) || set.options[0] || null;
      return selected
        ? {
            ...selected,
            category: set.category
          }
        : null;
    })
    .filter(Boolean);
}

function getAllActivityOptions(planData) {
  const optionSets = getActivityCategoryOptionSets(planData);
  const all = [];
  const seen = new Set();
  optionSets.forEach((set) => {
    set.options.forEach((option) => {
      const key = `${set.category}:${option.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      all.push({ ...option, category: set.category });
    });
  });
  return all;
}

function getConfirmedActivityOptions(planData) {
  if (Array.isArray(planData?.confirmedActivities) && planData.confirmedActivities.length > 0) {
    return planData.confirmedActivities;
  }
  return getSelectedActivityOptions(planData);
}

function normalizeActivities(items) {
  return items
    .map((activity, index) => {
      if (typeof activity === "string") {
        return {
          id: `activity-${index}`,
          name: activity,
          category: "",
          estimatedCostUsd: 0,
          scheduledDay: "",
          notes: ""
        };
      }

      return {
        id: String(activity?.id || `activity-${index}`),
        name: String(activity?.name || `Activity ${index + 1}`),
        category: String(activity?.category || "").toLowerCase().trim(),
        location: String(activity?.location || ""),
        estimatedCostUsd: Number(activity?.estimatedCostUsd || 0),
        scheduledDay: String(activity?.scheduledDay || ""),
        notes: String(activity?.notes || "")
      };
    })
    .filter((activity) => activity.name);
}

function pickActivityOptionsForCategory(items, category) {
  const normalizedCategory = String(category || "").toLowerCase().trim();

  // 1. Exact category match from agent-provided category field
  const exactMatches = items.filter(
    (a) => a.category && a.category === normalizedCategory
  );
  if (exactMatches.length >= 3) return exactMatches.slice(0, 3);

  // 2. Fuzzy match: check if agent category contains key terms or vice versa
  const fuzzyMatches = items.filter((a) => {
    if (!a.category) return false;
    return a.category.includes(normalizedCategory) || normalizedCategory.includes(a.category);
  });
  const combined = [...exactMatches];
  const seenIds = new Set(combined.map((a) => a.id));
  fuzzyMatches.forEach((a) => {
    if (!seenIds.has(a.id)) { combined.push(a); seenIds.add(a.id); }
  });
  if (combined.length >= 3) return combined.slice(0, 3);

  // 3. Keyword scoring on name/notes (for activities without a category field)
  const terms = normalizedCategory
    .split(/\s+/)
    .map((term) => term.replace(/[^a-z]/g, ""))
    .filter(Boolean);
  const scored = items
    .filter((a) => !seenIds.has(a.id))
    .map((activity) => {
      const haystack = `${activity.name} ${activity.notes} ${activity.category}`.toLowerCase();
      const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
      return { activity, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.activity);

  scored.forEach((a) => {
    if (!seenIds.has(a.id)) { combined.push(a); seenIds.add(a.id); }
  });

  // NEVER pad with unrelated activities — only show what actually matches
  return combined.slice(0, 3);
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function apiErrorMessage(data, fallback) {
  if (!data) return fallback;
  const parts = [data.error, data.details].filter(Boolean);
  return parts.length ? parts.join(": ") : fallback;
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function syncTripLengthFromDates() {
  if (!startDateInput || !endDateInput || !tripLengthInput) return;

  const start = parseDateOnly(startDateInput.value);
  const end = parseDateOnly(endDateInput.value);

  if (!start || !end || end <= start) {
    tripLengthInput.value = "1";
    return;
  }

  const millisecondsPerDay = 24 * 60 * 60 * 1000;
  const diffDays = Math.floor((end.getTime() - start.getTime()) / millisecondsPerDay);
  tripLengthInput.value = String(Math.max(1, diffDays));
}

function parseDateOnly(value) {
  if (!value) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
