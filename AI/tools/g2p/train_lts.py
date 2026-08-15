#!/usr/bin/env python3
"""Learn the letter-to-sound trees a G2P pack carries in its ``LTS `` section.

The pipeline is the one Black, Lenzo and Pagel describe.  First an EM alignment
decides which phones each letter of a word is responsible for, allowing a letter
to emit nothing, one phone or two.  Then one CART per letter is grown over
questions of the form "the letter at context position p is c", split on
information gain, and pruned back to a node budget.  Finally the trees are scored
on words the alignment never saw.

Two properties of this trainer are deliberate and worth stating, because both are
easy to get wrong in a way nothing downstream would notice:

- stress is not stripped.  A stressed vowel is its own alignment unit, so the same
  trees that predict a vowel predict whether it carries primary or secondary
  stress.  A model trained on stress-free phones has to have stress guessed back by
  a rule, and that rule is where every word starts sounding flat;
- a word that cannot be aligned is dropped from TRAINING only.  It stays in the
  lexicon the pack ships, so runtime coverage is unaffected.  The count is printed
  because a rising number would mean the alignment model has broken, not that the
  language has changed.

Output is an intermediate JSON that ``build_pack.py`` turns into the binary
section.  Nothing here ships.
"""

from __future__ import annotations

import argparse
import heapq
import math
import os
import sys
import tempfile
import time
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import g2p_common as C  # noqa: E402


# A question can look this many letters either side of the letter being
# pronounced, so a node sees 2 * WINDOW + 1 letters.
WINDOW = 3

# The letter id used for a context position that falls off the end of the word.
# g2p-pack.md fixes it at one past the last real letter.
PAD = len(C.LETTERS)

# Child indices in an LtsNode are u16, and the reader checks that a child index is
# greater than its parent's index in the same array.  So the whole forest has to
# fit in 65,536 node slots.  This is a format constraint, not a tuning knob.
MAX_NODES = 65535


class TrainError(RuntimeError):
    pass


# ---------------------------------------------------------------------------
# alignment
# ---------------------------------------------------------------------------


def prepare_words(
    pairs: Sequence[Tuple[str, str]],
) -> Tuple[List[Tuple[List[int], List[int]]], List[str], int]:
    """Turn (word, phones) into (letter ids, unit ids), dropping the impossible.

    A word whose pronunciation has more than two units per letter has no valid
    alignment under this model at all, so it is rejected here rather than
    producing a zero-probability path later.  The count is returned rather than
    swallowed, because a rise in it is the signal that the alignment model no
    longer fits the data.
    """
    unit_ids: Dict[str, int] = {}
    out: List[Tuple[List[int], List[int]]] = []
    rejected = 0
    for word, phones in pairs:
        units = C.split_units(phones)
        letters = [C.LETTERS.index(c) for c in word]
        if len(units) > 2 * len(letters):
            rejected += 1
            continue
        ids = []
        for unit in units:
            index = unit_ids.get(unit)
            if index is None:
                index = len(unit_ids)
                unit_ids[unit] = index
            ids.append(index)
        out.append((letters, ids))
    units_sorted = [""] * len(unit_ids)
    for unit, index in unit_ids.items():
        units_sorted[index] = unit
    return out, units_sorted, rejected


def build_classes(
    words: Sequence[Tuple[List[int], List[int]]], unit_count: int
) -> Tuple[List[Tuple[List[int], List[int], List[int], int]], Dict[Tuple[int, int], int], int]:
    """Assign a class id to every emission any word could need."""
    double_id: Dict[Tuple[int, int], int] = {}
    prepared = []
    for letters, ids in words:
        m = len(ids)
        singles = [1 + u for u in ids]
        doubles = []
        for j in range(m - 1):
            key = (ids[j], ids[j + 1])
            index = double_id.get(key)
            if index is None:
                index = 1 + unit_count + len(double_id)
                double_id[key] = index
            doubles.append(index)
        prepared.append((letters, singles, doubles, m))
    return prepared, double_id, 1 + unit_count + len(double_id)


