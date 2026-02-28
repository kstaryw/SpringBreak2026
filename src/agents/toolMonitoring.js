// Use event types from tripPlanner to ensure consistency
export const EventTypes = {
  TOOL_CALL_STARTED: "tool_call_started",
  TOOL_CALL_COMPLETED: "tool_call_completed",
  WEB_SEARCH_CALLED: "web_search_called",
  WEB_SEARCH_OUTPUT: "web_search_output"
};

export function tagToolForMonitoring(toolInstance, metadata = {}) {
  if (!toolInstance || typeof toolInstance !== "object") {
    return toolInstance;
  }

  toolInstance.__monitor = {
    source: metadata.source ?? "custom",
    family: metadata.family ?? null,
    label: metadata.label ?? null
  };

  return toolInstance;
}

export function createMonitoredHostedTool(createHostedTool, metadata = {}) {
  return tagToolForMonitoring(createHostedTool(), {
    source: "built-in",
    ...metadata
  });
}

export function attachStandardToolMonitoring(runner, { emit, stage, fallbackAgentName }) {
  let callCount = 0;

  runner.on("agent_tool_start", (_context, eventAgent, eventTool, details) => {
    callCount += 1;

    const payload = buildToolPayload({
      phase: "start",
      stage,
      eventAgent,
      eventTool,
      details,
      fallbackAgentName
    });

    emit({
      type: EventTypes.TOOL_CALL_STARTED,
      ...payload
    });

    if (payload.isWebSearch) {
      emit({
        type: EventTypes.WEB_SEARCH_CALLED,
        ...payload,
        message: `Web search tool called (${payload.monitorLabel || "default"}).`
      });
    }
  });

  runner.on("agent_tool_end", (_context, eventAgent, eventTool, result, details) => {
    const payload = buildToolPayload({
      phase: "end",
      stage,
      eventAgent,
      eventTool,
      details,
      result,
      fallbackAgentName
    });

    emit({
      type: EventTypes.TOOL_CALL_COMPLETED,
      ...payload
    });

    if (payload.isWebSearch) {
      emit({
        type: EventTypes.WEB_SEARCH_OUTPUT,
        ...payload,
        message: `Web search tool output received (${payload.monitorLabel || "default"}).`
      });
    }
  });

  return {
    getCallCount() {
      return callCount;
    }
  };
}

function buildToolPayload({ phase, stage, eventAgent, eventTool, details, result, fallbackAgentName }) {
  const rawToolCall = details?.toolCall;
  const toolName = eventTool?.name || rawToolCall?.name || rawToolCall?.type || "unknown_tool";
  const toolMeta = eventTool?.__monitor || {};

  const source =
    toolMeta.source ||
    (rawToolCall?.type === "hosted_tool_call" ? "built-in" : "custom");

  return {
    phase,
    stage,
    agent: eventAgent?.name || fallbackAgentName,
    toolName,
    toolFamily: toolMeta.family ?? null,
    monitorLabel: toolMeta.label ?? null,
    source,
    isWebSearch: isWebSearchName(toolName, toolMeta),
    message:
      phase === "start"
        ? `Tool called: ${toolName}`
        : `Tool output received: ${toolName}`,
    arguments: normalizeDetailValue(rawToolCall?.arguments),
    output: normalizeDetailValue(result),
    rawItem: normalizeDetailValue(rawToolCall)
  };
}

function isWebSearchName(toolName, toolMeta) {
  if (toolMeta?.family === "web_search") return true;
  const normalized = String(toolName || "").toLowerCase();
  return normalized.includes("web_search") || normalized.includes("websearch");
}

function normalizeDetailValue(value) {
  if (value == null) return null;
  if (typeof value === "string") return value;

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
