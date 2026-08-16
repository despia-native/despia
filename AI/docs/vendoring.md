# Vendoring

`vendor/` carries pruned, pinned copies of three upstream trees: **ggml**, **llama.cpp** and
**whisper.cpp**. `vendor/VERSIONS` is the pin record - the commit, the licence and the upstream
URL for each. This page is the how and the why: the import procedure, exactly what was pruned,
exactly what was patched, and how to check that the trees on disk are still what this page says
they are.

Three claims hold the whole arrangement up, and each is checked rather than asserted:

1. **One shared ggml.** llama.cpp and whisper.cpp each bundle their own copy. Vendoring both
   as-is means duplicate tensor symbols and a doubled binary.
2. **Permissive only.** Every pin is MIT. `ai_package_gate.rb` fails on a copyleft licence id.
3. **Two patches, both narrow, both recorded.** Everything else in `vendor/` is upstream source
   byte-for-byte, so a reader can diff it against the pinned commit and get a two-file answer.

The trees are **committed, not fetched at sync**. SPM builds them as source targets, and a source
target has to exist in the mirror repository at the tag a consumer resolves - `swift package
resolve` has no fetch step that could pull them in. The cost is ~9.4 MB in the repo (ggml 5.1 MB,
llama.cpp 3.7 MB, whisper.cpp 0.6 MB); the alternative is a package that cannot be installed.

---

## The two patches

**Exactly two files in `vendor/` differ from their pinned upstream.** Both carry a
`DESPIA VENDOR PATCH (n of 2)` marker at the edit, so a reader who lands in the file - rather
than in this page - still learns that it is not upstream.

### 1 of 2 - `vendor/llama.cpp/cmake/common.cmake`

The de-duplication's only edit to llama.cpp. Upstream reads its compile-flag helpers out of its
OWN bundled `ggml/`; that copy was deleted at import, so the include is re-pointed at the single
shared tree.

```cmake
-include("ggml/cmake/common.cmake")
+include("${CMAKE_CURRENT_LIST_DIR}/../../ggml/cmake/common.cmake")
```

It is written relative to `CMAKE_CURRENT_LIST_DIR` rather than to the source root on purpose: the
same file has to resolve whether CMake entered the tree from `OpenSource/AI/CMakeLists.txt` or
from a consumer's own `add_subdirectory`.

### 2 of 2 - `vendor/ggml/CMakeLists.txt`

The build stamp. Vendored, `git rev-parse HEAD` inside `vendor/ggml/` answers with the
**embedding** repository's commit - so the library self-reported a version string with no
relationship to the code in it, and flipped to `-dirty` on any unrelated edit anywhere in the
Despia repo.

```cmake
 find_program(GIT_EXE NAMES git git.exe NO_CMAKE_FIND_ROOT_PATH)
-if(GIT_EXE)
+if(GIT_EXE AND NOT GGML_BUILD_COMMIT)
```

An embedder that already knows the pin passes it in and the git probe is skipped; without one,
upstream behaviour is unchanged. `OpenSource/AI/CMakeLists.txt` sets `GGML_BUILD_COMMIT` from the
first eight hex characters of the ggml line in `vendor/VERSIONS`, which makes that file the
single source of truth for what the library says it is as well as for what is vendored.

**`vendor/whisper.cpp` is unpatched.** All 21 of its vendored files are byte-identical to the pin.

---

## What is pruned

Pruning removes tests, examples, tooling, bindings for other languages, and backends for hardware
no Despia target has. It never edits the code that ships - a pruned tree is a subset of upstream,
not a variant of it.

### ggml - 100 files kept of 2,139

Kept: `CMakeLists.txt`, `LICENSE`, `cmake/`, `include/`, and `src/` reduced to the core plus the
three backends this package ships - **ggml-cpu**, **ggml-metal** (Apple GPU) and **ggml-blas**
(Accelerate on Apple).

Removed backends (15): `ggml-cann`, `ggml-cuda`, `ggml-et`, `ggml-hexagon`, `ggml-hip`,
`ggml-musa`, `ggml-opencl`, `ggml-openvino`, `ggml-rpc`, `ggml-sycl`, `ggml-vulkan`,
`ggml-virtgpu`, `ggml-webgpu`, `ggml-zdnn`, `ggml-zendnn`.

