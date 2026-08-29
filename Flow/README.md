# Flow

The flow-canvas library for DSX: a pannable, zoomable, fitted-by-default viewport for
node-and-edge surfaces. Written entirely in DSX markup, no script payload, one
implementation for every renderer.

## What it owns, and what it refuses to own

`<Flow>` owns the VIEWPORT and nothing else:

- the dot-grid background;
- the pan surface (a sibling behind the content, never an ancestor - a drag recognizer
  captures the pointer, and a captured pointer retargets the click that follows it, so a
  pan layer wrapping the nodes makes every node unclickable);
- the world transform;
- the fitted-until-touched contract: the viewport opens fitted to the content WIDTH and
  stays derived until the person pans or zooms, so no fit can ever race a container
  measurement (there is no fit event to race);
- the zoom cluster (in, out, and the percent readout that is also the fit button).

Your nodes, your edges, your panels, your meaning. Content passed as children renders
inside the world, in YOUR data scope, positioned in world coordinates. Content marked
`slot="chrome"` floats above the viewport and does not pan.

## Use

```xml
<Flow contentWidth="{{ graph.width }}" contentHeight="{{ graph.height }}" minZoom="0.2">
  <!-- world: position absolutely in content coordinates -->
  <list bind="nodes" key="id" scroll="false" class="my-nodes"
        style="position: absolute; left: 0px; top: 0px; width: {{ graph.width }}px; height: {{ graph.height }}px">
    <pressable style="position: absolute; left: {{ item.x }}px; top: {{ item.y }}px">…</pressable>
  </list>

  <!-- chrome: fixed over the viewport -->
  <stack slot="chrome" class="my-panel" style="position: absolute; top: 16px; right: 16px">…</stack>
</Flow>
```

| Attribute | Default | Meaning |
|---|---|---|
| `contentWidth` / `contentHeight` | required | the content extent, in world units |
| `insetLeading` | `0` | px reserved at the leading edge for a floating panel; fit and centering clear it |
| `insetTop` | `76` | where the world's top edge rests, clearing floating chrome |
| `minZoom` | `0.2` | the fit floor and the zoom-out floor |

Why the fit is to WIDTH: a flow is usually deep and narrow - a funnel is six screens tall
and one wide - so fitting both axes divides by the height and opens the map as a postage
stamp in a sea of empty pane. A flow is a tall document: fit what makes it readable
across, cap at 100%, and let the reader scroll the length of it.

## Licence

Apache-2.0. The LICENSE file travels with this folder.

## Connector

`<Connector points="{{ edge.points }}" ink="accent" width="1.5" radius="10" arrow="end"/>`

The wire: one rounded orthogonal path with an arrowhead, as markup. Hand it a polyline in
world coordinates; it sizes itself to the path's bounding box, rounds every elbow with a
true arc (short segments shorten their own radius), points the arrowhead along the final
segment, and inks with a theme word so light, dark and brand layers follow. `arrow="none"`
leaves a plain wire.