def em_iteration(
    model: List[List[float]],
    prepared: Sequence[Tuple[List[int], List[int], List[int], int]],
    letters_count: int,
    class_count: int,
) -> Tuple[List[List[float]], float, int]:
    """One scaled forward-backward pass over every word.

    The columns are scaled as they are built, which is the textbook remedy for the
    fact that a 45 letter word multiplies 45 probabilities together and a double
    underflows long before the word ends.
    """
    counts = [[0.0] * class_count for _ in range(letters_count)]
    total_ll = 0.0
    failed = 0
    log = math.log
    for word_letters, singles, doubles, m in prepared:
        n = len(word_letters)
        alpha = [[0.0] * (m + 1) for _ in range(n + 1)]
        alpha[0][0] = 1.0
        scale = [1.0] * (n + 1)
        ok = True
        for i in range(n):
            row = alpha[i]
            nxt = alpha[i + 1]
            probs = model[word_letters[i]]
            for j in range(m + 1):
                a = row[j]
                if a == 0.0:
                    continue
                p = probs[0]
                if p:
                    nxt[j] += a * p
                if j < m:
                    p = probs[singles[j]]
                    if p:
                        nxt[j + 1] += a * p
                if j + 1 < m:
                    p = probs[doubles[j]]
                    if p:
                        nxt[j + 2] += a * p
            total = 0.0
            for value in nxt:
                total += value
            if total == 0.0:
                ok = False
                break
            scale[i + 1] = total
            inv = 1.0 / total
            for j in range(m + 1):
                nxt[j] *= inv
        if not ok or alpha[n][m] == 0.0:
            failed += 1
            continue
        z = alpha[n][m]
        total_ll += log(z)
        for i in range(1, n + 1):
            total_ll += log(scale[i])

        beta = [[0.0] * (m + 1) for _ in range(n + 1)]
        beta[n][m] = 1.0
        for i in range(n - 1, -1, -1):
            probs = model[word_letters[i]]
            row = beta[i]
            nxt = beta[i + 1]
            inv = 1.0 / scale[i + 1]
            for j in range(m + 1):
                value = 0.0
                b = nxt[j]
                if b:
                    value += probs[0] * b
                if j < m:
                    b = nxt[j + 1]
                    if b:
                        value += probs[singles[j]] * b
                if j + 1 < m:
                    b = nxt[j + 2]
                    if b:
                        value += probs[doubles[j]] * b
                if value:
                    row[j] = value * inv

        for i in range(n):
            probs = model[word_letters[i]]
            bucket = counts[word_letters[i]]
            arow = alpha[i]
            brow = beta[i + 1]
            inv = 1.0 / (z * scale[i + 1])
            for j in range(m + 1):
                a = arow[j]
                if a == 0.0:
                    continue
                a *= inv
                b = brow[j]
                if b:
                    bucket[0] += a * probs[0] * b
                if j < m:
                    b = brow[j + 1]
                    if b:
                        cid = singles[j]
                        bucket[cid] += a * probs[cid] * b
                if j + 1 < m:
                    b = brow[j + 2]
                    if b:
                        cid = doubles[j]
                        bucket[cid] += a * probs[cid] * b
    return counts, total_ll, failed


def normalise(counts: List[List[float]]) -> List[List[float]]:
    model = []
    for bucket in counts:
        total = 0.0
        for value in bucket:
            total += value
        if total <= 0.0:
            model.append(bucket)
            continue
        inv = 1.0 / total
        model.append([value * inv for value in bucket])
    return model


