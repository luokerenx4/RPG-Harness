import React from "react";
import type { MapFacing } from "@rpg-harness/engine";
import "./MapFacingControl.css";

export interface MapFacingControlProps {
  value?: MapFacing;
  onChange: (value?: MapFacing) => void;
}

export interface MapFacingPresentation {
  readonly value?: MapFacing;
  readonly key: MapFacing | "none";
  readonly label: string;
  readonly shortLabel: string;
  readonly glyph: string;
  readonly title: string;
  readonly description: string;
}

const DIRECTION_PRESENTATIONS: Readonly<Record<MapFacing, MapFacingPresentation>> = {
  north: {
    value: "north",
    key: "north",
    label: "North",
    shortLabel: "N",
    glyph: "↑",
    title: "Face north",
    description: "Up on the map",
  },
  east: {
    value: "east",
    key: "east",
    label: "East",
    shortLabel: "E",
    glyph: "→",
    title: "Face east",
    description: "Right on the map",
  },
  south: {
    value: "south",
    key: "south",
    label: "South",
    shortLabel: "S",
    glyph: "↓",
    title: "Face south",
    description: "Down on the map",
  },
  west: {
    value: "west",
    key: "west",
    label: "West",
    shortLabel: "W",
    glyph: "←",
    title: "Face west",
    description: "Left on the map",
  },
};

const NONE_PRESENTATION: MapFacingPresentation = {
  value: undefined,
  key: "none",
  label: "None",
  shortLabel: "—",
  glyph: "·",
  title: "Clear authored facing",
  description: "Use the renderer default",
};

/** Shared labels and glyphs for Studio controls, map markers, and previews. */
export function mapFacingPresentation(value?: MapFacing): MapFacingPresentation {
  return value === undefined ? NONE_PRESENTATION : DIRECTION_PRESENTATIONS[value];
}

const MAP_FACING_DPAD_CHOICES: readonly MapFacingPresentation[] = [
  DIRECTION_PRESENTATIONS.north,
  DIRECTION_PRESENTATIONS.west,
  NONE_PRESENTATION,
  DIRECTION_PRESENTATIONS.east,
  DIRECTION_PRESENTATIONS.south,
];

export function MapFacingControl({ value, onChange }: MapFacingControlProps) {
  const current = mapFacingPresentation(value);

  return (
    <fieldset className="map-facing-control" data-facing={current.key}>
      <legend>Facing direction</legend>
      <div className="map-facing-dpad">
        {MAP_FACING_DPAD_CHOICES.map((choice) => {
          const selected = choice.value === value;
          return (
            <button
              type="button"
              className={`map-facing-option direction-${choice.key}${selected ? " selected" : ""}`}
              data-facing={choice.key}
              aria-label={choice.title}
              aria-pressed={selected}
              title={choice.title}
              key={choice.key}
              onClick={() => onChange(choice.value)}
            >
              <span aria-hidden="true">{choice.glyph}</span>
              <small>{choice.shortLabel}</small>
            </button>
          );
        })}
      </div>
      <output className="map-facing-current" role="status" aria-live="polite" aria-atomic="true">
        <small>CURRENT DIRECTION</small>
        <strong><i aria-hidden="true">{current.glyph}</i>{current.label}</strong>
        <span>{current.description}</span>
      </output>
    </fieldset>
  );
}
