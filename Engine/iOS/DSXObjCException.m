#import "DSXObjCException.h"

id _Nullable DSXCatchReturning(id _Nullable (^block)(void),
                               NSError * _Nullable * _Nullable error) {
    @try {
        return block();
    }
    @catch (NSException *exception) {
        if (error != NULL) {
            *error = [NSError errorWithDomain:@"DSXObjCException"
                                         code:0
                                     userInfo:@{ NSLocalizedDescriptionKey:
                                                   (exception.reason ?: exception.name ?: @"Objective-C exception") }];
        }
        return nil;
    }
}