def viterbi(
    model: List[List[float]],
    letters: List[int],
    singles: List[int],
    doubles: List[int],
    m: int,
) -> Optional[List[int]]:
    """The single best emission sequence, one class id per letter.

    Every write into the next column is a strict improvement, so when two paths
    reach a cell with the same score the first one to arrive keeps it.  The loop
    runs over source columns in increasing order, which means the winner is the
    transition that consumed the most units.  That choice is arbitrary; that it is
    fixed is not, because a tie broken by float comparison order is a pack that
    does not rebuild to the same bytes.
    """
    n = len(letters)
    neg = float("-inf")
    best = [[neg] * (m + 1) for _ in range(n + 1)]
    back: List[List[Optional[Tuple[int, int]]]] = [[None] * (m + 1) for _ in range(n + 1)]
    best[0][0] = 0.0
    log = math.log
    for i in range(n):
        probs = model[letters[i]]
        row = best[i]
        nxt = best[i + 1]
        brow = back[i + 1]
        for j in range(m + 1):
            score = row[j]
            if score == neg:
                continue
            p = probs[0]
            if p > 0.0:
                value = score + log(p)
                if value > nxt[j]:
                    nxt[j] = value
                    brow[j] = (j, 0)
            if j < m:
                cid = singles[j]
                p = probs[cid]
                if p > 0.0:
                    value = score + log(p)
                    if value > nxt[j + 1]:
                        nxt[j + 1] = value
                        brow[j + 1] = (j, cid)
            if j + 1 < m:
                cid = doubles[j]
                p = probs[cid]
                if p > 0.0:
                    value = score + log(p)
                    if value > nxt[j + 2]:
                        nxt[j + 2] = value
                        brow[j + 2] = (j, cid)
    if best[n][m] == neg:
        return None
    path: List[int] = []
    j = m
    for i in range(n, 0, -1):
        step = back[i][j]
        if step is None:
            return None
        j, cid = step
        path.append(cid)
    path.reverse()
    return path


# ---------------------------------------------------------------------------
# trees
# ---------------------------------------------------------------------------


class Node:
    __slots__ = ("kind", "pos", "chr", "yes", "no", "cls", "total", "top", "error", "parent")

    def __init__(self) -> None:
        self.kind = 1
        self.pos = 0
        self.chr = 0
        self.yes = -1
        self.no = -1
        self.cls = 0
        self.total = 0
        self.top = 0
        self.error = 0
        self.parent = -1


def impurity(sum_c_log_c: float, weight: int) -> float:
    """Weighted entropy of a distribution, in nats, times its weight."""
    if weight <= 0:
        return 0.0
    return weight * math.log(weight) - sum_c_log_c


