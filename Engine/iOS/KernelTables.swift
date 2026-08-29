//
//  KernelTables.swift — the BUILD-TABLE SEAM (Phase K: the kernel as a package).
//
//  WHY THIS FILE EXISTS.
//
//  The kernel used to reference the app's generated registries BY NAME —
//  `GeneratedModuleSchemes`, `GeneratedConfigRaw`, `GeneratedStackComponents`, and four more.
//  Those symbols are emitted by `ClosedSource/scripts/prepare_config.rb` into
//  `ClosedSource/Registry/*.generated.swift`, which is APP code. So the kernel could only ever
//  compile INSIDE an assembled app: `swift build` on `OpenSource/Engine/Package.swift` failed
//  with "cannot find 'GeneratedStackComponents' in scope".
//
//  That is what made "one kernel, consumed by every surface" untrue in practice. A kernel that
//  cannot compile without the app is not a package — it is a folder the app happens to include,
//  which is why each surface carried its own copy. `ClosedSource/scripts/conformance/
//  RecordShims.swift` is the fossil evidence: the conformance runner had to hand-write fake
//  `Generated*` enums to get the kernel to build at all.
//
//  THE DIRECTION IS NOW INVERTED. The kernel declares empty tables; the BUILD fills them. That
//  is the same empty-seam discipline used for `RunnerScreenSeam`, `RepoSeam` and
//  `AppManifest.legacyOriginSource`: the kernel names the shape, never the filler.
//
//  This also settles a documented parity gap. `Module.boot()` noted that iOS registered
//  generated data "by direct reference … the Kotlin twin fills the same seam from
//  GeneratedModules.register()". The Kotlin twin had it right; iOS now matches it.
//
//  HOW IT IS FILLED, and why nothing has to remember to call anything:
//  the build emits ONE `DSXGeneratedTables` subclass, and the registry's existing
//  `objc_getClassList` walk finds it exactly the way it finds modules and components — the walk
//  that already runs at boot. An unfilled table is EMPTY, never stale, and empty is the honest
//  answer for a kernel embedded with no generated build (a conformance runner, a unit test, or
//  a downstream package consumer).
//

import Foundation

/// The build-time tables the kernel reads at runtime. Every member is empty until the assembled
/// build installs it, so the kernel links and runs standalone.
public enum KernelTables {

    // ── module identity (Registry/ModuleSchemes.generated.swift) ──────────────────────

    /// Swift class name → the module's declared scheme. Drives `Module.resolvedScheme`.
    public static var moduleSchemeByClassName: [String: String] = [:]

    /// Swift class name → the module's declared aliases.
    public static var moduleAliasesByClassName: [String: [String]] = [:]

    /// Identities that exist in the PRODUCT but not in this binary, with the reason — the
    /// build-visibility overlay (facet-contracts.md) that keeps `.excluded` honest.
    public static var excludedIdentities: [String: [String: String]] = [:]

    // ── declared config + state (the same generated source, two readers) ──────────────

    /// scheme → the module's declared `config.json` values, as plain data.
    public static var configByScheme: [String: [String: Any]] = [:]

    /// scheme → declared context/state variables → their descriptors.
    public static var stateByScheme: [String: [String: [String: Any]]] = [:]

    // ── the full-catalog platform map (the graceful `unsupported_platform` answer) ────

    /// scheme → the platforms that module supports, for every module in the PRODUCT.
    public static var platformSupportByScheme: [String: [String]] = [:]

    /// "<scheme>.<action>" → the platforms THAT ACTION supports, for every action whose
    /// manifest NARROWS its module's set (X2 §4 `platforms`). Sparse on purpose: an action
    /// with no narrowing has no row and inherits its module's, so the common case costs
    /// nothing and the table names exactly the claims someone had to justify in writing.
    public static var platformSupportByAction: [String: [String]] = [:]

    // ── delegate policy (a module's dsx.json `delegate` block) ────────────────────────

    /// The declared combine policy for an event. `JSON` is a kernel type, so this shape can
    /// live here without the kernel learning anything about the generator.
    public struct DelegateSpec {
        public let combine: String
        public let async: Bool
        public let fallback: JSON?
        public init(combine: String, async: Bool, fallback: JSON?) {
            self.combine = combine
            self.async = async
            self.fallback = fallback
        }
    }

    /// event name → its declared delegate policy.
    public static var delegateByEvent: [String: DelegateSpec] = [:]

    // ── action gates ──────────────────────────────────────────────────────────────────

    /// scheme → action → the gate event that action declares.
    public static var actionGatesByScheme: [String: [String: String]] = [:]

    /// The gate event declared for `<scheme>.<action>`, or nil when the action is ungated.
    public static func actionGate(scheme: String, action: String) -> String? {
        actionGatesByScheme[scheme]?[action]
    }

    // ── Stack components (each package's Components/*.dsx, compiled at build time) ────

    /// (component name, owning package scheme — nil = global, XML template).
    public static var stackComponents: [(name: String, scheme: String?, xml: String)] = []
}

/// The base the BUILD subclasses to install its tables.
///
/// `ModuleRegistry`'s class walk discovers this subclass the same way it discovers modules and
/// components — no registration call, no import, no ordering for anyone to get wrong. The walk
/// installs tables BEFORE it registers any module, because a module's `resolvedScheme` reads
/// `KernelTables.moduleSchemeByClassName` the moment it registers.
///
/// Exactly one subclass is expected. The kernel does not care which, or that there is one at
/// all: with none, every table stays empty and the kernel behaves as an unassembled kernel.
open class DSXGeneratedTables: NSObject {
    /// Fill `KernelTables`. Called once, at boot, before any module registers.
    open class func install() {}
}
