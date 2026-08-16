// json.hpp - the engine's own JSON value, parser and serializer.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// The C ABI speaks JSON, so the core needs a JSON implementation - and the core
// is dependency-free by constitution, so it is this one rather than a vendored
// library that would need its own NOTICE line, its own pin, and its own CVE
// watch. It is deliberately small: parse, dump, and the accessors the engine
// actually uses.
//
// Two properties the rest of the engine relies on:
//   - Object keys are stored sorted, so dump() is byte-stable. Fixtures compare
//     payload sizes; a map whose iteration order changed between runs would
//     make that assertion flaky.
//   - Unknown keys survive a parse/dump round trip untouched. That is the
//     must-ignore law's mechanical half: an envelope carrying fields this build
//     has never heard of passes through instead of being silently dropped.

#ifndef DESPIA_AI_JSON_HPP
#define DESPIA_AI_JSON_HPP

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <string>
#include <vector>

namespace despia {
namespace json {

class Value;
using Object = std::map<std::string, Value>;
using Array = std::vector<Value>;

class Value {
 public:
  enum class Type { Null, Bool, Number, String, Array, Object };

  Value() : type_(Type::Null) {}
  Value(bool b) : type_(Type::Bool), bool_(b) {}
  Value(double n) : type_(Type::Number), num_(n) {}
  Value(int n) : type_(Type::Number), num_(static_cast<double>(n)) {}
  Value(const char* s) : type_(Type::String), str_(s ? s : "") {}
  Value(std::string s) : type_(Type::String), str_(std::move(s)) {}
  Value(Array a) : type_(Type::Array), arr_(std::move(a)) {}
  Value(Object o) : type_(Type::Object), obj_(std::move(o)) {}

  Type type() const { return type_; }
  bool isNull() const { return type_ == Type::Null; }
  bool isBool() const { return type_ == Type::Bool; }
  bool isNumber() const { return type_ == Type::Number; }
  bool isString() const { return type_ == Type::String; }
  bool isArray() const { return type_ == Type::Array; }
  bool isObject() const { return type_ == Type::Object; }

  bool asBool(bool fallback = false) const { return isBool() ? bool_ : fallback; }
  double asNumber(double fallback = 0) const { return isNumber() ? num_ : fallback; }
  int64_t asInt(int64_t fallback = 0) const {
    return isNumber() ? static_cast<int64_t>(num_) : fallback;
  }
  const std::string& asString() const {
    static const std::string kEmpty;
    return isString() ? str_ : kEmpty;
  }
  std::string asString(const std::string& fallback) const {
    return isString() ? str_ : fallback;
  }
  const Array& asArray() const {
    static const Array kEmpty;
    return isArray() ? arr_ : kEmpty;
  }
  const Object& asObject() const {
    static const Object kEmpty;
    return isObject() ? obj_ : kEmpty;
  }
  Array& array() {
    if (!isArray()) { type_ = Type::Array; arr_.clear(); }
    return arr_;
  }
  Object& object() {
    if (!isObject()) { type_ = Type::Object; obj_.clear(); }
    return obj_;
  }

  // Reading a key that is not there yields Null rather than throwing: a
  // must-ignore consumer asks for fields it may not get, constantly.
  const Value& operator[](const std::string& key) const {
    static const Value kNull;
    if (!isObject()) return kNull;
    auto it = obj_.find(key);
    return it == obj_.end() ? kNull : it->second;
  }
  bool has(const std::string& key) const {
    return isObject() && obj_.find(key) != obj_.end();
  }
  void set(const std::string& key, Value v) { object()[key] = std::move(v); }
  void push(Value v) { array().push_back(std::move(v)); }
  size_t size() const {
    return isArray() ? arr_.size() : (isObject() ? obj_.size() : 0);
  }

  static Value obj() { return Value(Object{}); }
  static Value arr() { return Value(Array{}); }

  std::string dump() const {
    std::string out;
    dumpTo(out);
    return out;
  }
  void dumpTo(std::string& out) const;

 private:
  Type type_;
  bool bool_ = false;
  double num_ = 0;
  std::string str_;
  Array arr_;
  Object obj_;
};

// Parses `text`. On failure returns Null and, when `err` is non-null, sets it
// to a human-readable reason. The parser is bounded: it refuses input past
// kMaxDepth so a hostile envelope cannot blow the stack, which matters because
// D16 lets arbitrary origins reach this code.
Value parse(const std::string& text, std::string* err = nullptr);

constexpr int kMaxDepth = 64;

// --- implementation ---------------------------------------------------

inline void escapeTo(const std::string& s, std::string& out) {
  out.push_back('"');
  for (unsigned char c : s) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      case '\b': out += "\\b"; break;
      case '\f': out += "\\f"; break;
      default:
        if (c < 0x20) {
          static const char* kHex = "0123456789abcdef";
          out += "\\u00";
          out.push_back(kHex[(c >> 4) & 0xF]);
          out.push_back(kHex[c & 0xF]);
        } else {
          out.push_back(static_cast<char>(c));
        }
    }
  }
  out.push_back('"');
}

