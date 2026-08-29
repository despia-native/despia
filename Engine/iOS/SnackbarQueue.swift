//
//  SnackbarQueue.swift — the snackbar contract, Swift twin.
//
//  The law and the reasoning live in OpenSource/Conformance/overlays/README.md; the cases live
//  in snackbar.json and run against THIS file (SnackbarConformance, record lane), against the TS
//  twin (packages/kernel/src/snackbar.ts) and against the Kotlin twin (:core SnackbarQueue.kt).
//
//  Everything here is pure: requests and endings in, the visible card / the queue / the
//  settlements out. The surface work — presenting the card, running the timer, reading
//  safeAreaInsets, animating the swipe — belongs to Core/Toast's swift facet. Keeping the
//  decision separate from the plumbing is what lets one corpus judge three runtimes, and is why
//  this file imports only Foundation.
//

import Foundation

/// How a snackbar ended. This is what `toast.show` resolves with.
public enum SnackbarResult: String {
    case dismissed
    case action
    case timeout
    case replaced
}

public enum SnackbarEdge: String {
    case bottom
    case top
}

public struct SnackbarAction: Equatable {
    public let label: String
    public let id: String

    public init(label: String, id: String) {
        self.label = label
        self.id = id
    }
}

/// What a caller asked for.
public struct SnackbarRequest {
    public let id: String
    public let message: String
    public let action: SnackbarAction?
    /// `short` (4s) · `long` (10s) · a NUMBER OF SECONDS (the unit Core/Toast ships).
    public let duration: Any?
    public let tone: String?
    public let icon: String?
    public let position: String?
    public let dismissible: Bool?
    public let replace: Bool

    public init(id: String,
                message: String = "",
                action: SnackbarAction? = nil,
                duration: Any? = nil,
                tone: String? = nil,
                icon: String? = nil,
                position: String? = nil,
                dismissible: Bool? = nil,
                replace: Bool = false) {
        self.id = id
        self.message = message
        self.action = action
        self.duration = duration
        self.tone = tone
        self.icon = icon
        self.position = position
        self.dismissible = dismissible
        self.replace = replace
    }
}

/// A normalized card: what the presenter needs and nothing else.
public struct SnackbarEntry: Equatable {
    public let id: String
    public let message: String
    public let action: SnackbarAction?
    public let durationMs: Int
    public let tone: String
    public let icon: String
    public let position: SnackbarEdge
    public let dismissible: Bool
}

public struct SnackbarSettlement: Equatable {
    public let id: String
    public let result: SnackbarResult
}

public struct SnackbarState: Equatable {
    /// The card on screen, or nil.
    public var current: SnackbarEntry?
    /// Cards waiting, in FIFO order. Never includes `current`.
    public var queue: [SnackbarEntry]
    /// Every settlement so far, in the order they happened.
    public var settled: [SnackbarSettlement]

    public init(current: SnackbarEntry? = nil, queue: [SnackbarEntry] = [], settled: [SnackbarSettlement] = []) {
        self.current = current
        self.queue = queue
        self.settled = settled
    }

    /// Cards waiting behind the visible one — what `toast.queue()` resolves.
    public var pending: Int { queue.count }
}

public enum SnackbarOp {
    case show(SnackbarRequest)
    case elapse
    case action
    case dismiss
    case hide(String?)
}

public enum SnackbarQueue {

    /// Material's two words, in milliseconds.
    public static let shortMs = 4000
    public static let longMs = 10_000
    /// The duration Core/Toast has shipped since it existed, kept as the wordless default.
    public static let defaultMs = 2000
    /// A toast nobody can finish reading is not a toast.
    public static let minMs = 1000
    /// A ceiling, so a bad number cannot pin a card to the screen forever (one day).
    public static let maxMs = 86_400_000
    /// The inset between the card and whatever is under it.
    public static let gap = 16
    /// A top-edge card sits closer: it is a banner, not a floating capsule.
    public static let topGap = 12

    /// How long the card stays up, in milliseconds.
    ///
    /// The WORDS are Material's. A NUMBER STAYS SECONDS: that is the unit
    /// `toast.show({ duration })` has always taken, and redefining it under the same key would
    /// halve or double every toast already shipped. An unrecognized word falls back to the
    /// default rather than failing a build.
    ///
    /// The default is the shipped 2s — EXCEPT when the caller supplied an action button, where
    /// two seconds is not enough time to notice an Undo and reach it, so `short` takes over.
    public static func resolveDuration(_ duration: Any?, hasAction: Bool = false) -> Int {
        let fallback = hasAction ? shortMs : defaultMs
        guard let duration = duration else { return fallback }
        // Booleans bridge to NSNumber; a `true` duration is nonsense, not one second.
        if duration is Bool { return fallback }
        if let number = duration as? NSNumber {
            return milliseconds(from: number.doubleValue, fallback: fallback)
        }
        let word = String(describing: duration).trimmingCharacters(in: .whitespaces).lowercased()
        if word == "short" { return shortMs }
        if word == "long" { return longMs }
        if word.isEmpty { return fallback }
        guard let seconds = Double(word) else { return fallback }
        return milliseconds(from: seconds, fallback: fallback)
    }

    /// Seconds to milliseconds, total: NaN and infinity fall back, and the result is clamped
    /// into `[minMs, one day]` so no reported number can trap the conversion or pin a card to
    /// the screen forever.
    private static func milliseconds(from seconds: Double, fallback: Int) -> Int {
        guard seconds.isFinite else { return fallback }
        let ms = (seconds * 1000).rounded()
        return max(minMs, Int(min(max(ms, 0), Double(maxMs))))
    }

