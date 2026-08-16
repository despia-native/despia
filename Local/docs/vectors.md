# Vectors and embedding provenance

Vectors live here rather than in the AI package, so an app has one store to back
up and one file to encrypt.

```
index.upsert  { index, key, vector, embedding, value }
index.search  { index, vector, embedding, k }  -> { hits: [{ key, value, distance }] }
index.info    { index }                        -> { count, embedding }
index.delete  { index, key }
index.reindex { index, embedding, vectors }
```

## Why every entry records its embedding

`embedding` is `{ model, dimension, revision }` and it is not optional metadata.
A new embedder silently invalidates every stored vector: the numbers still have
the right shape, the search still returns results, and the results are nonsense.
Nothing crashes, so nobody notices until a user does.

So a mismatch is a typed error with an explicit reindex path, and it names WHICH
kind of mismatch, because the fix differs:

- `dimension` - the widths disagree. The most common upgrade break.
- `model` - same width, different model. The dangerous one: without the model id
  this search would return confident nonsense.
- `revision` - same model, different version of it.

Mismatches are caught on the way IN as well as on the way out: an index is
homogeneous by construction, so the corrupting upsert fails rather than poisoning
every later search.

`index.reindex` is the escape hatch the error points at. Deleting a document
removes its vectors too - an orphaned vector is a wrong answer waiting to happen.

## Implementation note

The TypeScript binding stores vectors as JSON and scans them, which is honest for
a reference implementation and fine at fixture scale. The native bindings use
sqlite-vec for real indexes. The SEMANTICS above are what the corpus pins, and
they are identical either way.