inline void dumpNumberTo(double n, std::string& out) {
  if (std::isfinite(n) && n == static_cast<double>(static_cast<int64_t>(n)) &&
      n < 9e15 && n > -9e15) {
    out += std::to_string(static_cast<int64_t>(n));
    return;
  }
  if (!std::isfinite(n)) { out += "null"; return; }
  char buf[40];
  snprintf(buf, sizeof(buf), "%.17g", n);
  // Trim to the shortest representation that round-trips, so dumps stay stable.
  for (int prec = 1; prec <= 17; ++prec) {
    char probe[40];
    snprintf(probe, sizeof(probe), "%.*g", prec, n);
    if (strtod(probe, nullptr) == n) { out += probe; return; }
  }
  out += buf;
}

inline void Value::dumpTo(std::string& out) const {
  switch (type_) {
    case Type::Null: out += "null"; return;
    case Type::Bool: out += bool_ ? "true" : "false"; return;
    case Type::Number: dumpNumberTo(num_, out); return;
    case Type::String: escapeTo(str_, out); return;
    case Type::Array: {
      out.push_back('[');
      bool first = true;
      for (const auto& v : arr_) {
        if (!first) out.push_back(',');
        first = false;
        v.dumpTo(out);
      }
      out.push_back(']');
      return;
    }
    case Type::Object: {
      out.push_back('{');
      bool first = true;
      for (const auto& kv : obj_) {
        if (!first) out.push_back(',');
        first = false;
        escapeTo(kv.first, out);
        out.push_back(':');
        kv.second.dumpTo(out);
      }
      out.push_back('}');
      return;
    }
  }
}

namespace detail {

struct Parser {
  const std::string& s;
  size_t i = 0;
  int depth = 0;
  std::string err;

  explicit Parser(const std::string& text) : s(text) {}