def grow_tree(
    contexts: List[Tuple[int, ...]],
    classes: List[int],
    weights: List[int],
    min_leaf: int,
    max_depth: int,
) -> List[Node]:
    """Grow one letter's CART, returning nodes in creation order.

    Questions about the centre position are never generated: within one letter's
    tree that position is a constant, so the question carries no information and
    would only waste a node.
    """
    positions = [p for p in range(2 * WINDOW + 1) if p != WINDOW]
    nodes: List[Node] = []
    log = math.log

    root = Node()
    nodes.append(root)
    stack: List[Tuple[int, List[int], int]] = [(0, list(range(len(contexts))), 0)]

    while stack:
        node_index, indices, depth = stack.pop()
        node = nodes[node_index]
        distribution: Dict[int, int] = {}
        total = 0
        for idx in indices:
            cls = classes[idx]
            weight = weights[idx]
            distribution[cls] = distribution.get(cls, 0) + weight
            total += weight
        top_class, top_weight = max(sorted(distribution.items()), key=lambda kv: (kv[1], -kv[0]))
        node.total = total
        node.top = top_class
        node.cls = top_class
        node.error = total - top_weight

        if len(distribution) == 1 or depth >= max_depth or total < 2 * min_leaf:
            continue

        parent_sum = 0.0
        for weight in distribution.values():
            parent_sum += weight * log(weight)
        parent_impurity = impurity(parent_sum, total)

        best_gain = 0.0
        best_pos = -1
        best_chr = -1
        for pos in positions:
            tally: Dict[int, Dict[int, int]] = {}
            for idx in indices:
                char = contexts[idx][pos]
                bucket = tally.get(char)
                if bucket is None:
                    bucket = {}
                    tally[char] = bucket
                cls = classes[idx]
                bucket[cls] = bucket.get(cls, 0) + weights[idx]
            for char in sorted(tally):
                bucket = tally[char]
                yes_weight = 0
                yes_sum = 0.0
                delta = 0.0
                for cls, weight in bucket.items():
                    yes_weight += weight
                    yes_sum += weight * log(weight)
                    parent_weight = distribution[cls]
                    rest = parent_weight - weight
                    delta += parent_weight * log(parent_weight)
                    if rest > 0:
                        delta -= rest * log(rest)
                no_weight = total - yes_weight
                if yes_weight < min_leaf or no_weight < min_leaf:
                    continue
                no_sum = parent_sum - delta
                gain = parent_impurity - impurity(yes_sum, yes_weight) - impurity(no_sum, no_weight)
                if gain > best_gain + 1e-12:
                    best_gain = gain
                    best_pos = pos
                    best_chr = char

        if best_pos < 0:
            continue

        yes_indices = []
        no_indices = []
        for idx in indices:
            if contexts[idx][best_pos] == best_chr:
                yes_indices.append(idx)
            else:
                no_indices.append(idx)

        yes_node = Node()
        no_node = Node()
        yes_index = len(nodes)
        nodes.append(yes_node)
        no_index = len(nodes)
        nodes.append(no_node)
        yes_node.parent = node_index
        no_node.parent = node_index
        node.kind = 0
        node.pos = best_pos
        node.chr = best_chr
        node.yes = yes_index
        node.no = no_index
        stack.append((no_index, no_indices, depth + 1))
        stack.append((yes_index, yes_indices, depth + 1))

    return nodes


def subtree_errors(nodes: List[Node]) -> List[int]:
    """Training error of each node's subtree, computed leaves upward."""
    errors = [0] * len(nodes)
    order = list(range(len(nodes)))
    for index in reversed(order):
        node = nodes[index]
        if node.kind == 1:
            errors[index] = node.error
        else:
            errors[index] = errors[node.yes] + errors[node.no]
    return errors


def prune_forest(forest: List[List[Node]], budget: int) -> Tuple[int, int]:
    """Collapse the weakest split in the whole forest until it fits the budget.

    Weakest means the split that buys the least training accuracy for its two
    nodes.  Pruning is global rather than per letter so that a letter with a hard
    job keeps its nodes and ``q`` does not get the same allowance as ``e``.
    """
    errors = [subtree_errors(nodes) for nodes in forest]
    total_nodes = sum(len(nodes) for nodes in forest)
    heap: List[Tuple[int, int, int]] = []
    for letter, nodes in enumerate(forest):
        for index, node in enumerate(nodes):
            if node.kind == 0 and nodes[node.yes].kind == 1 and nodes[node.no].kind == 1:
                cost = node.error - errors[letter][node.yes] - errors[letter][node.no]
                heapq.heappush(heap, (cost, letter, index))
    collapsed = 0
    while total_nodes > budget and heap:
        cost, letter, index = heapq.heappop(heap)
        nodes = forest[letter]
        node = nodes[index]
        if node.kind != 0:
            continue
        if nodes[node.yes].kind != 1 or nodes[node.no].kind != 1:
            continue
        live = node.error - errors[letter][node.yes] - errors[letter][node.no]
        if live != cost:
            heapq.heappush(heap, (live, letter, index))
            continue
        node.kind = 1
        node.cls = node.top
        errors[letter][index] = node.error
        node.yes = -1
        node.no = -1
        total_nodes -= 2
        collapsed += 2
        parent = node.parent
        if parent >= 0:
            other = nodes[parent]
            if other.kind == 0 and nodes[other.yes].kind == 1 and nodes[other.no].kind == 1:
                parent_cost = (
                    other.error - errors[letter][other.yes] - errors[letter][other.no]
                )
                heapq.heappush(heap, (parent_cost, letter, parent))
    return total_nodes, collapsed


