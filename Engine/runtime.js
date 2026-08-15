//
//  runtime.js
//  DespiaScript
//
//  Despia LLC-FZ
//  Meydan Grandstand, 6th Floor, Meydan Road,
//  Nad Al Sheba, Dubai, United Arab Emirates
//  support@despia.com
//
//  This installs the MODERN page surface of the DSX bus — ONE API, ONE syntax, ONE mental
//  model on every surface: the page inside DSXWebView spells calls exactly like DSX markup
//  and native module code do.
//
//    window.dsx — THE surface (dot notation IS the API):
//      dsx.module.<scheme>.<action>({ args }, onEvent?)   the call root (promise / stream)
//      dsx.log(...)                                        the unified console primitive
//      dsx.error(code, { message, recoverable, data })     the ambient error emission
//      dsx.global.get/set/watch(path)                      the app-wide reactive store
//      dsx.on(scheme, handler)                             out-of-band module events
//      dsx.has(nameOrScheme)                               capability detection
//
//  Three call shapes, all on dsx.module.<scheme>.<action>:
//    1. Fire and forget    dsx.module.haptic.light()
//    2. Resolve once        const r = await dsx.module.device.info()
//    3. Subscribe to a      const s = dsx.module.location.watch({}, onEvent)
//       stream              s.stop()
//
//  Files and Blobs upload themselves and travel as URLs.
//
//  THE WIRE — window.__dsxWire, the STRUCTURED transport the native runtime injects at
//  document start (frozen + non-configurable: page code can neither replace the carrier
//  nor steal its members). This engine binds the ONE inbound delivery sink onto it
//  (`wire.bind(deliver)` — first-bind-wins, and this script runs before any page
//  script, so the engine always wins the race); native delivers every result / event /
//  broadcast envelope through `window.__dsxWire.proxy(payload)`.
//
//  LEGACY IS NOT HERE. The old alias surface (window.despia) and every scheme-string
//  call form are owned by an excludable compat module whose GENERATED shim consumes the
//  PUBLIC window.dsx surface below — one pending-call registry, one delivery sink, no
//  privileged handle, never a second bridge. A build that excludes that module ships
//  only window.dsx; nothing in this file changes either way. See
//  OpenSource/Documentation/legacy.md + architecture/proposals/legacy-package.md.

