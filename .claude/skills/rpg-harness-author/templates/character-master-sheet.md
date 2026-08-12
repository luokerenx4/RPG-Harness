# Template: character master design sheet (v1)

The generic layout skeleton for a character's comprehensive design
sheet — ONE image holding everything downstream art derives from.
This template is the SOURCE; the composed prompt written into an
asset's `spec.yaml` is a build artifact. Record provenance in the
spec as `custom: { template: character-master-sheet-v1 }` so a later
template revision can find every spec compiled from it.

Why one sheet instead of separate turnaround / expression images:
serial generation drifts — each derived batch reinterprets the
character a little, and errors amplify layer by layer. Generating
all views/expressions/details in a single image forces one coherent
interpretation; finer split sheets are then derived FROM the master
(`style_ref: ../<id>-master`), not from text.

## Slots

- `{NAME}` — character name (romanized)
- `{ROLE_AND_ERA}` — one phrase, e.g. "a tall young spearwoman from the late Sengoku era"
- `{IDENTITY}` — compiled from the character's `## 外見` section: hair (color+style), eyes (shape+color), age, build, outfit, palette
- `{EXPRESSIONS}` — 4 labeled emotions chosen from the character's expression baseline (respect it: a stoic character's grid varies only in eyes/brows)
- `{DETAIL_CALLOUTS}` — signature weapon (full + close-up) and 3-5 accessories worth pinning (sash knots, guards, footwear, hair ornaments)

## Skeleton

```
Complete character design master sheet of {NAME}, {ROLE_AND_ERA},
everything on ONE sheet, model-sheet style with even lighting and a
clean flat background:
(a) full-body front view and back view, identical proportions;
(b) a row of head studies — front, three-quarter, profile;
(c) four small expression busts — {EXPRESSIONS};
(d) detail callouts — {DETAIL_CALLOUTS}.
{IDENTITY}
```

## Generation notes

- Attach the character's current approved anchor (portrait or prior
  master) with the identity-only instruction: references pin identity
  (face, age, hair, eyes, outfit, palette) — never pose, camera
  angle, or lighting.
- Landscape 16:9, opaque clean background. Verify the composed image
  actually contains all four zones before accepting.
- Enemy/creature design sheets use the same skeleton — swap (c) for
  threat poses or anatomy studies when expressions don't apply.