  void skipWs() {
    while (i < s.size() && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) ++i;
  }
  bool fail(const std::string& why) {
    if (err.empty()) err = why + " at offset " + std::to_string(i);
    return false;
  }
  bool parseValue(Value& out);
  bool parseString(std::string& out);
  bool parseNumber(Value& out);
};

inline bool Parser::parseString(std::string& out) {
  if (i >= s.size() || s[i] != '"') return fail("expected string");
  ++i;
  out.clear();
  while (i < s.size()) {
    char c = s[i++];
    if (c == '"') return true;
    if (c != '\\') { out.push_back(c); continue; }
    if (i >= s.size()) return fail("truncated escape");
    char e = s[i++];
    switch (e) {
      case '"': out.push_back('"'); break;
      case '\\': out.push_back('\\'); break;
      case '/': out.push_back('/'); break;
      case 'n': out.push_back('\n'); break;
      case 'r': out.push_back('\r'); break;
      case 't': out.push_back('\t'); break;
      case 'b': out.push_back('\b'); break;
      case 'f': out.push_back('\f'); break;
      case 'u': {
        if (i + 4 > s.size()) return fail("truncated \\u escape");
        unsigned cp = 0;
        for (int k = 0; k < 4; ++k) {
          char h = s[i + k];
          cp <<= 4;
          if (h >= '0' && h <= '9') cp |= unsigned(h - '0');
          else if (h >= 'a' && h <= 'f') cp |= unsigned(h - 'a' + 10);
          else if (h >= 'A' && h <= 'F') cp |= unsigned(h - 'A' + 10);
          else return fail("bad \\u escape");
        }
        i += 4;
        // Surrogate pair, when the low half follows.
        if (cp >= 0xD800 && cp <= 0xDBFF && i + 6 <= s.size() && s[i] == '\\' && s[i + 1] == 'u') {
          unsigned lo = 0;
          bool ok = true;
          for (int k = 0; k < 4; ++k) {
            char h = s[i + 2 + k];
            lo <<= 4;
            if (h >= '0' && h <= '9') lo |= unsigned(h - '0');
            else if (h >= 'a' && h <= 'f') lo |= unsigned(h - 'a' + 10);
            else if (h >= 'A' && h <= 'F') lo |= unsigned(h - 'A' + 10);
            else { ok = false; break; }
          }
          if (ok && lo >= 0xDC00 && lo <= 0xDFFF) {
            cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
            i += 6;
          }
        }
        if (cp < 0x80) {
          out.push_back(char(cp));
        } else if (cp < 0x800) {
          out.push_back(char(0xC0 | (cp >> 6)));
          out.push_back(char(0x80 | (cp & 0x3F)));
        } else if (cp < 0x10000) {
          out.push_back(char(0xE0 | (cp >> 12)));
          out.push_back(char(0x80 | ((cp >> 6) & 0x3F)));
          out.push_back(char(0x80 | (cp & 0x3F)));
        } else {
          out.push_back(char(0xF0 | (cp >> 18)));
          out.push_back(char(0x80 | ((cp >> 12) & 0x3F)));
          out.push_back(char(0x80 | ((cp >> 6) & 0x3F)));
          out.push_back(char(0x80 | (cp & 0x3F)));
        }
        break;
      }
      default: return fail("unknown escape");
    }
  }
  return fail("unterminated string");
}

inline bool Parser::parseNumber(Value& out) {
  size_t start = i;
  if (i < s.size() && (s[i] == '-' || s[i] == '+')) ++i;
  bool any = false;
  while (i < s.size() && s[i] >= '0' && s[i] <= '9') { ++i; any = true; }
  if (i < s.size() && s[i] == '.') {
    ++i;
    while (i < s.size() && s[i] >= '0' && s[i] <= '9') { ++i; any = true; }
  }
  if (any && i < s.size() && (s[i] == 'e' || s[i] == 'E')) {
    ++i;
    if (i < s.size() && (s[i] == '-' || s[i] == '+')) ++i;
    while (i < s.size() && s[i] >= '0' && s[i] <= '9') ++i;
  }
  if (!any) return fail("expected number");
  out = Value(strtod(s.substr(start, i - start).c_str(), nullptr));
  return true;
}

inline bool Parser::parseValue(Value& out) {
  if (++depth > kMaxDepth) return fail("nesting too deep");
  struct DepthGuard {
    int& d;
    ~DepthGuard() { --d; }
  } guard{depth};

  skipWs();
  if (i >= s.size()) return fail("unexpected end of input");
  char c = s[i];
  if (c == '{') {
    ++i;
    Object o;
    skipWs();
    if (i < s.size() && s[i] == '}') { ++i; out = Value(std::move(o)); return true; }
    for (;;) {
      skipWs();
      std::string key;
      if (!parseString(key)) return false;
      skipWs();
      if (i >= s.size() || s[i] != ':') return fail("expected ':'");
      ++i;
      Value v;
      if (!parseValue(v)) return false;
      o[key] = std::move(v);
      skipWs();
      if (i < s.size() && s[i] == ',') { ++i; continue; }
      if (i < s.size() && s[i] == '}') { ++i; break; }
      return fail("expected ',' or '}'");
    }
    out = Value(std::move(o));
    return true;
  }
  if (c == '[') {
    ++i;
    Array a;
    skipWs();
    if (i < s.size() && s[i] == ']') { ++i; out = Value(std::move(a)); return true; }
    for (;;) {
      Value v;
      if (!parseValue(v)) return false;
      a.push_back(std::move(v));
      skipWs();
      if (i < s.size() && s[i] == ',') { ++i; continue; }
      if (i < s.size() && s[i] == ']') { ++i; break; }
      return fail("expected ',' or ']'");
    }
    out = Value(std::move(a));
    return true;
  }
  if (c == '"') {
    std::string str;
    if (!parseString(str)) return false;
    out = Value(std::move(str));
    return true;
  }
  if (s.compare(i, 4, "true") == 0) { i += 4; out = Value(true); return true; }
  if (s.compare(i, 5, "false") == 0) { i += 5; out = Value(false); return true; }
  if (s.compare(i, 4, "null") == 0) { i += 4; out = Value(); return true; }
  return parseNumber(out);
}

}  // namespace detail

inline Value parse(const std::string& text, std::string* err) {
  detail::Parser p(text);
  Value v;
  if (!p.parseValue(v)) {
    if (err) *err = p.err;
    return Value();
  }
  p.skipWs();
  if (p.i != text.size()) {
    if (err) *err = "trailing content at offset " + std::to_string(p.i);
    return Value();
  }
  if (err) err->clear();
  return v;
}

}  // namespace json
}  // namespace despia

#endif  // DESPIA_AI_JSON_HPP