Removed inside `src/ggml-cpu/`:

- `kleidiai/` - its CMake **downloads a tarball from the network at configure time**, which a
  vendored offline build cannot have and a reproducible one should not want.
- `spacemit/` - RISC-V vendor kernels.
- `arch/{loongarch,powerpc,riscv,s390,wasm}` - no Despia target platform is any of those.
  `arch/arm` and `arch/x86` stay.

Also removed: `examples/`, `tests/`, `scripts/`, `ci/`, `docs/`, `.github/`, `ggml.pc.in`,
`requirements.txt` and the repo-meta files.

**Where the bytes came from.** The tree was copied from **llama.cpp's `ggml/` subtree at the
llama pin**, not from `ggml-org/ggml` directly - upstream llama had synced from ggml at exactly
the pinned ggml commit, and whisper.cpp's bundled copy was synced from the SAME commit, so the
de-duplication needed no version reconciliation at all. Against `ggml-org/ggml` at the pin, one
further file differs - `src/ggml-cpu/ggml-cpu.cpp` - because llama's copy additionally supports
`GGML_OP_CONV_2D`. llama's copy is a superset, which is why it is the one vendored. `LICENSE`
comes from `ggml-org/ggml` (llama's `ggml/` subtree has none of its own) and is byte-identical to
the pin.

### llama.cpp - 217 files kept of 3,310

Kept: `CMakeLists.txt`, `LICENSE`, `cmake/`, `include/`, `src/`.

Removed: its bundled `ggml/` (the shared one is used), `common/`, `tools/`, `app/`, `examples/`,
`pocs/`, `tests/`, `benches/`, `ci/`, `docs/`, `models/`, `grammars/`, `media/`, `scripts/`,
`skills/`, `conversion/`, `gguf-py/`, the Python conversion scripts and their requirements,
`.devops/`, `.github/`, `Makefile`, `flake.nix`, `CMakePresets.json` and the repo-meta markdown.

`vendor/` goes too - upstream's own vendored dependencies (cpp-httplib, miniaudio, nlohmann,
sheredom, stb), every one of them reachable only from `common/`, `tools/` or `examples/`. Nothing
under the kept `src/` or `include/` references any of them, which is why the build links with the
directory absent. `licenses/LICENSE-jsonhpp` goes with them: it covers a dependency that is no
longer here.

`LLAMA_BUILD_MTMD` (`tools/mtmd`, the multimodal projector library) is OFF and its sources are
NOT vendored. **W-SEE re-imports that subtree when it needs it** - that is a real import with its
own pin bump, not a flag flip.

### whisper.cpp - 21 files kept of 2,039

Kept: `CMakeLists.txt`, `LICENSE`, `cmake/`, `include/`, `src/`.

Removed: its bundled `ggml/`, `bindings/` (Go, Java, JavaScript, Ruby), `examples/`, `tests/`,
`models/`, `samples/`, `scripts/`, `ci/`, `media/`, `grammars/`, `.devops/`, `.github/`,
`Makefile`, `CMakePresets.json` and the repo-meta markdown. Inside `src/`: `openvino/` and
`coreml/` - both behind CMake options that are OFF, and both needing an SDK this package does not
carry.

`src/parakeet.cpp` and `src/parakeet-arch.h` - a second ASR model - are **left on disk but never
compiled**. Deleting them would mean patching two upstream CMake files, and a patch is more
expensive to carry than a file that no target references. The top-level build names this
explicitly so nobody "fixes" the vendored CMake into building it.

---

## Importing or bumping a pin

Unpinned is chaos and frozen is rot, so pins move - through a bump PR that runs the full gate set.

1. **Choose the commit.** ggml is the constraint: llama.cpp and whisper.cpp must be at revisions
   that were synced from the SAME ggml commit, or the bump turns into a reconciliation. This is
   why the current whisper pin is a plain commit rather than a release tag - `v1.9.1` carried an
   older ggml.
2. **Fetch it, at that exact commit**, into a scratch directory:
   ```sh
   git init upstream && cd upstream
   git remote add origin https://github.com/ggml-org/llama.cpp
   git fetch --depth 1 origin <commit> && git checkout FETCH_HEAD
   ```
