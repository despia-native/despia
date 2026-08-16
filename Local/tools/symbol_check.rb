#!/usr/bin/env ruby
# frozen_string_literal: true
#
# symbol_check.rb — the empirical half of the Android rule.
#
#   ruby tools/symbol_check.rb [path/to/libdespia_local.so] [--nm <tool>]
#
# THE RULE (vendor/VERSIONS, engine/include/despia_local.h): libdespia_local
# exports the despia_local_* ABI and NOTHING else. In particular no sqlite3_*
# and no vec_*.
#
# It is not tidiness. This library statically links its own SQLite, and a
# Despia app can carry a sync vendor that ships another one (PowerSync does).
# Two libraries exporting sqlite3_* into one process is a load-order coin
# flip — the vendor's calls bind to our SQLite or ours to theirs, whichever
# the dynamic linker resolved first — and the failure surfaces as database
# corruption rather than as a link error. Three build-time layers make that
# impossible (hidden visibility, SQLite's own SQLITE_API define, an export
# map); this is the fourth, and it is the only one that looks at the artifact
# that actually ships.
#
# Run it on every .so a lane produces, including the per-ABI Android ones:
#
#   ruby tools/symbol_check.rb build/libdespia_local.so
#   ruby tools/symbol_check.rb bindings/kotlin/build/.../arm64-v8a/libdespia_local.so \
#        --nm $ANDROID_NDK/toolchains/llvm/prebuilt/*/bin/llvm-nm
#
# Stdlib-only, no gems. Exits 0 when the artifact is clean, 1 when it is not.

require "open3"

# The complete exported surface, from engine/include/despia_local.h. Adding a
# symbol here without adding it to the header (or the reverse) is exactly the
# drift this list exists to catch, so the check is an EQUALITY, not a subset:
# an export that no consumer was told about is as much a bug as a missing one.
EXPECTED = %w[
  despia_local_abi_version
  despia_local_call
  despia_local_capabilities
  despia_local_close
  despia_local_free
  despia_local_last_error
  despia_local_open
  despia_local_reopen
].freeze

# Named rather than derived, because these are the two that cost real money:
# a duplicate SQLite is silent corruption, and a duplicate sqlite-vec is a
# vtable registered twice on someone else's connection.
FORBIDDEN = [
  [/\Asqlite3/, "SQLite"],
  [/\Avec_|\Avec0|_vec_init\z/, "sqlite-vec"]
].freeze

def die(message)
  warn "[symbol_check] #{message}"
  exit 1
end

args = ARGV.dup
nm = "nm"
if (i = args.index("--nm"))
  nm = args[i + 1] or die("--nm needs a tool path")
  args.slice!(i, 2)
end
library = args.shift || File.join(__dir__, "..", "build", "libdespia_local.so")
die("no such library: #{library}") unless File.file?(library)

# --defined-only: the DYNAMIC table's definitions. Undefined entries are the
# libc/libm imports every shared object has and say nothing about what this one
# offers to the process.
stdout, stderr, status = Open3.capture3(nm, "-D", "--defined-only", library)
unless status.success?
  die("#{nm} failed on #{library}: #{stderr.strip}")
end

# `<addr> <type> <name>` on ELF; Mach-O nm prints the same three columns with a
# leading underscore on the name, which is stripped so one list serves both.
exported = stdout.lines.filter_map do |line|
  fields = line.split
  next if fields.size < 3

  type = fields[-2]
  name = fields[-1]
  # Weak and unique definitions count: a consumer can bind to them.
  next unless %w[T t W w D d B b V v R r i u].include?(type)

  name.sub(/\A_/, "")
end.uniq.sort

leaks = exported.reject { |name| EXPECTED.include?(name) }
missing = EXPECTED - exported

unless leaks.empty?
  by_reason = leaks.group_by do |name|
    match = FORBIDDEN.find { |pattern, _| name.match?(pattern) }
    match ? match[1] : "not in the header"
  end
  warn "[symbol_check] #{library}"
  by_reason.each do |reason, names|
    warn "  #{names.size} leaked symbol(s) — #{reason}:"
    names.first(20).each { |name| warn "    #{name}" }
    warn "    … and #{names.size - 20} more" if names.size > 20
  end
  die("the library exports symbols it must not. A sync vendor's own SQLite " \
      "and this one cannot coexist in a process where both are visible.")
end

unless missing.empty?
  die("#{library} is missing #{missing.size} of the ABI: #{missing.join(', ')}. " \
      "An export map that hides too much is as broken as one that hides too little.")
end

puts "[symbol_check] #{library}: #{exported.size} exported symbols, " \
     "exactly the despia_local_* ABI — 0 sqlite3_*, 0 vec_*."
