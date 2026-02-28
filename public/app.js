const form = document.getElementById("trip-form");
const itinerarySection = document.getElementById("itinerary");
const messagesSection = document.getElementById("messages");
const activitySection = document.getElementById("activity");
const activityList = document.getElementById("activity-list");
const progressSection = document.getElementById("progress");
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
const toolSummaryGroups = new Map();
const STAGE_FLOW = ["initialization", "research", "safety", "composition", "done"];
const stageState = {
  active: null,
  completed: new Set()
};

if (tripLengthInput) {
  tripLengthInput.readOnly = true;
}

startDateInput?.addEventListener("change", syncTripLengthFromDates);
endDateInput?.addEventListener("change", syncTripLengthFromDates);
syncTripLengthFromDates();

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const payload = formToPayload(new FormData(form));
  const submitButton = form.querySelector("button[type='submit']");
  submitButton.disabled = true;
  resetTimeline();
  itinerarySection.classList.add("hidden");
  setMessage("Generating itinerary with agents...");

  try {
    const data = await streamPlan(payload);

    currentPlan = data;
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

function resetTimeline() {
  activitySection.classList.remove("hidden");
  activityList.innerHTML = "";
  activityGroups.clear();
  activityGroupMeta.clear();
  toolSummaryGroups.clear();
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
  }

  if (event.type === "stage_completed") {
    stageState.completed.add(event.stage);
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
    const classes = ["progress-step"];
    if (isCompleted) classes.push("is-complete");
    if (isActive) classes.push("is-active");

    return `<span class="${classes.join(" ")}">${indicator} ${escapeHtml(stage)}</span>`;
  }).join("");

  progressSection.innerHTML = html;
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

  summary.appendChild(title);
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
    count: 0
  });

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
  return {
    startCity: String(formData.get("startCity") || "").trim(),
    destinationCity: String(formData.get("destinationCity") || "").trim(),
    startDate: String(formData.get("startDate") || "").trim(),
    endDate: String(formData.get("endDate") || "").trim(),
    tripLengthDays: Number(formData.get("tripLengthDays")),
    activities: String(formData.get("activities") || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
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
    <h3>Activities</h3>
    ${renderActivityList(itinerary.activities || [])}
    <h3>Safety Concerns</h3>
    ${renderSimpleList(itinerary.safetyConcerns || [])}
    <h3>Packing List</h3>
    ${renderSimpleList(itinerary.packingList || [])}
    <h3>Estimated Cost Summary (USD)</h3>
    ${renderCostSummary(itinerary.estimatedCostSummary || {})}
    <div id="final-review"></div>
  `;

  const componentsRoot = document.getElementById("components");
  ["flight", "hotel", "carRental"].forEach((componentType) => {
    const component = itinerary.components?.[componentType];
    if (!component) return;

    const block = document.createElement("section");
    block.className = "card";

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

    componentsRoot.appendChild(block);
  });

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
      setMessage(data.message);
      setItineraryStatus(data.message);
    } catch (error) {
      approveButton.disabled = false;
      setMessage(error.message || "Unexpected final confirmation error", true);
      setItineraryStatus(error.message || "Unexpected final confirmation error", true);
    }
  });
}

function renderSimpleList(items) {
  if (!items.length) return "<p class=\"muted\">No items.</p>";
  return `<ul class=\"list\">${items.map((item) => `<li>${escapeHtml(String(item))}</li>`).join("")}</ul>`;
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

function renderActivityList(items) {
  if (!items.length) return "<p class=\"muted\">No activities.</p>";
  const rows = items
    .map((activity) => {
      const line = `${activity.scheduledDay || "Day"}: ${activity.name || "Activity"} ($${activity.estimatedCostUsd || 0})`;
      return `<li>${escapeHtml(line)}</li>`;
    })
    .join("");
  return `<ul class=\"list\">${rows}</ul>`;
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
