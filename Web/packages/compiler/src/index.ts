//
//  @despia-native/compiler - .dsx → IR, CSS emission, module registry (build time).
//  The web twin of prepare_config.rb + compile_dsx_css.rb + StackXML (/web/01).
//

export { parseDsx, DsxParseError, DSX_PARSE_LIMITS, type XmlNode, type XmlSpan } from "./xml.ts";
// The visual editor's DSX side (platform/00-vision.md M4): project a document into an editable
// tree, apply a closed set of edits by SPLICING the author's own bytes, never by re-printing.
// Exported so the hosted studio and `despia edit` share one engine — two would be two answers
// to "what did that edit do to my file".
export {
  applyEdits, projectTree, flattenTree, SurgeryError,
  type Edit, type NodePath, type TreeNode, type TreeRow, type SurgeryResult,
} from "./surgery.ts";
export {
  compileComponent, foldPlatformAttrs, subtreeReactive,
  type ComponentIR, type ComponentHead, type IRNode,
} from "./component.ts";
export {
  LAYER_STATEMENT, scopeSheet, CssCollector, extractComponentCss, type NodeCss,
} from "./css.ts";
export {
  mapStyleValue, parseStyleAttr, splitStyleAttr, legacyAttrToDecls, BRIDGE_ATTRS,
  type Decl,
} from "./cssmap.ts";
export { buildRegistry, type ModuleInput } from "./registry.ts";
export { resolveComponent, type Registry } from "./resolve.ts";
export {
  readUniversalLinks, linkPattern, linkPatterns, universalLinkFiles,
  type UniversalLinks, type UniversalLinksDeclaration, type AndroidTarget, type LinkFile,
} from "./universal-links.ts";
export {
  readPackageWeb, mergePackageRoutes, resolveWebManifests,
  type DsxJsonWeb, type PackageWeb, type RouteEntry, type WebManifestDiagnostics,
} from "./web-manifest.ts";
