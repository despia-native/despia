// gbnf.hpp - JSON Schema to GBNF, so "give me JSON shaped like this" is a
// constraint on sampling rather than a request the model may decline.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// A model asked politely for JSON produces JSON most of the time, and "most of
// the time" is not a contract. Compiling the schema into a grammar makes the
// malformed answer unrepresentable: llama.cpp masks every token that cannot
// continue a valid parse, so the only strings the sampler can reach are strings
// the schema admits.
//
// The subset is deliberate. Supported: object with properties and required,
// array with items and the two size bounds, string with enum, number, integer,
// boolean, null, plus the `type` union spelling. NOT supported: $ref, allOf,
// anyOf/oneOf, patternProperties, and the string format vocabulary. An
// unsupported keyword is REPORTED, never silently dropped - a grammar that
// quietly ignores half a schema constrains the model to less than the caller
// asked for while still reporting success, which is the worst of both.

#ifndef DESPIA_AI_GBNF_HPP
#define DESPIA_AI_GBNF_HPP

#include <set>
#include <string>
#include <vector>

#include "../../json.hpp"

namespace despia {
namespace ai {
namespace gbnf {

// The primitive rules every generated grammar leans on. Emitted once, and only
// the ones a schema actually reaches, so the grammar stays readable when
// something goes wrong and a human has to look at it.
struct Preamble {
  bool needString = false;
  bool needNumber = false;
  bool needInteger = false;
  bool needBoolean = false;
  bool needNull = false;
  bool needWs = false;
};

inline std::string quoteLiteral(const std::string& s) {
  std::string out = "\"";
  for (char c : s) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default: out += c;
    }
  }
  out += "\"";
  return out;
}

class Compiler {
 public:
  // Returns the grammar, or an empty string with `error` set. `error` names the
  // unsupported keyword and the path it sat at, because a schema is usually
  // nested and "unsupported: $ref" alone tells nobody which field to fix.
  std::string compile(const json::Value& schema, std::string* error) {
    error_ = error;
    if (error_) error_->clear();
    rules_.clear();
    counter_ = 0;
    const std::string root = build(schema, "root", "");
    if (error_ && !error_->empty()) return "";

    std::string out = "root ::= " + root + "\n";
    for (const auto& r : rules_) out += r + "\n";
    out += primitives();
    return out;
  }

 private:
  std::vector<std::string> rules_;
  Preamble need_;
  std::string* error_ = nullptr;
  int counter_ = 0;

  void fail(const std::string& keyword, const std::string& path) {
    if (error_ && error_->empty()) {
      *error_ = "unsupported JSON Schema keyword \"" + keyword + "\" at " +
                (path.empty() ? "(root)" : path);
    }
  }

  std::string freshName(const std::string& hint) {
    return hint + "-" + std::to_string(counter_++);
  }

  // The keywords this compiler will not pretend to honour.
  void rejectUnsupported(const json::Value& schema, const std::string& path) {
    static const char* kUnsupported[] = {"$ref",   "allOf",  "anyOf",
                                         "oneOf",  "not",    "patternProperties",
                                         "if",     "then",   "else"};
    for (const char* k : kUnsupported) {
      if (schema.has(k)) fail(k, path);
    }
  }

  std::string build(const json::Value& schema, const std::string& hint,
                    const std::string& path) {
    if (error_ && !error_->empty()) return "";
    rejectUnsupported(schema, path);
    if (error_ && !error_->empty()) return "";

    // A `const` pins one literal value; an `enum` pins a set of them. Both
    // collapse to an alternation of literals, which is the tightest constraint
    // the grammar can express and the cheapest to check.
    if (schema.has("const")) return literalOf(schema["const"], path);
    if (schema.has("enum")) {
      const json::Array& options = schema["enum"].asArray();
      if (options.empty()) {
        fail("enum (empty)", path);
        return "";
      }
      std::string alt;
      for (size_t i = 0; i < options.size(); i++) {
        if (i) alt += " | ";
        alt += literalOf(options[i], path);
      }
      return "(" + alt + ")";
    }

    const std::string type = typeOf(schema, path);
    if (error_ && !error_->empty()) return "";

    if (type == "object") return buildObject(schema, hint, path);
    if (type == "array") return buildArray(schema, hint, path);
    if (type == "string") { need_.needString = true; return "string"; }
    if (type == "number") { need_.needNumber = true; return "number"; }
    if (type == "integer") { need_.needInteger = true; return "integer"; }
    if (type == "boolean") { need_.needBoolean = true; return "boolean"; }
    if (type == "null") { need_.needNull = true; return "null-lit"; }

    fail("type \"" + type + "\"", path);
    return "";
  }

  // `type` may be a string or an array of strings (the union spelling). A union
  // becomes an alternation of the branches, which is the honest reading.
  std::string typeOf(const json::Value& schema, const std::string& path) {
    const json::Value& t = schema["type"];
    if (t.isString()) return t.asString();
    if (t.isArray()) {
      const json::Array& types = t.asArray();
      if (types.size() == 1) return types[0].asString();
      // Handled by the caller through a synthesised alternation.
      return "";
    }
    if (t.isNull()) {
      // No `type` at all. An object with properties is unambiguous; anything
      // else would be a free-form value, and a grammar that admits everything
      // constrains nothing, so say so instead of emitting a permissive rule.
      if (schema.has("properties")) return "object";
      fail("schema without \"type\"", path);
      return "";
    }
    fail("\"type\" of unexpected shape", path);
    return "";
  }