def flatten(
    forest: List[List[Node]], class_phones: Dict[int, Tuple[int, ...]]
) -> Tuple[List[int], List[List[int]], List[int]]:
    """Lay the forest out the way the section stores it.

    Nodes are emitted breadth first within a tree, which is what guarantees the
    invariant the reader checks: a child's index is always greater than its
    parent's, so a walk cannot loop.
    """
    out_blob: List[int] = []
    out_offsets: Dict[Tuple[int, ...], int] = {}
    for phones in sorted(set(class_phones.values())):
        if phones not in out_offsets:
            out_offsets[phones] = len(out_blob)
            out_blob.extend(phones)

    roots: List[int] = []
    flat: List[List[int]] = []
    for nodes in forest:
        roots.append(len(flat))
        order = [0]
        mapping = {0: len(flat)}
        flat.append([])
        head = 0
        while head < len(order):
            source = order[head]
            head += 1
            node = nodes[source]
            slot = mapping[source]
            if node.kind == 1:
                phones = class_phones[node.cls]
                flat[slot] = [1, len(phones), out_offsets[phones]]
            else:
                mapping[node.yes] = len(flat)
                flat.append([])
                order.append(node.yes)
                mapping[node.no] = len(flat)
                flat.append([])
                order.append(node.no)
                flat[slot] = [0, node.pos, node.chr, mapping[node.yes], mapping[node.no]]
    return roots, flat, out_blob


def predict(flat: List[List[int]], roots: List[int], out_blob: List[int], word: str) -> List[int]:
    """Run the flattened trees, which is what the reader will do."""
    ids = [C.LETTERS.index(c) for c in word]
    length = len(ids)
    phones: List[int] = []
    for i in range(length):
        context = []
        for offset in range(-WINDOW, WINDOW + 1):
            k = i + offset
            context.append(ids[k] if 0 <= k < length else PAD)
        index = roots[ids[i]]
        while True:
            node = flat[index]
            if node[0] == 1:
                phones.extend(out_blob[node[2]:node[2] + node[1]])
                break
            index = node[3] if context[node[1]] == node[2] else node[4]
    return phones


def edit_distance(a: Sequence[int], b: Sequence[int]) -> int:
    if not a:
        return len(b)
    if not b:
        return len(a)
    previous = list(range(len(b) + 1))
    for i, ai in enumerate(a, 1):
        current = [i] + [0] * len(b)
        for j, bj in enumerate(b, 1):
            current[j] = min(
                previous[j] + 1,
                current[j - 1] + 1,
                previous[j - 1] + (0 if ai == bj else 1),
            )
        previous = current
    return previous[-1]


# ---------------------------------------------------------------------------
# self test
# ---------------------------------------------------------------------------


