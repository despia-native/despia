import Foundation
#if canImport(DSXObjCExceptionShim)
import DSXObjCExceptionShim   // the SPM face (Engine/Package.swift): the trampoline as a C target
#endif

/// Kernel primitive: run an Objective-C API that may raise an NSException
/// (which Swift cannot catch) on untrusted input, getting `nil` instead of
/// a process crash. Backed by the `DSXCatchReturning` trampoline exposed
/// through the Runtime bridging header (`DSXObjCException.h`) in-app, or by
/// the `DSXObjCExceptionShim` C target when built as the DSX package.
///
/// This names no package — it is a generic runtime primitive, so it lives
/// in the kernel per the constitution's "primitives only" rule.
enum ObjCException {

    /// Returns the object produced by `body`, or `nil` if `body` raised an
    /// Objective-C `NSException`. Use for the narrow set of Cocoa APIs that
    /// throw uncatchable-from-Swift exceptions on bad input — e.g.
    /// `ObjCException.catching { HKUnit(from: untrustedString) }`.
    static func catching<T: AnyObject>(_ body: @escaping () -> T?) -> T? {
        return DSXCatchReturning({ body() }, nil) as? T
    }
}
