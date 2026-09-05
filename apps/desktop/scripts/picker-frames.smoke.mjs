// Run explicitly with Chromium installed: node apps/desktop/scripts/picker-frames.smoke.mjs
// Optional arguments: live editor URL, evidence directory. Never launches the installed app.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { build } from "vite-plus";
import { chromium } from "playwright-core";

const entry = NodeURL.fileURLToPath(new URL("../src/preview/PickPreload.ts", import.meta.url));
const result = await build({
  configFile: false,
  logLevel: "error",
  plugins: [
    {
      name: "picker-ipc-harness",
      enforce: "pre",
      resolveId(id) {
        if (id === "electron") return "\0picker-ipc";
      },
      load(id) {
        if (id !== "\0picker-ipc") return;
        return `const listeners = new Map();
        globalThis.pickerMessages = [];
        globalThis.pickerEmit = (channel, ...args) => {
          for (const fn of [...(listeners.get(channel) ?? [])]) fn({}, ...args);
        };
        export const ipcRenderer = {
          on(channel, fn) { listeners.set(channel, [...(listeners.get(channel) ?? []), fn]); return this; },
          off(channel, fn) { listeners.set(channel, (listeners.get(channel) ?? []).filter(x => x !== fn)); return this; },
          send(channel, ...args) { globalThis.pickerMessages.push({channel, args}); }
        };`;
      },
    },
  ],
  build: { write: false, minify: false, lib: { entry, formats: ["iife"], name: "PickerSmoke" } },
});
const bundle = (Array.isArray(result) ? result[0] : result).output.find(
  (x) => x.type === "chunk",
).code;
const browser = await chromium.launch({ headless: true });
const [liveUrl, evidenceDir, liveTarget = ".document-title"] = process.argv.slice(2);
if (evidenceDir) await NodeFSP.mkdir(evidenceDir, { recursive: true });

async function install(page) {
  // Retain a test-only reference to the closed root without changing its mode.
  await page.evaluate(() => {
    const original = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (options) {
      const root = original.call(this, options);
      if (this.hasAttribute("data-t3code-annotation-ui")) globalThis.pickerRoot = root;
      return root;
    };
  });
  await page.evaluate(bundle);
  await page.evaluate(() => pickerEmit("preview:start-pick"));
}

async function attach(page, expected, name) {
  NodeAssert.equal(
    await page.evaluate(
      () =>
        [...pickerRoot.querySelectorAll("button")].find((x) => x.textContent === "Attach").disabled,
    ),
    false,
    `${name}: target selected`,
  );
  await page.evaluate(() => {
    pickerRoot.querySelector("textarea").value = "Frame annotation regression";
    [...pickerRoot.querySelectorAll("button")].find((x) => x.textContent === "Attach").click();
  });
  await page.waitForFunction(() =>
    pickerMessages.some((x) => x.channel === "preview:element-picked"),
  );
  const message = await page.evaluate(() =>
    pickerMessages.find((x) => x.channel === "preview:element-picked"),
  );
  const [annotation, crop, submission] = message.args;
  NodeAssert.equal(submission, "attach");
  NodeAssert.equal(annotation.comment, "Frame annotation regression");
  NodeAssert.equal(annotation.elements.length, 1);
  NodeAssert.match(annotation.elements[0].element.htmlPreview, expected);
  NodeAssert.equal(annotation.pageUrl, page.url());
  NodeAssert.equal(
    await page.evaluate((picked) => {
      let owner = document;
      for (const frame of picked.framePath ?? []) {
        if (owner.URL !== frame.pageUrl) return false;
        owner = owner.querySelector(frame.selector)?.contentDocument;
        if (!owner) return false;
      }
      return (
        owner.URL === picked.pageUrl &&
        (owner.title.trim() || null) === picked.pageTitle &&
        (!picked.selector || owner.querySelector(picked.selector)?.localName === picked.tagName)
      );
    }, annotation.elements[0].element),
    true,
    "frame path and selector resolve in the captured document",
  );
  const rect = annotation.elements[0].rect;
  NodeAssert.ok(crop.x <= rect.x && crop.y <= rect.y);
  NodeAssert.ok(crop.x + crop.width >= rect.x + rect.width - 1);
  NodeAssert.ok(crop.y + crop.height >= rect.y + rect.height - 1);
  const screenshot = await page.screenshot({ clip: crop, timeout: 10000 });
  NodeAssert.ok(screenshot.length > 100);
  if (evidenceDir) {
    await NodeFSP.writeFile(NodePath.join(evidenceDir, `${name}.png`), screenshot);
    await NodeFSP.writeFile(
      NodePath.join(evidenceDir, `${name}.json`),
      JSON.stringify({ annotation, crop, submission }, null, 2),
    );
  }
  await page.evaluate(() => pickerEmit("preview:annotation-captured"));
  NodeAssert.equal(await page.locator("[data-t3code-annotation-ui]").count(), 0);
  return rect;
}