3. **Replace the tree wholesale** - delete `vendor/<name>/` and copy in only the kept paths above.
   Editing in place is how a stale file survives a bump.
4. **Delete the bundled `ggml/`** from llama.cpp and whisper.cpp. Neither guards its own copy
   behind a target check for your benefit; they bind to ours because ours is added first and
   theirs is not on disk. If the ordering in `OpenSource/AI/CMakeLists.txt` is ever broken, the
   vendored CMake fails loudly on a missing `ggml/` directory instead of quietly building two.
5. **Re-apply the two patches** above, markers included.
6. **Update `vendor/VERSIONS`** (commit, licence, URL, and the per-pin prune/patch notes) and
   `NOTICE` (attribution and the pinned commit). Both are gated: `ai_package_gate.rb` fails a
   `vendor/<name>/` directory that has no pin or no NOTICE entry.
7. **Verify the diff is exactly the two patches** - see below.
8. **Run the gates.**

```sh
cd OpenSource/AI && cmake -S . -B build && cmake --build build -j && ./build/abi_test
ruby ClosedSource/scripts/ai_package_gate.rb
ruby ClosedSource/scripts/check_ai_size.rb --strict
ruby ClosedSource/scripts/check_dependency_licenses.rb --public-release
```

A pin bump is also a **size** event and a **symbol** event, which is why `check_ai_size.rb` is on
that list: it rebuilds the library, strips it, compresses it, holds it against the core's 8 MB
budget, and re-checks that `libdespia_ai.so` still exports the eleven `despia_ai_*` symbols and
nothing else - with no `ggml_*`, `llama_*` or `whisper_*` in the dynamic table in either
direction. An upstream that starts forcing default visibility on a symbol shows up there.

## Verifying the trees against their pins

The point of "pruned, otherwise unmodified" is that anyone can check it. Fetch each pin as in
step 2, then compare every vendored file against its upstream counterpart:

```sh
ruby -rdigest -e '
  vend, up = ARGV
  Dir.glob(File.join(vend, "**", "*")).select { |p| File.file?(p) }.sort.each do |p|
    rel = p.sub("#{vend}/", "")
    u = File.join(up, rel)
    next puts("NOT UPSTREAM  #{rel}") unless File.exist?(u)
    next if Digest::SHA256.file(p).hexdigest == Digest::SHA256.file(u).hexdigest
    puts "DIFFERS       #{rel}"
  end' vendor/llama.cpp ../upstream/llama.cpp
```

The expected output, at the pins recorded in `vendor/VERSIONS`:

| tree | compared against | files | differs |
|---|---|---|---|
| `vendor/ggml` | llama.cpp@pin `ggml/` | 100 | `CMakeLists.txt` (patch 2 of 2) - plus `LICENSE`, which llama's subtree does not carry |
| `vendor/ggml` | ggml@pin | 100 | `CMakeLists.txt` (patch 2 of 2), `src/ggml-cpu/ggml-cpu.cpp` (llama's superset - see above) |
| `vendor/llama.cpp` | llama.cpp@pin | 217 | `cmake/common.cmake` (patch 1 of 2) |
| `vendor/whisper.cpp` | whisper.cpp@pin | 21 | none |

Anything else in that output is an undocumented local edit, and it is a bug in either the tree or
this page. Fix whichever is wrong - do not add a row to make the table match the tree.

## Adding a fourth tree

The voice child's runtime (sherpa-onnx and friends) is the next candidate, and it is the reason
the copyleft rule is written down rather than assumed: the sherpa-onnx TTS path for the Kokoro and
Piper voice families phonemizes through **espeak-ng (GPL-3.0)**, which can never ship inside an
Apache-2.0 package whose whole promise is unrestricted commercial use by the apps that embed it.
A new tree enters only with the full transitive audit of its build graph done first - every
dependency, its licence, and a permissive path or replacement for anything that fails. That audit
is an entry gate, not a follow-up.

Practically, a fourth tree also means: its own line in `vendor/VERSIONS`, its own `NOTICE`
paragraph, its own section here, and - if it produces a shipping artifact - its own **named size
budget** in `check_ai_size.rb`. The core's 8 MB deliberately does not cover a child; a child with
no budget of its own is how a small core stops being small.
