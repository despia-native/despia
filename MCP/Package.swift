// swift-tools-version: 5.9
//
// Despia MCP - the SPM face.
//
// Package.swift sits at the package ROOT because SPM resolves from the
// repository root, and this folder is what the public mirror publishes. No
// `unsafeFlags` anywhere: SPM refuses versioned consumption of a package that
// uses them, which would silently kill every tagged install.
//
// ONE product. The client and the local server are not separable the way the
// voice engine is separable from Despia AI: they share the tool registry, the
// schema derivation and the session token, and an app that wants only one of
// them excludes the WRAPPER MODULE (`Core/MCP`), which is where exclusion
// belongs. Splitting the package would put a second exclusion plane under the
// first one for no size win.
//
// The dependency is the official MCP Swift SDK, pinned EXACTLY. `.exact` and
// not `.upToNextMinor`: this protocol has already changed its transport and its
// authorization story once, so a bump is a reviewed event with a conformance
// run behind it, never something a resolver decides on a Tuesday.
//
// Platform floor comes from the SDK (iOS 16 / macOS 13). Raising ours below
// that would produce a resolution error at install time rather than a readable
// requirement here.

import PackageDescription

let package = Package(
    name: "DespiaMCP",
    platforms: [
        .iOS(.v16),
        .macOS(.v13),
    ],
    products: [
        .library(name: "DespiaMCP", targets: ["DespiaMCP"]),
    ],
    dependencies: [
        .package(
            url: "https://github.com/modelcontextprotocol/swift-sdk.git",
            exact: "0.12.1"
        ),
    ],
    targets: [
        .target(
            name: "DespiaMCP",
            dependencies: [
                .product(name: "MCP", package: "swift-sdk"),
            ],
            path: "bindings/swift/Sources/DespiaMCP"
        ),
        .testTarget(
            name: "DespiaMCPTests",
            dependencies: ["DespiaMCP"],
            path: "bindings/swift/Tests/DespiaMCPTests"
        ),
    ]
)