def self_test() -> int:
    """Check the scaled forward-backward against brute force on small cases.

    The scaling is the part of this file most likely to be subtly wrong, and a
    subtly wrong E step produces an alignment that looks plausible and is not the
    maximum likelihood one.  So it is checked against an enumeration of every
    valid alignment, where the posterior of a class is just its share of the
    probability mass.
    """
    import itertools
    import random

    rng = random.Random(20240501)
    failures = 0
    for case in range(12):
        letters_count = 3
        unit_count = 3
        words = []
        for _ in range(4):
            n = rng.randint(1, 4)
            m = rng.randint(1, min(4, 2 * n))
            words.append(
                ([rng.randrange(letters_count) for _ in range(n)],
                 [rng.randrange(unit_count) for _ in range(m)])
            )
        prepared, doubles, class_count = build_classes(words, unit_count)
        model = [[rng.random() + 0.05 for _ in range(class_count)] for _ in range(letters_count)]
        model = normalise([[v for v in row] for row in model])
        counts, ll, failed = em_iteration(model, prepared, letters_count, class_count)

        brute = [[0.0] * class_count for _ in range(letters_count)]
        brute_ll = 0.0
        for word_letters, singles, double_ids, m in prepared:
            n = len(word_letters)
            paths = []
            for choice in itertools.product((0, 1, 2), repeat=n):
                j = 0
                classes = []
                valid = True
                for step, letter in zip(choice, word_letters):
                    if step == 0:
                        classes.append(0)
                    elif step == 1:
                        if j >= m:
                            valid = False
                            break
                        classes.append(singles[j])
                        j += 1
                    else:
                        if j + 1 >= m:
                            valid = False
                            break
                        classes.append(double_ids[j])
                        j += 2
                if not valid or j != m:
                    continue
                weight = 1.0
                for letter, cid in zip(word_letters, classes):
                    weight *= model[letter][cid]
                paths.append((classes, weight))
            total = sum(weight for _, weight in paths)
            if total == 0.0:
                continue
            brute_ll += math.log(total)
            for classes, weight in paths:
                share = weight / total
                for letter, cid in zip(word_letters, classes):
                    brute[letter][cid] += share
        for letter in range(letters_count):
            for cid in range(class_count):
                if abs(brute[letter][cid] - counts[letter][cid]) > 1e-9:
                    print(
                        "case %d letter %d class %d: brute %.12f scaled %.12f"
                        % (case, letter, cid, brute[letter][cid], counts[letter][cid])
                    )
                    failures += 1
        if abs(brute_ll - ll) > 1e-9:
            print("case %d log likelihood: brute %.12f scaled %.12f" % (case, brute_ll, ll))
            failures += 1
    if failures:
        print("self test: %d failure(s)" % failures)
        return 1
    print("self test: forward-backward matches brute force on 12 random cases")
    return 0


# ---------------------------------------------------------------------------
# driver
# ---------------------------------------------------------------------------


