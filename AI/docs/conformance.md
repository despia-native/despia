# Running the conformance corpus

The fixtures live in `conformance/ai` (in the published package) or
`OpenSource/Conformance/ai` (in the monorepo). One runner finds either.

```
node conformance/run.ts ai
```

Every lane runs these files in VERIFY mode. Nothing here records or regenerates
a fixture: they are hand-authored from the design and the runner's only job is
to agree or disagree. That is the inverse of the DSX `jse` corpus, which is
recorded from the Swift kernel - and it is deliberate, because these fixtures
describe what the system SHOULD do rather than what an implementation happens
to do today.

There is exactly one MockEngine: the C++ mock behind the C ABI, which the Swift
and Kotlin bindings load. The TypeScript mock is a subordinate port. If the two
disagree, the C++ one is right and the TypeScript one has a bug - which is why
both run the same files.

The C ABI has its own test below the corpus, covering what a fixture cannot see
from above (envelope shape, delta-only token events, cancel from inside the
callback, the bounded validator):

```
clang++ -std=c++17 -pthread -DDESPIA_AI_VERSION='"0.1.0"' \
  engine/src/context.cpp engine/src/api.cpp mock/mock_backend.cpp \
  engine/test/abi_test.cpp -o abi_test && ./abi_test
```

Real-model inference is never in these gates. It lives in a nightly smoke lane
against a digest-pinned tiny model, because a per-PR gate that downloads
gigabytes is a per-PR gate nobody keeps green.
