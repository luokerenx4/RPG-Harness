import React from "react";
import { Box, Text } from "ink";
import type {
  HubActivity,
  HubSnapshot,
  StatSnapshot,
  StatThreshold,
} from "@rpg-harness/engine";
import {
  buildHubView,
  formatActivityForecast,
  formatHubCalendar,
} from "@rpg-harness/frontend-core";

interface HubMenuProps {
  snapshot: HubSnapshot;
  cursor: number;
}

const BAR_WIDTH = 20;

export function HubMenu({ snapshot, cursor }: HubMenuProps) {
  const calendar = formatHubCalendar(snapshot);
  const hubView = buildHubView(snapshot);
  return (
    <Box flexDirection="column">
      {calendar ? (
        <Box flexDirection="row" marginBottom={1}>
          <Text bold color="yellow">{calendar}</Text>
        </Box>
      ) : null}

      <Box flexDirection="column" marginBottom={1}>
        {snapshot.stats.map((stat) => (
          <StatRow key={stat.id} stat={stat} />
        ))}
      </Box>

      {snapshot.affections.length > 0 ? (
        <Box flexDirection="row" marginBottom={1} gap={2}>
          {snapshot.affections.map((a) => (
            <Text key={a.id}>
              <Text color="cyan">{a.name}</Text>
              <Text dimColor>: </Text>
              <Text color={a.value >= 0 ? "green" : "red"}>{a.value}</Text>
            </Text>
          ))}
        </Box>
      ) : null}

      {(snapshot.resourceGroups ?? []).map((group) => (
        <Box key={group.id} flexDirection="column" marginBottom={1}>
          <Text bold color="magenta">{group.title}</Text>
          <Text>
            {group.resources
              .map((resource) => `${resource.name} ×${resource.quantity}`)
              .join("、")}
          </Text>
          {group.description ? <Text dimColor>{group.description}</Text> : null}
        </Box>
      ))}

      <Box flexDirection="column" marginTop={1}>
        <Text bold>这一段时间你要做什么？</Text>
        <Box flexDirection="column" marginTop={1}>
          {snapshot.activities.length === 0 ? (
            <Text dimColor>（没有可用活动 — 时间会自动推进）</Text>
          ) : (
            hubView.sections.map((section) => (
              <Box key={section.category} flexDirection="column" marginBottom={1}>
                <Text bold color={section.availableCount > 0 ? "yellow" : "gray"}>
                  {section.label} · {section.availableCount}/{section.activities.length}
                  {hubView.decisionRequired &&
                  section.category === hubView.focusCategory
                    ? " · CHOICE"
                    : ""}
                </Text>
                {section.activities.map(({ activity, originalIndex }) => (
                  <ActivityRow
                    key={activity.id}
                    index={originalIndex + 1}
                    activity={activity}
                    selected={originalIndex === cursor}
                    primary={activity.id === hubView.primaryActivityId}
                  />
                ))}
              </Box>
            ))
          )}
        </Box>
      </Box>
    </Box>
  );
}

function StatRow({ stat }: { stat: StatSnapshot }) {
  const ratio = stat.max > 0 ? Math.max(0, Math.min(1, stat.value / stat.max)) : 0;
  const filled = Math.round(ratio * BAR_WIDTH);
  const bar = "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
  const color = colorFor(stat);
  const status = statusFor(stat);
  return (
    <Box flexDirection="row">
      <Box width={12}>
        <Text>{stat.name}</Text>
      </Box>
      <Text color={color}>{bar}</Text>
      <Box marginLeft={1}>
        <Text>
          {stat.value}/{stat.max}
        </Text>
      </Box>
      {status ? (
        <Box marginLeft={1}>
          <Text dimColor color={color}>
            {status}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

// Pick the threshold with the highest `min` that stat.value is at or above.
// Returns undefined when the stat has no thresholds declared or value is
// below every threshold's min.
function matchingThreshold(stat: StatSnapshot): StatThreshold | undefined {
  if (!stat.thresholds || stat.thresholds.length === 0) return undefined;
  let match: StatThreshold | undefined;
  for (const t of stat.thresholds) {
    if (stat.value >= t.min && (!match || t.min > match.min)) match = t;
  }
  return match;
}

function colorFor(stat: StatSnapshot): string {
  return matchingThreshold(stat)?.color ?? "white";
}

function statusFor(stat: StatSnapshot): string | null {
  const label = matchingThreshold(stat)?.label;
  return label && label.length > 0 ? label : null;
}

function ActivityRow({
  index,
  activity,
  selected,
  primary,
}: {
  index: number;
  activity: HubActivity;
  selected: boolean;
  primary: boolean;
}) {
  const color = !activity.available
    ? "gray"
    : selected
      ? "cyan"
      : undefined;
  // Locked rows keep the ⛔ marker; available rows show ▸ when selected
  // so the cursor reads at a glance even alongside locked siblings.
  const marker = activity.available
    ? selected
      ? "▸"
      : primary
        ? "★"
        : " "
    : "⛔";
  const hint = activity.effectsHint;
  const forecast = formatActivityForecast(activity);
  return (
    <Box flexDirection="row">
      <Text
        color={color}
        bold={selected && activity.available}
        dimColor={!activity.available}
      >
        {marker} {index}. {activity.title}
      </Text>
      {hint && activity.available ? (
        <Box marginLeft={1}>
          <Text dimColor>({hint})</Text>
        </Box>
      ) : null}
      {forecast && activity.available ? (
        <Box marginLeft={1}>
          <Text color="yellow">[{forecast}]</Text>
        </Box>
      ) : null}
      {!activity.available && activity.lockedReason ? (
        <Box marginLeft={1}>
          <Text dimColor>({activity.lockedReason})</Text>
        </Box>
      ) : null}
    </Box>
  );
}
