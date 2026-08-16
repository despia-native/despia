import { test } from "node:test";
import assert from "node:assert/strict";

import { compileComponent } from "../../compiler/src/component.ts";
import type { Registry } from "../../compiler/src/resolve.ts";
import { renderToString } from "../src/render.ts";

test("SSR gives every browser-native control a semantic, non-placeholder first paint", () => {
  const component = compileComponent("NativeControls", "t", `<stack>
    <head>
      <variable as="plan">return "pro"</variable>
      <variable as="choices">return [{ id: "free", label: "Free" }, { id: "pro", label: "Pro" }]</variable>
      <variable as="when">return "2026-07-23T09:45:00Z"</variable>
      <variable as="query">return "Ber"</variable>
      <variable as="code">return "12"</variable>
      <variable as="low">return 20</variable>
      <variable as="high">return 80</variable>
    </head>
    <picker bind="plan" optionsKey="choices" label="Plan"/>
    <wheelpicker bind="plan" options="free,pro" label="Plan wheel"/>
    <datepicker bind="when" mode="datetime" label="Departure"/>
    <date bind="when" mode="date"/>
    <combobox bind="query" options="Berlin,Paris" placeholder="City"/>
    <otp bind="code" length="4"/>
    <rangeslider bindLow="low" bindHigh="high" min="0" max="100" step="5"/>
  </stack>`);
  const registry: Registry = {
    components: { "t.NativeControls": component }, globalPool: {}, css: "", schemes: [],
  };
  const html = renderToString(registry, "t.NativeControls");

  assert.ok(!html.includes("dsx-unsupported"));
  assert.ok(html.includes('<select class="dsx-picker-select" aria-label="Plan">'));
  assert.ok(html.includes('<option value="pro" selected>Pro</option>'));
  assert.ok(html.includes('<select class="dsx-wheelpicker-select" size="5"'));
  assert.ok(html.includes('class="dsx-datepicker-input" type="datetime-local" value="2026-07-23T09:45"'));
  assert.ok(html.includes('class="dsx-datepicker-input" type="date" value="2026-07-23"'));
  assert.ok(html.includes('class="dsx-combobox-input" type="text" value="Ber"'));
  assert.ok(html.includes('role="combobox"'));
  assert.equal(html.split('class="dsx-otp-box"').length - 1, 4);
  assert.equal(html.split('type="range"').length - 1, 2);
  assert.ok(html.includes('role="group"'));
  assert.ok(html.includes('aria-label="Lower value"'));
  assert.ok(html.includes('aria-label="Upper value"'));
  assert.ok(!html.includes("--dsx-control-tint"), "absent color uses the weak author-overridable CSS default");
  assert.ok(!html.includes("--dsx-otp-box-size"), "absent boxSize uses the weak author-overridable CSS default");
});

test("SSR keeps hostile control geometry and option allocation bounded", () => {
  const component = compileComponent("Hostile", "t", `<stack>
    <head>
      <variable as="code">return "1a2b3c4d5e6f"</variable>
      <variable as="low">return -1e9</variable>
      <variable as="high">return 1e9</variable>
    </head>
    <otp bind="code" length="1000000" boxSize="1000000"/>
    <rangeslider bindLow="low" bindHigh="high" min="100" max="0" step="-5"/>
  </stack>`);
  const registry: Registry = { components: { "t.Hostile": component }, globalPool: {}, css: "", schemes: [] };
  const html = renderToString(registry, "t.Hostile");
  assert.equal(html.split('class="dsx-otp-box"').length - 1, 32);
  assert.ok(html.includes("--dsx-otp-box-size: 96px"));
  assert.ok(html.includes('min="0"'));
  assert.ok(html.includes('max="100"'));
  assert.ok(html.length < 20_000);
});

test("SSR and client share low-first ordering for crossed range bindings", () => {
  const component = compileComponent("Crossed", "t", `<rangeslider bindLow="low" bindHigh="high" min="0" max="100">
    <head><variable as="low">return 90</variable><variable as="high">return 80</variable></head>
  </rangeslider>`);
  const registry: Registry = { components: { "t.Crossed": component }, globalPool: {}, css: "", schemes: [] };
  const html = renderToString(registry, "t.Crossed");
  assert.ok(html.includes("--dsx-range-low: 90%"));
  assert.ok(html.includes("--dsx-range-high: 90%"));
  assert.ok(html.includes('aria-valuenow="90"'));
});