try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setContent(`<style>body{margin:0;padding:80px}iframe{display:block;width:600px;height:500px;border:8px solid #555;transform:scale(.8);transform-origin:top left}</style>
    <button id="top">Top target</button><iframe id="outer"></iframe>`);
  await page.locator("#outer").evaluate((frame) => {
    frame.srcdoc = `<style>body{margin:0;padding:40px}iframe{width:400px;height:300px;border:6px solid blue}</style><iframe id="inner" srcdoc='<body style="margin:0;height:1200px"><button id="target" style="margin:50px;width:180px;height:60px">Nested frame target</button>'></iframe>`;
  });
  const target = page.frameLocator("#outer").frameLocator("#inner").locator("#target");
  await target.waitFor();
  await target.evaluate((element) =>
    element.addEventListener("click", () => (element.dataset.clicked = "yes")),
  );
  if (evidenceDir) await page.screenshot({ path: NodePath.join(evidenceDir, "nested-before.png") });
  await install(page);
  await target.click();
  NodeAssert.equal(await target.getAttribute("data-clicked"), null);
  const expected = await target.boundingBox();
  const humanPointer = await page.evaluate(
    () =>
      pickerMessages.find(
        (message) =>
          message.channel === "preview:human-input" && message.args[0].kind === "pointer",
      )?.args[0],
  );
  NodeAssert.ok(humanPointer, "frame clicks report human control");
  NodeAssert.ok(Math.abs(humanPointer.x - (expected.x + expected.width / 2)) < 1);
  NodeAssert.ok(Math.abs(humanPointer.y - (expected.y + expected.height / 2)) < 1);
  const rect = await attach(page, /Nested frame target/, "nested-frames");
  for (const key of ["x", "y", "width", "height"])
    NodeAssert.ok(
      Math.abs(rect[key] - expected[key]) < 1,
      `${key}: ${rect[key]} vs ${expected[key]}`,
    );
  await target.click();
  NodeAssert.equal(
    await target.getAttribute("data-clicked"),
    "yes",
    "capture must restore page input",
  );

  await page.evaluate(() => {
    pickerMessages.length = 0;
    pickerEmit("preview:start-pick");
  });
  await page.locator("#top").click();
  await attach(page, /Top target/, "top-document");

  await page.evaluate(() => {
    pickerMessages.length = 0;
    pickerEmit("preview:start-pick");
    [...pickerRoot.querySelectorAll("button")].find((x) => x.textContent === "Region").click();
  });
  const marqueeTarget = await target.boundingBox();
  await page.mouse.move(marqueeTarget.x - 2, marqueeTarget.y - 2);
  await page.mouse.down();
  await page.mouse.move(
    marqueeTarget.x + marqueeTarget.width + 2,
    marqueeTarget.y + marqueeTarget.height + 2,
  );
  await page.mouse.up();
  await attach(page, /Nested frame target/, "frame-marquee");

  // Scroll and style editing operate across realms, and Escape restores page state.
  await page.evaluate(() => {
    pickerMessages.length = 0;
    pickerEmit("preview:start-pick");
  });
  await target.click();
  await target.evaluate((element) => element.ownerDocument.defaultView.scrollTo(0, 30));
  const scrolled = await target.boundingBox();
  await page.waitForFunction(
    (expected) =>
      [...pickerRoot.querySelectorAll("div")].some(
        (node) =>
          node.style.border.startsWith("2px") &&
          node.style.display === "block" &&
          Math.abs(node.getBoundingClientRect().y - expected.y) < 1 &&
          Math.abs(node.getBoundingClientRect().width - expected.width) < 1,
      ),
    scrolled,
  );
  const baseline = await target.evaluate((element) => element.style.fontSize);
  await page.evaluate(() => {
    const input = [...pickerRoot.querySelectorAll("label")]
      .find((label) => label.firstChild.textContent === "Font size")
      .querySelector("input");
    input.value = "24";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  NodeAssert.equal(await target.evaluate((element) => element.style.fontSize), "24px");
  await target.press("Escape");
  NodeAssert.equal(await page.locator("[data-t3code-annotation-ui]").count(), 0);
  NodeAssert.equal(await target.evaluate((element) => element.style.fontSize), baseline);

  // Frames inserted and navigated during a session must acquire fresh handlers.
  await page.evaluate(() => {
    pickerMessages.length = 0;
    pickerEmit("preview:start-pick");
  });
  await page.locator("#outer").evaluate((frame) => {
    frame.srcdoc = `<button id="replacement">Replacement document</button>`;
  });
  const replacement = page.frameLocator("#outer").locator("#replacement");
  await replacement.click();
  await attach(page, /Replacement document/, "frame-navigation");
  await page.evaluate(() => {
    pickerMessages.length = 0;
    pickerEmit("preview:start-pick");
  });
  await page.evaluate(() => {
    const frame = document.createElement("iframe");
    frame.id = "dynamic";
    frame.srcdoc = '<button id="added">Dynamically inserted target</button>';
    document.body.prepend(frame);
  });
  await page.frameLocator("#dynamic").locator("#added").click();
  await attach(page, /Dynamically inserted target/, "dynamic-frame");
  await page.evaluate(() => {
    pickerMessages.length = 0;
    pickerEmit("preview:start-pick");
  });
  await page.frameLocator("#dynamic").locator("#added").click();
  await page.locator("#dynamic").evaluate((frame) => frame.remove());
  await page.waitForFunction(
    () =>
      [...pickerRoot.querySelectorAll("button")].find((x) => x.textContent === "Attach").disabled,
  );
  await page.evaluate(() => pickerEmit("preview:cancel-pick"));
  NodeAssert.deepEqual(errors, []);
  console.log(
    "PASS: nested srcdoc picking, translated geometry/crop, packaging, top-document input, frame navigation and capture cleanup",
  );

  const urls = await browser.newPage();
  await urls.route("http://picker.example/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: route.request().url().endsWith("/child")
        ? '<title>Embedded preview</title><button id="url-target">Same-origin URL target</button>'
        : `<title>Editor shell</title><iframe id="same" src="/child"></iframe><iframe id="opaque" sandbox="allow-scripts" srcdoc='<button id="outside" onclick="this.textContent=123">Opaque frame</button>'></iframe>`,
    }),
  );
  await urls.goto("http://picker.example/");
  await install(urls);
  await urls.frameLocator("#same").locator("#url-target").click();
  await attach(urls, /Same-origin URL target/, "same-origin-url");
  await urls.evaluate(() => pickerEmit("preview:start-pick"));
  await urls.frameLocator("#opaque").locator("#outside").click();
  NodeAssert.equal(await urls.frameLocator("#opaque").locator("#outside").textContent(), "123");
  await urls.evaluate(() => pickerEmit("preview:cancel-pick"));
  console.log("PASS: same-origin URL frames and opaque-origin exclusion");

  if (liveUrl) {
    const live = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
    await live.goto(liveUrl);
    await live.locator(".template-editor-workspace").waitFor();
    await live.locator(".template-editor-switch input").uncheck();
    const facsimile = live.frameLocator('iframe[title$="editable English Facsimile"]');
    const element = facsimile.locator(liveTarget);
    await element.waitFor();
    await element.scrollIntoViewIfNeeded();
    if (evidenceDir)
      await live.screenshot({ path: NodePath.join(evidenceDir, "facsimile-before.png") });
    await install(live);
    await element.click();
    await attach(live, /data-binding-id/, "facsimile-after");
    console.log("PASS: populated live Facsimile selection, screenshot crop and annotation payload");
  }
} finally {
  await browser.close();
}