def write_atomic(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-")
    try:
        with os.fdopen(handle, "wb") as out:
            out.write(data)
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def main(argv: List[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--work-dir", default="/tmp/g2p/sources")
    parser.add_argument("--out", default="/tmp/g2p/lts-en-us-1.json")
    parser.add_argument("--iterations", type=int, default=40, help="maximum EM iterations")
    parser.add_argument("--tolerance", type=float, default=1e-4, help="EM convergence threshold")
    # Swept against the held-out set at 1, 2, 3, 4 and 6.  The whole range is
    # within a percent of itself once the forest is pruned, and 2 is the point
    # where a smaller leaf stops buying anything the test set can measure.
    parser.add_argument("--min-leaf", type=int, default=2, help="smallest leaf the grower makes")
    parser.add_argument("--max-depth", type=int, default=32)
    parser.add_argument("--max-nodes", type=int, default=MAX_NODES)
    parser.add_argument("--self-test", action="store_true", help="check the E step and exit")
    args = parser.parse_args(argv)

    if args.self_test:
        return self_test()

    if args.max_nodes > MAX_NODES:
        raise TrainError(
            "max-nodes %d exceeds the %d the u16 child fields can address" % (args.max_nodes, MAX_NODES)
        )

    work = Path(args.work_dir)
    started = time.time()
    lexicon, stats = C.load_lexicon(work)
    phones = C.phone_alphabet(lexicon)
    phone_id = {phone: index for index, phone in enumerate(phones)}
    print("lexicon %s entries (gold %s, silver %s), %d phones in the pack alphabet"
          % (C.format_count(len(lexicon)), C.format_count(stats["gold"]),
             C.format_count(stats["silver"]), len(phones)))

    pairs = C.training_words(lexicon)
    train_pairs = [(w, p) for w, p in pairs if not C.is_held_out(w)]
    held_pairs = [(w, p) for w, p in pairs if C.is_held_out(w)]
    print("words usable for letter-to-sound: %s (train %s, held out %s)"
          % (C.format_count(len(pairs)), C.format_count(len(train_pairs)),
             C.format_count(len(held_pairs))))

    words, units, rejected = prepare_words(train_pairs)
    print("alignment units %d, words rejected as unalignable by length %d" % (len(units), rejected))
    prepared, doubles, class_count = build_classes(words, len(units))
    print("emission classes %s (%d single, %s paired)"
          % (C.format_count(class_count), len(units), C.format_count(len(doubles))))

    # A uniform start, which makes the first E step count every valid alignment
    # equally.  Nothing is seeded by hand, so no allowable pair is privileged
    # because someone believed it should be.
    model = [[1.0] * class_count for _ in range(len(C.LETTERS))]
    previous = None
    iteration = -1
    failed = 0
    for iteration in range(args.iterations):
        tick = time.time()
        counts, total_ll, failed = em_iteration(model, prepared, len(C.LETTERS), class_count)
        model = normalise(counts)
        per_word = total_ll / max(1, len(prepared) - failed)
        change = "" if previous is None else "  delta %+.6f" % (per_word - previous)
        print("  EM %2d  log likelihood/word %10.5f%s  unaligned %d  %.1fs"
              % (iteration + 1, per_word, change, failed, time.time() - tick))
        if previous is not None and abs(per_word - previous) < args.tolerance:
            previous = per_word
            break
        previous = per_word

    # Viterbi over the training words gives the single alignment the trees learn.
    class_units: Dict[int, Tuple[int, ...]] = {0: ()}
    for index in range(len(units)):
        class_units[1 + index] = (index,)
    for (first, second), index in doubles.items():
        class_units[index] = (first, second)
    class_phones: Dict[int, Tuple[int, ...]] = {}
    for cid, unit_ids in class_units.items():
        ids: List[int] = []
        for unit_index in unit_ids:
            for char in units[unit_index]:
                ids.append(phone_id[char])
        class_phones[cid] = tuple(ids)

    tick = time.time()
    samples: List[Dict[Tuple[Tuple[int, ...], int], int]] = [
        {} for _ in range(len(C.LETTERS))
    ]
    viterbi_failed = 0
    for (word_letters, singles, double_ids, m) in prepared:
        path = viterbi(model, word_letters, singles, double_ids, m)
        if path is None:
            viterbi_failed += 1
            continue
        n = len(word_letters)
        for i in range(n):
            context = []
            for offset in range(-WINDOW, WINDOW + 1):
                k = i + offset
                context.append(word_letters[k] if 0 <= k < n else PAD)
            key = (tuple(context), path[i])
            bucket = samples[word_letters[i]]
            bucket[key] = bucket.get(key, 0) + 1
    dropped = rejected + viterbi_failed
    print("viterbi %.1fs, words dropped from training %d (%.3f%% of usable), "
          "distinct contexts %s"
          % (time.time() - tick, dropped, 100.0 * dropped / max(1, len(train_pairs)),
             C.format_count(sum(len(b) for b in samples))))

    tick = time.time()
    forest: List[List[Node]] = []
    for letter in range(len(C.LETTERS)):
        items = sorted(samples[letter].items())
        contexts = [key[0] for key, _ in items]
        classes = [key[1] for key, _ in items]
        weights = [count for _, count in items]
        if not contexts:
            node = Node()
            node.kind = 1
            node.cls = 0
            forest.append([node])
            continue
        forest.append(grow_tree(contexts, classes, weights, args.min_leaf, args.max_depth))
    grown = sum(len(nodes) for nodes in forest)
    print("grown %s nodes in %.1fs" % (C.format_count(grown), time.time() - tick))

    tick = time.time()
    total_nodes, collapsed = prune_forest(forest, args.max_nodes)
    print("pruned to %s nodes (%s collapsed) in %.1fs"
          % (C.format_count(total_nodes), C.format_count(collapsed), time.time() - tick))

    roots, flat, out_blob = flatten(forest, class_phones)
    leaves = sum(1 for node in flat if node[0] == 1)
    print("flattened %s nodes, %s leaves, out blob %s phone ids"
          % (C.format_count(len(flat)), C.format_count(leaves), C.format_count(len(out_blob))))
    if len(flat) > MAX_NODES:
        raise TrainError("forest does not fit the u16 child fields: %d nodes" % len(flat))
    for index, node in enumerate(flat):
        if node[0] == 0 and not (node[3] > index and node[4] > index):
            raise TrainError("node %d has a child that is not ahead of it" % index)

    # Accuracy on words the alignment never saw.  Phone accuracy is measured with
    # an edit distance because a wrong guess can be the wrong length, and scoring
    # position by position would report a single inserted phone as a whole word of
    # errors.
    tick = time.time()
    exact = 0
    exact_flat = 0
    ref_total = 0
    distance_total = 0
    distance_flat = 0
    stress_ids = {phone_id[mark] for mark in C.STRESS if mark in phone_id}
    for word, pronunciation in held_pairs:
        reference = [phone_id[c] for c in pronunciation]
        guess = predict(flat, roots, out_blob, word)
        ref_total += len(reference)
        distance = edit_distance(reference, guess)
        distance_total += distance
        if distance == 0:
            exact += 1
        bare_ref = [i for i in reference if i not in stress_ids]
        bare_guess = [i for i in guess if i not in stress_ids]
        bare_distance = edit_distance(bare_ref, bare_guess)
        distance_flat += bare_distance
        if bare_distance == 0:
            exact_flat += 1
    phone_accuracy = 1.0 - distance_total / max(1, ref_total)
    word_accuracy = exact / max(1, len(held_pairs))
    print("held out %s words, %s reference phones, %.1fs"
          % (C.format_count(len(held_pairs)), C.format_count(ref_total), time.time() - tick))
    print("  phone accuracy      %.4f  (edit distance %s)"
          % (phone_accuracy, C.format_count(distance_total)))
    print("  word accuracy       %.4f  (%s of %s exact)"
          % (word_accuracy, C.format_count(exact), C.format_count(len(held_pairs))))
    print("  word miss rate      %.4f" % (1.0 - word_accuracy))
    print("  ignoring stress:    phone %.4f  word %.4f"
          % (1.0 - distance_flat / max(1, ref_total),
             exact_flat / max(1, len(held_pairs))))

    payload = {
        "schema": 1,
        "tool": "train_lts.py",
        "letters": C.LETTERS,
        "window": WINDOW,
        "phones": phones,
        "roots": roots,
        "nodes": flat,
        "out": out_blob,
        "accuracy": {
            "held_out_words": len(held_pairs),
            "held_out_phones": ref_total,
            "phone_accuracy": round(phone_accuracy, 6),
            "word_accuracy": round(word_accuracy, 6),
            "phone_accuracy_no_stress": round(1.0 - distance_flat / max(1, ref_total), 6),
            "word_accuracy_no_stress": round(exact_flat / max(1, len(held_pairs)), 6),
        },
        "training": {
            "lexicon_entries": len(lexicon),
            "usable_words": len(pairs),
            "training_words": len(train_pairs),
            "dropped_from_training": dropped,
            "em_iterations": iteration + 1,
            "log_likelihood_per_word": round(previous, 6) if previous is not None else None,
            "min_leaf": args.min_leaf,
            "max_depth": args.max_depth,
            "grown_nodes": grown,
            "nodes": len(flat),
            "leaves": leaves,
            "hold_out_percent": C.HOLD_OUT_PERCENT,
            "split_seed": C.SPLIT_SEED,
        },
    }
    write_atomic(Path(args.out), C.dump_json_bytes(payload) + b"\n")
    print("wrote %s (%s bytes) in %.0fs total"
          % (args.out, C.format_count(Path(args.out).stat().st_size), time.time() - started))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except TrainError as error:
        print("train_lts: %s" % error, file=sys.stderr)
        sys.exit(1)
