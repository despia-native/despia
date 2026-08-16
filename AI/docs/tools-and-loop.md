# Tools and the agentic loop

Three sources feed one registry: module actions, page functions, and MCP
servers. The model sees one list of tools and does not know or care which is
which.

## Schemas

A module tool's JSON Schema is DERIVED from the action's declared arguments and
never restated, so it cannot drift from the contract it describes. A page or MCP
tool carries its own arbitrary JSON Schema through VERBATIM - `oneOf`, nested
objects, formats, all of it. Down-converting a foreign schema to a smaller
vocabulary would silently narrow what the model can express.

## The loop

The model emits tool calls, the host dispatches them, results round-trip as
`role: "tool"` messages, and the model resumes. Every hop is a `tool` stream
event, so a surface can render agent progress live rather than showing a spinner.

Four limits keep it honest:

- **Depth cap 32**, mirroring the action grammar. A model that keeps calling
  tools forever is stopped by the runtime, not by the battery.
- **Per-tool deadlines.** A hung page callback or MCP server yields a typed
  `tool_timeout` back to the MODEL, so the loop keeps running and the model can
  apologise instead of the app hanging.
- **No self-calls.** A tool that resolves back to the model running it is
  refused typed rather than deadlocking under single-flight.
- **Unknown tools answer typed.** Models invent tool names; `tool_unknown` goes
  back as the tool result and the next turn is the correction.

## Parallel dispatch

The wire shape is an array of tool blocks, so consecutive read-only calls
dispatch together. A tool that declares `mutates` runs alone.

## Approvals, and the rule that keeps them from wedging the app

A tool that mutates state runs under an approval policy: `auto`, `prompt`, or a
module veto. For `prompt` the approval happens BEFORE execution - the user
approves the call with its arguments, and a preview diff, if you show one, comes
from a shadow copy.

While an approval is pending the loop holds NO write lock and parks its engine
request. A concurrent app write and a concurrent completion both still succeed.
Every approval has a named timeout with a declared default disposition, so an
unanswered prompt resolves instead of hanging forever.

Execution then runs inside a savepoint with a pre-agent snapshot, committing or
rolling back atomically. That is what makes the sentence true rather than
aspirational: an agent can edit your local data, and there is always a backup
from before it touched anything.

## Tool descriptions are untrusted

A description is data written by whoever wrote the server. It reaches the model
tagged with its provenance, and it changes no policy: a description instructing
the runtime to skip approval gets a mutating tool approval-gated anyway.

## Structured output

`response_format: { type: "json_schema", schema: ... }` compiles to a grammar
constraint, so the JSON is well formed by construction rather than by hope, and
the answer arrives as a typed `json` block instead of text you parse hopefully.

## The transcript

Prompts, decisions, tool calls and approvals land in a local ring buffer you can
export from the dev drawer. It is never transmitted - a transcript that phoned
home would be the backdoor this whole package denies having.
