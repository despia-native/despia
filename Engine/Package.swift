// swift-tools-version: 5.9
//
//  The DSX kernel as a Swift Package — the kernel-distribution face (one
//  version source, Engine/VERSION, shared with the Maven and npm faces).
//  Built FROM this
//  tree — the monorepo stays canonical, never a fork. The Runtime consumes it
//  as a LOCAL package in the monorepo (Xcode local-package precedence keeps
//  the dev loop byte-identical) and as the pinned published artifact in the
//  release CI lane — the dogfood law: Despia imports DSX.
//
//  BUILDS. Verified on this machine with Swift 6.3.3:
//      xcodebuild -scheme DSX -destination 'generic/platform=iOS' build
//  (`swift build` alone targets the macOS host and cannot see UIKit — this is
//  an iOS package; build it for iOS.) `scripts/kernel_package_test.rb` is the
//  gate that keeps it building.
//
//  What it took to get here, and what must stay true:
//    1. The two-target split resolves — the ObjC trampoline as a C target
//       beside the Swift kernel, disjoint sources in one folder.
//    2. THE KERNEL NAMES NO GENERATED SYMBOL. It used to reference the app's
//       `Generated*` registries directly, so it could only compile inside an
//       assembled app — the concrete reason every surface vendored a copy
//       instead of consuming one package. Those are now empty tables the build
//       fills through a seam (iOS/KernelTables.swift). Reintroducing a
//       reference to app-generated code breaks the package; the gate catches it.
//    3. Platform floor: .iOS("16.6"), aligned to the Runtime's
//       IPHONEOS_DEPLOYMENT_TARGET. The previous .v15 was aspirational — the
//       kernel already used iOS 16 API unguarded (StackLive's timer Text), so
//       nothing had ever built it at 15.
//  Version: git tags, anchored to Engine/VERSION (one source with the Maven
//  and npm faces — `scripts/kernel_version_gate.rb` asserts the three agree).
//
import PackageDescription

let package = Package(
    name: "DSX",
    platforms: [.iOS("16.6")],
    products: [
        .library(name: "DSX", targets: ["DSX"]),
    ],
    targets: [
        // The NSException trampoline (DSXCatchReturning) — Swift cannot catch
        // ObjC exceptions, so the kernel carries this one C target. In-app the
        // Runtime bridging header plays this role; the package spells it as a
        // module (ObjCException.swift imports it behind `canImport`).
        .target(
            name: "DSXObjCExceptionShim",
            path: "iOS",
            sources: ["DSXObjCException.m"],
            publicHeadersPath: "."
        ),
        .target(
            name: "DSX",
            dependencies: ["DSXObjCExceptionShim"],
            path: "iOS",
            // The conformance host is a simulator recorder, not runtime API.
            // It deliberately imports closed-source qualification policies and
            // is compiled by record_jse_conformance.sh with that source closure.
            exclude: ["ConformanceHosts.swift", "DSXObjCException.h", "DSXObjCException.m"]
        ),
    ]
)
