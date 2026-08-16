// gbnf_test.cpp - the JSON Schema to GBNF compiler, tested where it is cheap.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// The grammar compiler is pure logic over a schema, so unlike generation it
// needs no weights and no device. It is also the part of the GGUF backend most
// likely to be subtly wrong in a way nothing downstream would notice: a grammar
// that quietly admits more than the schema does still produces JSON, still
// looks like success, and only shows up as a malformed field in production.
//
// So the tests here are mostly about REFUSAL. Anyone can check that a valid
// schema compiles; the property worth defending is that an unsupported keyword
// fails loudly instead of being dropped on the floor.

#include <cstdio>
#include <string>

#include "../src/backends/gguf/gbnf.hpp"

namespace json = despia::json;
namespace gbnf = despia::ai::gbnf;

namespace {

int g_failures = 0;

void check(bool cond, const char* what) {
  if (cond) {
    std::printf("  ok   %s\n", what);
  } else {
    std::printf("  FAIL %s\n", what);
    g_failures++;
  }
}

json::Value parse(const std::string& text) {
  std::string err;
  json::Value v = json::parse(text, &err);
  if (!err.empty()) std::printf("  (fixture did not parse: %s)\n", err.c_str());
  return v;
}

bool contains(const std::string& haystack, const std::string& needle) {
  return haystack.find(needle) != std::string::npos;
}

}  // namespace

int main() {
  std::printf("gbnf_test\n");

  // ── the shapes that must compile ───────────────────────────────────────────
  {
    std::string err;
    const std::string g = gbnf::fromJsonSchema(
        parse(R"({"type":"object","properties":{"name":{"type":"string"},
                 "age":{"type":"integer"}},"required":["name","age"]})"),
        &err);
    check(!g.empty() && err.empty(), "an object with required fields compiles");
    check(contains(g, "root ::="), "the grammar has a root rule");
    check(contains(g, "string ::="), "the string primitive is emitted when reached");
    check(contains(g, "integer ::="), "the integer primitive is emitted when reached");
  }

  {
    // Only the primitives a schema actually reaches are emitted, so a human
    // reading a broken grammar is not wading through rules nothing references.
    std::string err;
    const std::string g = gbnf::fromJsonSchema(
        parse(R"({"type":"object","properties":{"ok":{"type":"boolean"}},
                 "required":["ok"]})"),
        &err);
    check(!contains(g, "number ::="), "an unreached primitive is not emitted");
    check(contains(g, "boolean ::="), "the reached one is");
  }

  {
    std::string err;
    const std::string g = gbnf::fromJsonSchema(
        parse(R"({"type":"array","items":{"type":"string"},"minItems":2})"), &err);
    check(!g.empty() && err.empty(), "an array with minItems compiles");
  }

  {
    std::string err;
    const std::string g = gbnf::fromJsonSchema(
        parse(R"({"type":"string","enum":["red","green"]})"), &err);
    check(err.empty() && contains(g, "red") && contains(g, "green"),
          "an enum becomes an alternation of literals");
  }

  // ── key order follows `required`, not the map ──────────────────────────────
  {
    // `properties` parses into a std::map, so its iteration order is
    // lexicographic. If the compiler took its order from there, "zebra" would
    // follow "apple" regardless of what the author wrote. It must not.
    std::string err;
    const std::string g = gbnf::fromJsonSchema(
        parse(R"({"type":"object","properties":{"apple":{"type":"string"},
                 "zebra":{"type":"string"}},"required":["zebra","apple"]})"),
        &err);
    const size_t zebra = g.find("zebra");
    const size_t apple = g.find("apple");
    check(err.empty() && zebra != std::string::npos && zebra < apple,
          "emission order follows the required array, not the property map");
  }

  // ── the refusals: an unsupported keyword must fail LOUDLY ──────────────────
  {
    std::string err;
    const std::string g = gbnf::fromJsonSchema(parse(R"({"$ref":"#/defs/x"})"), &err);
    check(g.empty() && contains(err, "$ref"), "$ref is refused and named");
  }
  {
    std::string err;
    const std::string g = gbnf::fromJsonSchema(
        parse(R"({"anyOf":[{"type":"string"},{"type":"integer"}]})"), &err);
    check(g.empty() && contains(err, "anyOf"), "anyOf is refused and named");
  }
  {
    std::string err;
    const std::string g = gbnf::fromJsonSchema(
        parse(R"({"type":"array","items":{"type":"string"},"maxItems":3})"), &err);
    check(g.empty() && contains(err, "maxItems"),
          "maxItems is refused rather than silently ignored");
  }
  {
    // The nested case is the one that matters: a schema is usually deep, and
    // "unsupported: allOf" with no location tells nobody which field to fix.
    std::string err;
    const std::string g = gbnf::fromJsonSchema(
        parse(R"({"type":"object","properties":{"inner":{"allOf":[{"type":"string"}]}},
                 "required":["inner"]})"),
        &err);
    check(g.empty() && contains(err, "allOf") && contains(err, "/inner"),
          "a nested refusal names the path that used the keyword");
  }
  {
    std::string err;
    const std::string g = gbnf::fromJsonSchema(parse(R"({"type":"object"})"), &err);
    check(g.empty() && !err.empty(),
          "an object with no properties is refused, not compiled to anything-goes");
  }
  {
    std::string err;
    const std::string g = gbnf::fromJsonSchema(parse(R"({"type":"array"})"), &err);
    check(g.empty() && !err.empty(), "an array with no items schema is refused");
  }
  {
    std::string err;
    const std::string g = gbnf::fromJsonSchema(parse(R"({"minimum":3})"), &err);
    check(g.empty() && !err.empty(), "a schema with no type at all is refused");
  }

  // ── quoting: a key containing a quote must not break out of the literal ────
  {
    std::string err;
    const std::string g = gbnf::fromJsonSchema(
        parse(R"({"type":"object","properties":{"say\"hi":{"type":"string"}},
                 "required":["say\"hi"]})"),
        &err);
    check(err.empty() && contains(g, "\\\""),
          "a quote inside a key is escaped rather than ending the literal");
  }

  if (g_failures == 0) {
    std::printf("\nall checks passed\n");
    return 0;
  }
  std::printf("\n%d failure(s)\n", g_failures);
  return 1;
}