    /// The requested edge, normalized. A typo is `.bottom`, never a build failure.
    public static func resolveEdge(_ position: String?) -> SnackbarEdge {
        (position ?? "").trimmingCharacters(in: .whitespaces).lowercased() == "top" ? .top : .bottom
    }

    /// A request, normalized into the card the presenter draws.
    public static func normalize(_ request: SnackbarRequest) -> SnackbarEntry {
        let action = (request.action?.label.isEmpty == false) ? request.action : nil
        return SnackbarEntry(
            id: request.id,
            message: request.message,
            action: action,
            durationMs: resolveDuration(request.duration, hasAction: action != nil),
            tone: request.tone ?? "default",
            icon: request.icon ?? "",
            position: resolveEdge(request.position),
            dismissible: request.dismissible ?? true
        )
    }

    private static func settle(_ state: SnackbarState, _ entry: SnackbarEntry, _ result: SnackbarResult) -> SnackbarState {
        var next = state
        next.settled.append(SnackbarSettlement(id: entry.id, result: result))
        return next
    }

    /// The visible card ended: record it and promote the head of the queue.
    private static func promote(_ state: SnackbarState, _ result: SnackbarResult) -> SnackbarState {
        guard let current = state.current else { return state }
        var next = settle(state, current, result)
        next.current = next.queue.first
        if !next.queue.isEmpty { next.queue.removeFirst() }
        return next
    }

    /// The whole queue, in one reducer.
    ///
    /// ONE AT A TIME, FIFO. Stacking snackbars is how a bottom sheet becomes unreachable, so a
    /// second `show` waits its turn — unless it asks to `replace`, which settles the visible card
    /// as `.replaced` and takes its place. Replace is a SWAP, not a reset: the cards already
    /// waiting keep waiting, because the caller asked to change what is on screen, not to cancel
    /// a backlog.
    ///
    /// Every card settles EXACTLY ONCE, which is what makes `show` resolvable on outcome: an
    /// awaited `show` that never settles is a leaked promise, and one that settles twice is a
    /// double undo.
    public static func apply(_ state: SnackbarState, _ op: SnackbarOp) -> SnackbarState {
        switch op {
        case .show(let request):
            let entry = normalize(request)
            // The shipped rule, kept: an empty message is a no-op, not an empty card.
            if entry.message.isEmpty { return state }
            guard let current = state.current else {
                var next = state
                next.current = entry
                return next
            }
            if request.replace {
                var next = settle(state, current, .replaced)
                next.current = entry
                return next
            }
            var next = state
            next.queue.append(entry)
            return next
        case .elapse:
            return promote(state, .timeout)
        case .action:
            // A tap on a button that is not there is not an outcome.
            guard state.current?.action != nil else { return state }
            return promote(state, .action)
        case .dismiss:
            // A swipe obeys `dismissible`; see `.hide` for the API route that does not.
            guard state.current?.dismissible == true else { return state }
            return promote(state, .dismissed)
        case .hide(let wanted):
            let id = wanted ?? ""
            if id.isEmpty || state.current?.id == id {
                // `hide()` is an API call, not a gesture: it settles a non-dismissible card too.
                guard state.current != nil else { return state }
                return promote(state, .dismissed)
            }
            guard let queued = state.queue.first(where: { $0.id == id }) else { return state }
            var next = settle(state, queued, .dismissed)
            next.queue.removeAll { $0.id == id }
            return next
        }
    }

    public struct Chrome {
        public let position: String?
        public let safeAreaTop: Int
        public let safeAreaBottom: Int
        /// A tab bar / bottom navigation, 0 when there is none.
        public let bottomBar: Int
        /// The height a floating action button occupies above the bar, 0 when there is none.
        public let fab: Int
        /// What the soft keyboard covers of the layout viewport.
        public let keyboard: Int

        public init(position: String? = nil, safeAreaTop: Int = 0, safeAreaBottom: Int = 0,
                    bottomBar: Int = 0, fab: Int = 0, keyboard: Int = 0) {
            self.position = position
            self.safeAreaTop = safeAreaTop
            self.safeAreaBottom = safeAreaBottom
            self.bottomBar = bottomBar
            self.fab = fab
            self.keyboard = keyboard
        }
    }

    public struct Lift: Equatable {
        public let edge: SnackbarEdge
        /// Points from that edge to the near side of the card.
        public let inset: Int
        /// The invariant, reported rather than assumed.
        public let clearsHomeIndicator: Bool
    }

    private static func positive(_ n: Int) -> Int { n > 0 ? n : 0 }

    /// Where the card sits.
    ///
    /// The keyboard, when it is up, IS the obstruction: it already covers the bottom bar, the FAB
    /// and the safe area, so adding them would push the card into the middle of the screen.
    /// Otherwise the obstruction is the safe area plus the bar plus whatever the FAB occupies
    /// above it. The gap goes on top of whichever won.
    ///
    /// THE INVARIANT: the bottom inset is never less than the safe-area inset plus the gap, so no
    /// geometry a platform reports — including nonsense from a rotation race — can put the card
    /// on the home indicator.
    public static func resolveLift(_ chrome: Chrome) -> Lift {
        let edge = resolveEdge(chrome.position)
        let safeBottom = positive(chrome.safeAreaBottom)
        if edge == .top {
            return Lift(edge: edge, inset: positive(chrome.safeAreaTop) + topGap, clearsHomeIndicator: true)
        }
        let keyboard = positive(chrome.keyboard)
        let chromeStack = safeBottom + positive(chrome.bottomBar) + positive(chrome.fab)
        let obstruction = keyboard > 0 ? max(keyboard, safeBottom) : chromeStack
        let inset = obstruction + gap
        return Lift(edge: edge, inset: inset, clearsHomeIndicator: inset >= safeBottom + gap)
    }
}
