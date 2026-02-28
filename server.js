import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import {
  buildItineraryDraft,
  createFinalReview,
  recomputeDependentComponentsFromFlight,
  validateTripRequest,
  TRIP_COMPONENTS
} from "./src/agents/tripPlanner.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT || 3000);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const itineraryStore = new Map();

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", service: "spring-break-trip-agent" });
});

app.post("/api/plan", async (req, res) => {
  const validation = validateTripRequest(req.body);
  if (!validation.success) {
    return res.status(400).json({
      error: "Invalid trip request",
      details: validation.error.flatten()
    });
  }

  try {
    const preferences = validation.data;
    const itineraryDraft = await buildItineraryDraft(preferences);
    const itineraryId = storeItineraryRecord(preferences, itineraryDraft);

    res.json({
      itineraryId,
      itinerary: itineraryDraft,
      nextComponentToConfirm: nextComponentToConfirm(itineraryStore.get(itineraryId).confirmations)
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to generate itinerary",
      details: error instanceof Error ? error.message : "Unknown error"
    });
  }
});

app.post("/api/plan-stream", async (req, res) => {
  const validation = validateTripRequest(req.body);
  if (!validation.success) {
    return res.status(400).json({
      error: "Invalid trip request",
      details: validation.error.flatten()
    });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  let responseClosed = false;
  res.on("close", () => {
    responseClosed = true;
  });
  req.on("aborted", () => {
    responseClosed = true;
  });

  const pushEvent = (eventName, payload) => {
    if (responseClosed) return;
    
    // Wrap all SSE payloads in a consistent envelope with timestamp
    const envelope = {
      ts: new Date().toISOString(),
      ...payload
    };
    
    res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(envelope)}\n\n`);
  };

  try {
    const preferences = validation.data;
    pushEvent("activity", {
      type: "planning_started",
      stage: "initialization",
      message: "Trip planning request accepted."
    });

    const itineraryDraft = await buildItineraryDraft(preferences, {
      onEvent: (event) => pushEvent("activity", event)
    });

    const itineraryId = storeItineraryRecord(preferences, itineraryDraft);
    pushEvent("result", {
      itineraryId,
      itinerary: itineraryDraft,
      nextComponentToConfirm: nextComponentToConfirm(itineraryStore.get(itineraryId).confirmations)
    });
    pushEvent("done", {
      message: "Planning complete. Review options and confirm components."
    });
  } catch (error) {
    pushEvent("error", {
      error: "Failed to generate itinerary",
      details: error instanceof Error ? error.message : "Unknown error"
    });
  } finally {
    if (!responseClosed) {
      res.end();
    }
  }
});

app.post("/api/confirm-component", async (req, res) => {
  const { itineraryId, componentType, optionId } = req.body ?? {};
  if (!itineraryId || !componentType || !optionId) {
    return res.status(400).json({ error: "itineraryId, componentType, and optionId are required" });
  }

  if (!TRIP_COMPONENTS.includes(componentType)) {
    return res.status(400).json({
      error: `componentType must be one of: ${TRIP_COMPONENTS.join(", ")}`
    });
  }

  const record = itineraryStore.get(itineraryId);
  if (!record) {
    return res.status(404).json({ error: "Itinerary not found" });
  }

  const component = record.itinerary?.components?.[componentType];
  if (!component) {
    return res.status(400).json({ error: `Component '${componentType}' is not available in itinerary` });
  }

  const matchingOption = component.options.find((option) => option.id === optionId);
  if (!matchingOption) {
    return res.status(400).json({ error: "Selected option is not valid for this component" });
  }

  record.confirmations[componentType] = {
    optionId,
    confirmedAt: new Date().toISOString()
  };

  if (componentType === "flight") {
    record.itinerary = recomputeDependentComponentsFromFlight(record.itinerary, optionId);
    record.confirmations.hotel = null;
    record.confirmations.carRental = null;
    record.finalReview = null;
  }

  const remainingComponent = nextComponentToConfirm(record.confirmations);
  if (!remainingComponent) {
    record.finalReview = await createFinalReview(record.preferences, record.itinerary, record.confirmations);
  }

  res.json({
    itineraryId,
    itinerary: record.itinerary,
    confirmations: record.confirmations,
    nextComponentToConfirm: remainingComponent,
    finalReview: record.finalReview ?? null
  });
});

app.post("/api/final-confirmation", (req, res) => {
  const { itineraryId, approved } = req.body ?? {};
  if (!itineraryId || typeof approved !== "boolean") {
    return res.status(400).json({ error: "itineraryId and approved(boolean) are required" });
  }

  const record = itineraryStore.get(itineraryId);
  if (!record) {
    return res.status(404).json({ error: "Itinerary not found" });
  }

  const stillPending = nextComponentToConfirm(record.confirmations);
  if (stillPending) {
    return res.status(400).json({
      error: `Please confirm ${stillPending} before final confirmation`
    });
  }

  record.finalConfirmed = approved;
  record.finalConfirmationAt = new Date().toISOString();

  res.json({
    itineraryId,
    approved,
    message: approved
      ? "Final itinerary confirmed. No purchases were made."
      : "Final itinerary was not approved. No purchases were made.",
    noPurchasePolicy: "At this stage, nothing is purchased."
  });
});

app.listen(port, () => {
  console.log(`Trip planner app listening on http://localhost:${port}`);
});

function nextComponentToConfirm(confirmations) {
  return TRIP_COMPONENTS.find((component) => !confirmations[component]) ?? null;
}

function storeItineraryRecord(preferences, itineraryDraft) {
  const itineraryId = randomUUID();
  itineraryStore.set(itineraryId, {
    itineraryId,
    preferences,
    itinerary: itineraryDraft,
    confirmations: {
      flight: null,
      hotel: null,
      carRental: null
    },
    finalConfirmed: false,
    createdAt: new Date().toISOString()
  });

  return itineraryId;
}
