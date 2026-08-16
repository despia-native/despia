import Foundation

/// Kernel diagnostic log — PRINTED only in DEBUG builds (shipping consoles stay clean), and
/// CAPTURED into the in-memory `KernelLogBuffer` on armed installs. TestFlight/ad-hoc builds
/// are RELEASE builds, so without the capture every kernel diagnostic (a malformed-DSX parse
/// error, a routing no-op, a gate denial) is invisible on exactly the builds QA runs — no
/// console, no Xcode. The buffer feeds the on-device debug drawer (Diagnostics.swift). The
/// app target arms it at boot on TEST channels only; production installs never capture.
/// Names no package, so it is a pure kernel primitive per the constitution.
@inline(__always) func kernelLog(_ items: Any..., separator: String = " ") {
    let line = items.map { "\($0)" }.joined(separator: separator)
    #if DEBUG
    Swift.print(line)
    #endif
    KernelLogBuffer.shared.append(line)   // no-op until armed (test channels, app target only)
}

/// The in-memory tail of kernel diagnostics. SELF-CONTAINED (references no other engine file),
/// so KernelLog.swift stays mirrorable into extension targets (add_core_sources) exactly as
/// before. Capture is OFF until `arm()` — extension targets and production installs never arm
/// it, so they never buffer a byte.
public final class KernelLogBuffer {
    public static let shared = KernelLogBuffer()
    private init() {}

    private let lock = NSLock()
    private var armed = false
    private var lines: [String] = []
    private static let cap = 600   // ring: keep the newest tail, drop the oldest

    /// Arm capture (the app target, at boot, on test channels only). Idempotent.
    public func arm() { lock.lock(); armed = true; lock.unlock() }

    func append(_ line: String) {
        lock.lock(); defer { lock.unlock() }
        guard armed else { return }
        lines.append(Self.stamp() + " " + line)
        if lines.count > Self.cap { lines.removeFirst(lines.count - Self.cap) }
    }

    /// The captured tail, oldest → newest. Empty when never armed (production / extensions).
    public func snapshot() -> [String] { lock.lock(); defer { lock.unlock() }; return lines }

    private static let clock: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss.SSS"
        return f
    }()
    private static func stamp() -> String { clock.string(from: Date()) }
}
