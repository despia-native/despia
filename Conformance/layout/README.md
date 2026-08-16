# Adaptive scaffold conformance

`adaptive-shell.json` is the shared planning corpus for `<scaffold shell="automatic|native">`.
It fixes mode/collapse normalization, the `compactAt` breakpoint, column-width normalization,
required pane behavior, and the honest native-versus-semantic layout words.

Kotlin and TypeScript runners execute every case. The Swift privileged scaffold carries the same
table plus DEBUG-only edge probes because that component has no standalone unit-test bundle.
Renderer integration tests separately cover child partitioning: pins are removed first, an untagged
body child defaults to `content`, and traversal order is sidebar → content → inspector.

`native2`/`native3` may only be returned when the renderer has a real platform split host. Apple
maps those words to SwiftUI `NavigationSplitView`. Android, Compose Desktop, and Web pass
`nativeAvailable=false`, so their regular result is `split2`/`split3` and their default compact
result is `stack`; this is intentionally not a WinUI/GTK claim.
