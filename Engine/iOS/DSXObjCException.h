#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Runs `block` and returns its result, or nil if it raised an
/// Objective-C NSException (e.g. the NSInvalidArgumentException thrown by
/// `HKUnit(from:)` on a malformed unit string, which Swift cannot catch
/// with `do`/`catch`). A kernel primitive: it names no package and exists
/// solely so Swift can call exception-throwing Objective-C APIs on
/// untrusted input without crashing the process. When `block` raises and
/// `error` is non-NULL, `*error` is populated from the exception.
FOUNDATION_EXPORT id _Nullable DSXCatchReturning(id _Nullable (^block)(void),
                                                 NSError * _Nullable * _Nullable error);

NS_ASSUME_NONNULL_END
