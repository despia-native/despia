//
//  The MCP Apps entry (@despia/kernel/mcp) — a SUBPATH on purpose.
//
//  Views are one surface among several, and the embed slice is budgeted to the byte (the
//  40,960-byte G10 widget law, bought by proving absence). Re-exporting this from the
//  package root put 199 bytes of view protocol into every EmbedCard that will never render
//  one. A subpath is how @despia/dom already keeps `scene` and `media-surfaces` out of the
//  default entry; this follows that discipline rather than spending the reserve.
//
export {
  createAppBridge,
  type AppBridge, type AppBridgeOptions, type AppFrame, type AppToolResult,
  type AppToolInput, type AppHostContext,
} from "./mcp/apps.ts";
export {
  uiResourceUri, hostSupportsUi, uiToolMeta, fallbackText, mcpToolResult,
  UI_SCHEME, UI_MIME, UI_CAPABILITY,
  type UiMeta, type UiCsp, type UiVisibility, type CallToolResult, type ToolContent,
} from "./mcp/result.ts";