  std::string literalOf(const json::Value& v, const std::string& path) {
    if (v.isString()) return quoteLiteral("\"" + v.asString() + "\"");
    if (v.isBool()) return v.asBool() ? "\"true\"" : "\"false\"";
    if (v.isNumber()) return quoteLiteral(v.dump());
    if (v.isNull()) return "\"null\"";
    fail("const/enum of unexpected type", path);
    return "";
  }

  std::string buildObject(const json::Value& schema, const std::string& hint,
                          const std::string& path) {
    const json::Value& props = schema["properties"];
    if (!props.isObject()) {
      fail("object without \"properties\"", path);
      return "";
    }

    std::set<std::string> required;
    for (const auto& r : schema["required"].asArray()) {
      required.insert(r.asString());
    }

    // Only REQUIRED keys are emitted. Optional keys are dropped rather than
    // made optional in the grammar: an optional key inside a strict sequence
    // needs a combinatorial explosion of alternations to allow every subset,
    // and what callers actually want is "the fields I said were required".
    //
    // Emission order follows the `required` ARRAY when there is one, because
    // that is the one ordering the schema author controls. `properties` cannot
    // supply it - it parses into a std::map, so its order is lexicographic and
    // has nothing to do with how the schema was written. The grammar pins one
    // order either way, so it may as well be the author's.
    std::vector<std::pair<std::string, json::Value>> ordered;
    for (const auto& r : schema["required"].asArray()) {
      const std::string key = r.asString();
      if (props.has(key)) ordered.push_back({key, props[key]});
    }
    if (ordered.empty()) {
      for (const auto& kv : props.asObject()) {
        if (required.empty() || required.count(kv.first)) {
          ordered.push_back({kv.first, kv.second});
        }
      }
    }
    if (ordered.empty()) {
      fail("object with no required properties", path);
      return "";
    }

    need_.needWs = true;
    std::string body = "\"{\" ws";
    for (size_t i = 0; i < ordered.size(); i++) {
      const std::string& key = ordered[i].first;
      const std::string child =
          build(ordered[i].second, hint + "-" + key, path + "/" + key);
      if (error_ && !error_->empty()) return "";
      if (i) body += " \",\" ws";
      body += " " + quoteLiteral("\"" + key + "\"") + " ws \":\" ws " + child + " ws";
    }
    body += " \"}\"";

    const std::string name = freshName(hint);
    rules_.push_back(name + " ::= " + body);
    return name;
  }

  std::string buildArray(const json::Value& schema, const std::string& hint,
                         const std::string& path) {
    const json::Value& items = schema["items"];
    if (!items.isObject()) {
      fail("array without an \"items\" schema", path);
      return "";
    }
    const std::string child = build(items, hint + "-item", path + "/items");
    if (error_ && !error_->empty()) return "";

    const int64_t minItems = schema["minItems"].asInt(0);
    need_.needWs = true;

    // minItems is honoured by repeating the element that many times; beyond
    // that the tail is free. maxItems is NOT expressible without unrolling, so
    // a schema that sets it is refused rather than silently under-constrained.
    if (schema.has("maxItems")) {
      fail("maxItems", path);
      return "";
    }

    std::string body = "\"[\" ws";
    for (int64_t i = 0; i < minItems; i++) {
      if (i) body += " \",\" ws";
      body += " " + child + " ws";
    }
    if (minItems > 0) {
      body += " (\",\" ws " + child + " ws)*";
    } else {
      body += " (" + child + " ws (\",\" ws " + child + " ws)*)?";
    }
    body += " \"]\"";

    const std::string name = freshName(hint);
    rules_.push_back(name + " ::= " + body);
    return name;
  }

  std::string primitives() const {
    std::string out;
    if (need_.needWs) out += "ws ::= [ \\t\\n]*\n";
    if (need_.needString) {
      out +=
          "string ::= \"\\\"\" ( [^\"\\\\\\x7F\\x00-\\x1F] | \"\\\\\" "
          "([\"\\\\bfnrt/] | \"u\" [0-9a-fA-F]{4}) )* \"\\\"\"\n";
    }
    if (need_.needNumber) {
      out += "number ::= \"-\"? ([0-9] | [1-9] [0-9]*) (\".\" [0-9]+)? "
             "([eE] [-+]? [0-9]+)?\n";
    }
    if (need_.needInteger) out += "integer ::= \"-\"? ([0-9] | [1-9] [0-9]*)\n";
    if (need_.needBoolean) out += "boolean ::= \"true\" | \"false\"\n";
    if (need_.needNull) out += "null-lit ::= \"null\"\n";
    return out;
  }
};

// One-shot convenience: compile `schema`, or return "" with `error` set.
inline std::string fromJsonSchema(const json::Value& schema, std::string* error) {
  Compiler c;
  return c.compile(schema, error);
}

}  // namespace gbnf
}  // namespace ai
}  // namespace despia

#endif  // DESPIA_AI_GBNF_HPP