(function () {
    // The modern wire the native transport injects (Dom's transport script — frozen,
    // non-configurable). Absent only on a broken install; window.dsx still defines,
    // and its calls then reject/no-op instead of throwing into page code.
    var wire = (typeof window !== 'undefined') ? window.__dsxWire : undefined;
    var caps = (wire && wire.capabilities) || {};

    // The MODERN protocol lives HERE: the pending-call registry + the scheme→listeners
    // map backing dsx.on. ONE engine — when the Core/Legacy shim installs window.despia
    // it binds to THESE structures through the wire's engine handle, so a despia call
    // and a dsx call settle through the same registry and the same delivery sink.
    var pending = {};
    var listeners = {};

    function genId() {
        return 'r_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    }

    // Pick the native-provided, capability-authenticated upload endpoint. The descriptor is
    // hydrated only into a first-party main frame; loopback pages also hold an HttpOnly Strict
    // cookie. A present descriptor with an empty upload endpoint is an explicit platform denial
    // (Android WebView does not expose custom-scheme POST bodies), never a fallback attempt.
    function uploadDescriptor() {
        var value = (typeof window !== 'undefined') ? window.__dsxLocalServer : undefined;
        return (value && typeof value === 'object') ? value : undefined;
    }

    function uploadEndpoint() {
        var descriptor = uploadDescriptor();
        if (descriptor && typeof descriptor.upload === 'string' && descriptor.upload) {
            return descriptor.upload;
        }
        if (descriptor) { return null; }
        if (location.protocol === 'https:') { return 'cdn:/api/file/upload'; }
        return window.__nativeUpload || window.__despiaUpload || '/api/file/upload';
    }

    // Stream a File/Blob to native via multipart FormData. The browser
    // streams the bytes straight off disk - they never become a base64
    // string, so the WKWebView heap stays flat no matter how big the file
    // is. Native writes it to the LocalCDN bucket and returns a URL that's
    // loadable from the current origin. `onProgress(0..100)` via XHR.
    var PAYLOAD_CANCELLED = { event: 'error', code: 'cancelled' };

    function removeUpload(call, xhr) {
        if (!call || !call.uploads) { return; }
        var index = call.uploads.indexOf(xhr);
        if (index !== -1) { call.uploads.splice(index, 1); }
    }

    function cancelUploads(call) {
        if (!call) { return; }
        call.payloadCancelled = true;
        var uploads = (call.uploads || []).slice();
        call.uploads = [];
        for (var i = 0; i < uploads.length; i++) {
            try { uploads[i].abort(); } catch (e) {}
        }
    }

    function streamUpload(file, onProgress, call) {
        return new Promise(function (resolve, reject) {
            if (!call || call.payloadCancelled) { reject(PAYLOAD_CANCELLED); return; }
            var endpoint = uploadEndpoint();
            if (!endpoint) {
                reject({ event: 'error', code: 'upload_unsupported', data: {
                    message: 'File/Blob upload is unavailable from this page transport.'
                } });
                return;
            }
            var form = new FormData();
            form.append('file', file, file.name || 'upload.bin');
            var xhr = new XMLHttpRequest();
            var settled = false;
            function finish(fn, value) {
                if (settled) { return; }
                settled = true;
                removeUpload(call, xhr);
                fn(value);
            }
            xhr.open('POST', endpoint);
            var descriptor = uploadDescriptor();
            if (descriptor && typeof descriptor.capability === 'string' && descriptor.capability &&
                typeof xhr.setRequestHeader === 'function') {
                xhr.setRequestHeader('X-DSX-Capability', descriptor.capability);
            }
            call.uploads.push(xhr);
            if (onProgress && xhr.upload) {
                xhr.upload.onprogress = function (e) {
                    if (!call.payloadCancelled && e.lengthComputable) {
                        onProgress(Math.round(e.loaded / e.total * 100));
                    }
                };
            }
            xhr.onload = function () {
                if (call.payloadCancelled) { finish(reject, PAYLOAD_CANCELLED); return; }
                try {
                    var res = JSON.parse(xhr.responseText);
                    if (res && res.url) { finish(resolve, res.url); }
                    else { finish(reject, { event: 'error', code: 'upload_failed', data: { message: (res && res.error) || 'upload failed' } }); }
                } catch (e) { finish(reject, { event: 'error', code: 'upload_failed', data: { message: String(e) } }); }
            };
            xhr.onerror = function () {
                finish(reject, call.payloadCancelled ? PAYLOAD_CANCELLED
                    : { event: 'error', code: 'upload_failed', data: { message: 'upload failed' } });
            };
            xhr.onabort = function () { finish(reject, PAYLOAD_CANCELLED); };
            xhr.send(form);   // browser streams the File; never base64, never fully in JS memory
        });
    }

    // File/Blob params can't cross the bridge as-is. Each is streamed to
    // the native upload route (no base64) and replaced with the returned
    // URL. Every other value passes through untouched. (The historical
    // `despia.storage` SDK override is retired with the legacy split — the
    // transport never shipped one, so the hook was dead in the field.)
    function resolvePayload(params, call) {
        if (Array.isArray(params) || !params) { return Promise.resolve(params); }
        var keys = Object.keys(params);
        var out = {};
        var waits = keys.map(function (k) {
            var v = params[k];
            var isFile = (typeof File !== 'undefined' && v instanceof File);
            var isBlob = (typeof Blob !== 'undefined' && v instanceof Blob);
            if (!isFile && !isBlob) { out[k] = v; return null; }

            var file = isFile ? v
                     : new File([v], 'upload.' + ((v.type && v.type.split('/')[1]) || 'bin'), { type: v.type });

            return streamUpload(file, null, call).then(function (url) { out[k] = url; });
        }).filter(Boolean);
        return Promise.all(waits).then(function () { return out; });
    }

    // Dispatch a payload on the wire. The modern wire is STRUCTURED-ONLY — the
    // `{ scheme, params, rid }` envelope; the legacy URL-string form lives with its
    // owner (the Core/Legacy shim posts strings down the raw platform channel, and
    // the native side parses them only through that module). A missing/broken wire
    // swallows the send; the caller's promise then times out via `arm` (honest —
    // there is no native side to answer).
    function fire(command, params, rid) {
        if (!wire || typeof wire.send !== 'function') { return; }
        try { wire.send({ scheme: command, params: params || {}, rid: rid }); } catch (e) {}
    }

    // A stream handler is a function (gets the raw payload {event,data,final,...}) OR
    // a map { eventName: fn } that dispatches each payload to map[e.event](e.data, e)
    // - the "events keyed by declared name" form.
    function toHandler(h) {
        if (typeof h === 'function') { return h; }
        if (h && typeof h === 'object' && !Array.isArray(h)) {
            return function (e) {
                var fn = h[e && e.event];
                if (typeof fn === 'function') { fn(e && e.data, e); }
            };
        }
        return null;
    }

    function register(id, resolve, reject, onEvent) {
        pending[id] = {
            resolve: resolve,
            reject: reject,
            onEvent: onEvent,
            timer: null,
            uploads: [],
            payloadCancelled: false
        };
        return pending[id];
    }
    function removePending(id, abortUploads) {
        var call = pending[id];
        if (!call) { return null; }
        delete pending[id];
        if (call.timer != null) { clearTimeout(call.timer); call.timer = null; }
        if (abortUploads) { cancelUploads(call); }
        return call;
    }
    function arm(id, ms) {
        var call = pending[id];
        if (!call) { return; }
        call.timer = setTimeout(function () {
            var c = pending[id];
            if (c) {
                removePending(id, true);
                if (c.reject) { c.reject({ event: 'error', code: 'timeout' }); }
            }
        }, ms || 30000);
    }

    function payloadFailure(error) {
        if (error && typeof error === 'object' && error.event === 'error') { return error; }
        var message = error && error.message ? error.message : error;
        return { event: 'error', code: 'upload_failed', data: { message: String(message || 'upload failed') } };
    }

    // THE CALL CORE — the promise/stream machinery behind every module call, modern or
    // legacy ("`command`" is the wire's routing key, `<scheme>://<action.path>`; that
    // spelling is transport FRAMING inside the structured envelope, never page grammar).
    // `handler` may be a function or an { eventName: fn } map; its presence selects the
    // STREAM shape, else RESOLVE-ONCE. The two string-only legacy shapes (bare
    // fire-and-forget, watch-globals) are NOT here — they live in the Legacy shim.
    function engineCall(command, params, handler) {
        handler = (typeof handler === 'function') ? handler : toHandler(handler);
        var id = genId();

        // STREAM: params + handler.
        if (handler) {
            if (!caps.events) {
                // Old binary: no delivery return path. Surface that immediately
                // rather than holding the subscription open forever.
                setTimeout(function () {
                    try { handler({ event: 'error', code: 'unsupported', data: { message: 'streams require app v2+' } }); } catch (e) {}
                }, 0);
                return { id: id, stop: function () {} };
            }
            register(id, null, null, handler);
            Promise.resolve().then(function () {
                var call = pending[id];
                return call ? resolvePayload(params, call) : undefined;
            })
                // File/Blob preparation is asynchronous. The subscription may be stopped while an
                // upload is still resolving; never dispatch the original native action after that
                // cancellation (the earlier stop envelope may already have reached native).
                .then(function (r) { if (pending[id]) { fire(command, r, id); } })
                .catch(function (error) {
                    // A stopped subscription is terminal and silent, even if its in-flight upload
                    // rejects later. In particular, do not call a handler after `stop()` returned.
                    if (!pending[id]) { return; }
                    removePending(id, true);
                    try { handler(payloadFailure(error)); } catch (e) {}
                });
            return {
                id: id,
                stop: function () {
                    if (!removePending(id, true)) { return; }
                    fire(command, { __stop: true }, id);
                }
            };
        }

        // RESOLVE-ONCE → Promise with .id
        var p = new Promise(function (resolve, reject) {
            if (!caps.events) {
                reject({ event: 'error', code: 'unsupported', data: { message: 'promise results require app v2+' } });
                return;
            }
            register(id, resolve, reject, null);
            arm(id, (params && params.__timeout) || 30000);
            Promise.resolve().then(function () {
                var call = pending[id];
                return call ? resolvePayload(params, call) : undefined;
            })
                // A request whose public promise already timed out must not be launched afterward
                // merely because asynchronous file preparation eventually completed.
                .then(function (r) { if (pending[id]) { fire(command, r, id); } })
                .catch(function (error) {
                    if (!pending[id]) { return; }
                    removePending(id, true);
                    reject(payloadFailure(error));
                });
        });
        p.id = id;
        return p;
    }

    // THE ONE INBOUND DELIVERY SINK. Native delivers EVERY result / event / broadcast
    // envelope to window.__dsxWire.proxy, which forwards here (bound below — page code
    // can never rebind it). Correlated envelopes settle their pending call; rid-less
    // ones fan out to the scheme subscribers.
    function deliver(p) {
        if (!p) { return; }
        var call = p.id ? pending[p.id] : null;
        // A correlated envelope is never a broadcast. It may arrive after its promise
        // timed out or its stream stopped; dropping that stale reply prevents unrelated
        // scheme listeners from reacting to an old call as though it were a live event.
        if (p.id && !call) { return; }
        if (!call) {                                   // out-of-band -> fan out to scheme subscribers
            var ls = ((p.scheme && listeners[p.scheme]) || []).concat(listeners['*'] || []);
            for (var li = 0; li < ls.length; li++) { try { ls[li](p); } catch (e) {} }
            return;
        }
        if (p.event === 'error') {
            removePending(p.id, true);
            if (call.reject) { call.reject(p); } else if (call.onEvent) { call.onEvent(p); }
            return;
        }
        if (call.onEvent) {                            // STREAM: per-event delivery, terminal on final
            if (p.final === true) { removePending(p.id, false); }
            call.onEvent(p);
            return;
        }
        if (p.final !== false) {                       // PROMISE: resolve on terminal
            removePending(p.id, false);
            if (call.resolve) { call.resolve(p.data !== undefined ? p.data : p); }
        }
    }

    // Subscribe to a module's out-of-band events (broadcasts with no rid). `scheme` is the
    // module scheme ('powersync'), '*' the firehose. Returns an unsubscribe function.
    function on(scheme, handler) {
        if (!scheme || typeof handler !== 'function') { return function () {}; }
        (listeners[scheme] = listeners[scheme] || []).push(handler);
        return function off() {
            var a = listeners[scheme]; if (!a) { return; }
            var i = a.indexOf(handler); if (i >= 0) { a.splice(i, 1); }
        };
    }

    // Capability surface - reflects what THIS binary advertises. Page code branches on
    // `.events` / `.structured` / `.version` to pick rich-vs-cheap-fallback per call site.
    var supports = {
        version:    caps.version || 0,
        structured: !!caps.structured,
        events:     !!caps.events
    };

    // Version contract from the transport. __nativeRuntime is the white-label name
    // the runtimes install now; __despiaRuntime is the historical spelling, still read
    // so a page or a mixed-version install that only has the old global keeps working.
    var runtimeFacts = window.__nativeRuntime || window.__despiaRuntime || {};

    // Modules compiled into THIS build: [{ name, version, scheme? }, ...].
    // Excluded modules never appear, so this is a true presence list.
    var packagesList = runtimeFacts.packages || [];

    // Modules EXCLUDED from this build: [{ name, scheme?, reason }, ...] with
    // reason 'excluded' (named in the app's exclude list) or 'cascade' (its
    // parent module was excluded). The honest twin of `packages`: a page can
    // distinguish "absent because this app excluded it" from "never existed".
    var excludedList = runtimeFacts.excluded || [];

    // The ONE name/scheme matcher every introspection helper shares —
    // case-insensitive against an entry list's `name`/`scheme` fields.
    // A plain loop: short-circuits on the first hit (hasPackage backs the
    // markup `has:` word, so this is called per conditional element), never
    // allocates, and tolerates malformed entries (null elements, non-arrays)
    // instead of throwing inside every capability check.
    function matchesEntry(list, nameOrScheme) {
        if (!list || !list.length) { return null; }
        var q = String(nameOrScheme || '').toLowerCase();
        for (var i = 0; i < list.length; i++) {
            var e = list[i];
            if (!e) { continue; }
            if ((e.name && String(e.name).toLowerCase() === q) ||
                (e.scheme && String(e.scheme).toLowerCase() === q) ||
                (e.chain && String(e.chain).toLowerCase() === q)) { return e; }
            // Legacy aliases count: a shipped page detects by the spelling it shipped
            // with (hasPackage('watchhealth'), wasExcluded('get-uuid')).
            if (e.aliases && e.aliases.length) {
                for (var j = 0; j < e.aliases.length; j++) {
                    if (String(e.aliases[j]).toLowerCase() === q) { return e; }
                }
            }
        }
        return null;
    }

    // Case-insensitive: was this module excluded from THIS build?
    function wasExcluded(nameOrScheme) {
        return !!matchesEntry(excludedList, nameOrScheme);
    }

    // Case-insensitive presence check by folder name or scheme.
    function hasPackage(nameOrScheme) {
        return !!matchesEntry(packagesList, nameOrScheme);
    }

    // Look up a compiled module's entry by folder name or scheme (case-
    // insensitive). Returns { name, version, scheme? } or null.
    function packageEntry(nameOrScheme) {
        return matchesEntry(packagesList, nameOrScheme);
    }

    // Version string of a compiled module (by name or scheme), or null when the
    // module isn't in this build or declared no version. Synchronous - reads the
    // packages contract, no bridge round-trip.
    function packageVersion(nameOrScheme) {
        var e = packageEntry(nameOrScheme);
        return (e && e.version) || null;
    }

    // dsx.global — the app-wide DSX store (DSXState / `global.*`), bridged from
    // native DSX state. Read, write, and *watch* the same reactive state that
    // native routes, modules and components share, so the web app reflects a
    // native change (auth, entitlements, route, theme…) without a reload.
    var globalStore = {
        // Resolve-once read of a dot-path: `await dsx.global.get('session')`.
        get: function (key) { return engineCall('state://get', { key: key }); },
        // Write a dot-path: `await dsx.global.set('session.credits', 200)`.
        set: function (key, value) { return engineCall('state://set', { key: key, value: value }); },
        // Stream: `const s = dsx.global.watch('session', v => …)` — the handler
        // gets the current value now and on every change; `s.stop()` to unsubscribe.
        watch: function (key, handler) {
            return engineCall('state://watch', { key: key }, function (e) {
                try { handler(e ? e.data : undefined, e); } catch (_) {}
            });
        }
    };

    // Navigate the DSX router: set the current route path; the native Routing
    // module re-resolves global.route → the matching native (DSXView) or web (DSXWebView)
    // screen. Navigation is pure state — this is just a global.route.path write.
    function navigate(path) { return globalStore.set('route.path', path); }

    // ── the unified diagnostics primitives — `dsx.log` / `dsx.error`, the SAME spellings
    // DSX markup and native module code use (Conformance/logs + errors corpora) ─────────
    //
    // The kernel answers them on its reserved routing key; this builds the wire envelope.
    // WIRE ONLY — the "<key>://<verb>" string below is transport framing, never an API
    // spelling: the API is dsx.log(...) / dsx.error(...).
    function kernelVerb(verb, params) {
        try {
            var p = engineCall('dsx://' + verb, params);
            if (p && typeof p.catch === 'function') { p.catch(function () {}); }
        } catch (e) {}
    }

    // dsx.log(...) — console.log for the PAGE that also lands in the native log ring +
    // Xcode/logcat + the on-device diagnostics drawer, attributed as scheme "page". The
    // args format page-side (real JS: String for scalars, JSON.stringify for objects) into
    // ONE message string; the kernel records it verbatim. Fire-and-forget by design — the
    // promise resolves null and any rejection (an old binary without promise support) is
    // swallowed: logging must never throw into page code.
    function formatPageLogValue(v) {
        if (v === null || v === undefined) { return String(v); }
        if (typeof v === 'object') {
            try { return JSON.stringify(v); } catch (e) { return String(v); }
        }
        return String(v);
    }
    function dsxLog() {
        var parts = [];
        for (var i = 0; i < arguments.length; i++) { parts.push(formatPageLogValue(arguments[i])); }
        kernelVerb('log', { message: parts.join(' ') });
    }

    // dsx.error(code, { message, recoverable, data }) — report an error from page code
    // into the DSX error system (the ledger, dsx.hook('module.error'), the reactive
    // global.dsx.* keys, and the dsx.on('dsx') mirror), attributed as scheme "page".
    // The page-side twin of the markup `dsx.error(...)` builtin. Never throws.
    function dsxError(code, opts) {
        var o = (opts && typeof opts === 'object') ? opts : {};
        var params = { code: String(code || 'error'), scheme: 'page' };
        if (o.message != null) { params.message = String(o.message); }
        if (o.recoverable) { params.recoverable = true; }
        if (o.data !== undefined) { params.data = o.data; }
        kernelVerb('error', params);
    }

    // AUTOMATIC page-error capture — the best-practice pair every error SDK installs
    // (script errors + unhandled promise rejections), wired INTO the app's error system:
    // "the button does nothing" in web content shows up in the native ledger / drawer /
    // Xcode with zero page setup, exactly like an uncaught markup throw does (origin
    // "uncaught" is the native twin; the page's record carries scheme "page" + code
    // "uncaught"). addEventListener (never window.onerror=) so the page's own handlers
    // keep working. Burst-guarded: identical consecutive messages within a second are
    // dropped and forwarding is capped per minute — a render-loop error must not storm
    // the bridge.
    (function () {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') { return; }
        var lastMsg = ''; var lastAt = 0; var windowStart = 0; var windowCount = 0;
        function forward(message, data) {
            var now = Date.now();
            if (message === lastMsg && (now - lastAt) < 1000) { return; }
            if (now - windowStart > 60000) { windowStart = now; windowCount = 0; }
            if (windowCount >= 20) { return; }
            windowCount += 1; lastMsg = message; lastAt = now;
            dsxError('uncaught', { message: message, data: data });
        }
        window.addEventListener('error', function (e) {
            try {
                var data = {};
                if (e && e.filename) { data.url = String(e.filename); }
                if (e && e.lineno) { data.line = e.lineno; }
                if (e && e.colno) { data.col = e.colno; }
                forward(String((e && e.message) || 'script error'), data);
            } catch (err) {}
        });
        window.addEventListener('unhandledrejection', function (e) {
            try {
                var reason = e && e.reason;
                var msg = (reason && (reason.message || reason.code)) ? String(reason.message || reason.code)
                        : formatPageLogValue(reason);
                forward('unhandled rejection: ' + msg, {});
            } catch (err) {}
        });
    })();

    // Phantom-call safety (Conformance/chains proxySafety): names the JS runtime itself
    // probes on any object. Answering a callable proxy for one turns `await`,
    // JSON.stringify, console.log, or a devtools inspect into a LIVE bridge call — the
    // classic thenable trap and its friends. All undefined, always — plus every Symbol.
    // (Object.create(null): a literal `{ __proto__: 1 }` would silently drop that key.)
    var PROXY_INERT = Object.create(null);
    ['then', 'toString', 'valueOf', 'toJSON', 'constructor', '__proto__'].forEach(function (k) { PROXY_INERT[k] = 1; });
    function proxyInert(name) {
        return typeof name === 'symbol' || PROXY_INERT[String(name)] === 1;
    }

    // ── window.dsx — THE page surface: one API, one syntax, one mental model ──────────
    //
    // The page inside DSXWebView gets the SAME spellings DSX markup and native module code
    // use — dsx.module.<scheme>.<action>({args}), dsx.log, dsx.error, dsx.global,
    // dsx.on, dsx.has. Explicit members only — the bare-scheme/legacy string forms do
    // NOT exist here, so a typo'd member is undefined instead of a phantom scheme call.
    // The excluded BUILD FACT for a dotted chain — `false` when shipped (or when the name
    // never existed), else `{ reason: "excluded" | "cascade", from? }`, mirroring the
    // native `.excluded` member 1:1 (facet-contracts.md build visibility).
    function moduleExcludedFact(path) {
        var e = matchesEntry(excludedList, path);
        if (!e) { return false; }
        var fact = { reason: e.reason || 'excluded' };
        if (e.from) { fact.from = e.from; }
        return fact;
    }

    // The MODERN module proxy (dsx.module.<chain>…) — the member walk PLUS the
    // reserved member plane, so at any depth `.available` / `.excluded` answer build FACTS
    // and `.on` subscribes to the module's own events — never a phantom call. The dotted
    // path travels whole (`watch://health.heartRate`); the native funnel's chain FOLD
    // resolves identity-vs-action against the registry (ChainResolver, Conformance/chains).
    function dsxModuleMember(path) {
        return new Proxy(function () {}, {
            apply: function (_t, _this, args) {
                var dot = path.indexOf('.');
                var scheme = dot === -1 ? path : path.slice(0, dot);
                var rest = dot === -1 ? '' : path.slice(dot + 1);
                return engineCall(scheme + '://' + rest, args[0] || {}, args[1]);
            },
            get: function (_t, sub) {
                if (proxyInert(sub)) { return undefined; }
                sub = String(sub);
                if (sub === 'available') { return hasPackage(path) && !wasExcluded(path); }
                if (sub === 'excluded') { return moduleExcludedFact(path); }
                // The remaining reserved members have no page-plane implementation (yet):
                // undefined keeps the MODERN face honest — never a phantom wire call, so
                // window.dsx.module can never reach a legacy shim the typed faces refuse
                // as reserved_member. Declared-variable reads on the page ride dsx.global.
                if (sub === 'state' || sub === 'context' || sub === 'object' ||
                    sub === 'delegate' || sub === 'dsx') { return undefined; }
                if (sub === 'on') {
                    // dsx.module.<chain>.on(handler) — every event; .on("kind", handler) —
                    // one kind (filtered on the envelope's event name when it carries one).
                    return function (kind, handler) {
                        if (typeof kind === 'function') { return on(path, kind); }
                        return on(path, function (envelope) {
                            var ev = envelope && envelope.event;
                            if (ev == null || ev === kind) {
                                handler(envelope && envelope.data, envelope);
                            }
                        });
                    };
                }
                return dsxModuleMember(path ? path + '.' + sub : sub);
            }
        });
    }

    var dsxSurface = {
        // the call root — identical to markup's dsx.module.<scheme>.<action>({…}) and
        // native's dsx.module chains; promise on await, stream with an onEvent handler;
        // reserved members (available / excluded / on) answer at any depth
        module: (typeof Proxy === 'function') ? new Proxy({}, {
            get: function (_t, scheme) {
                if (proxyInert(scheme)) { return undefined; }
                return dsxModuleMember(String(scheme));
            }
        }) : {},
        // the unified diagnostics primitives (the kernel's reserved verbs)
        log: dsxLog,
        error: dsxError,
        // the app-wide reactive store (global.*) — get / set / watch
        global: globalStore,
        // out-of-band module events: dsx.on('powersync', handler) · dsx.on('dsx', …) for
        // the global error mirror · '*' for the firehose
        on: on,
        // capability detection by module name or scheme (the markup `has:` twin)
        has: hasPackage,
        // build introspection (the compiled-packages contract) — 1:1 with the
        // native handle's build-visibility surface (facet-contracts.md): the
        // excluded twin + wasExcluded answer "absent because this app excluded
        // it" vs "never existed", same spellings as markup/native.
        packages: packagesList,
        excluded: excludedList,
        wasExcluded: wasExcluded,
        version: packageVersion
    };
    // (Re)defined on every install — a re-injected runtime carries a fresh pending-call
    // registry (writable + configurable, so a page that deliberately overrides it can).
    Object.defineProperty(window, 'dsx', { configurable: true, writable: true, value: dsxSurface });

    // ── BIND THE WIRE: the inbound sink ────────────────────────────────────────────
    //
    // `deliver` becomes window.__dsxWire.proxy's sink (first-bind-wins on the native
    // side; this script runs at document start, before any page script, so the engine
    // can never lose the race — the STABLE-SINK guarantee the old despia-object sink
    // carried by accident is now carried by construction). Nothing else rides the wire:
    // the compat module's generated shim consumes the PUBLIC window.dsx surface — the
    // engine exposes no privileged handle.
    if (wire && typeof wire.bind === 'function') {
        try { wire.bind(deliver); } catch (e) {}
    }
})();

// Native-feel Rendering Engine — make the web view feel like native UI. Injected at document-START
// (document.head can be null then), so the <style> is appended to (head || documentElement) and applies
// as the DOM is parsed — no flash. Page content gets NO text selection / callout / magnifier loupe /
// tap-highlight / drag, NO text auto-inflation and NO double-tap zoom; real inputs (and anything the
// page opts in with selectable="true") stay fully selectable + editable. This used to throw at
// document-start (document.head null) and silently not apply — which is why the page felt non-native.
try {
    var existingStyle = document.getElementById('selection-style');
    if (existingStyle) { existingStyle.remove(); }

    var style = document.createElement('style');
    style.id = 'selection-style';
    style.textContent = `
        /* SAFE AREA, ONE SPELLING, EVERY SURFACE.
           A page should not have to know which renderer it landed on to avoid the
           notch, and today it does. On iOS env(safe-area-inset-*) resolves because
           the web view is pinned to the host's edges with
           contentInsetAdjustmentBehavior = .never — the page owns its own spacing.
           Android WebView does not implement those env() keywords at all, so the
           identical CSS silently evaluates to 0 and content sits under the status
           bar. The native side publishes real values there by overriding these four
           custom properties.
           Seeding them from env() here means var(--safe-area-inset-top) is
           CORRECT ON IOS BEFORE ANY NATIVE CODE RUNS, and is the same name Android
           overwrites — so a page writes one spelling and a build that publishes
           nothing degrades to 0 rather than to a broken layout. */
        :root {
            --safe-area-inset-top: env(safe-area-inset-top, 0px);
            --safe-area-inset-right: env(safe-area-inset-right, 0px);
            --safe-area-inset-bottom: env(safe-area-inset-bottom, 0px);
            --safe-area-inset-left: env(safe-area-inset-left, 0px);
            /* The historical short names stay aliases: pages written against the
               StatusBar module's publication keep working unchanged. */
            --safe-area-top: var(--safe-area-inset-top);
            --safe-area-right: var(--safe-area-inset-right);
            --safe-area-bottom: var(--safe-area-inset-bottom);
            --safe-area-left: var(--safe-area-inset-left);
        }
        html {
            -webkit-text-size-adjust: 100%;
            text-size-adjust: 100%;
            touch-action: manipulation;
        }
        html, body, body * {
            /* !important so a page's own CSS can't re-enable selection (which brought back the
               triple-tap-hold magnifier loupe — the "exposing the web view" artifact). The selector
               covers html + body themselves, not just body's descendants, so a tap on the bare
               background can't start a selection either. Inputs are restored below (later !important
               rule of equal-or-higher specificity wins). */
            -webkit-user-select: none !important;
            -ms-user-select: none !important;
            user-select: none !important;
            -webkit-touch-callout: none !important;
            -webkit-tap-highlight-color: transparent;
            tap-highlight-color: transparent;
            -webkit-user-drag: none;
        }
        input, textarea, select, [contenteditable], [contenteditable="true"], [selectable="true"], [selectable="true"] * {
            -webkit-user-select: text !important;
            -ms-user-select: text !important;
            user-select: text !important;
            -webkit-touch-callout: default !important;
        }
    `;

    (document.head || document.documentElement).appendChild(style);
} catch (error) {
    console.error('Failed to apply native-feel styles:', error);
}
