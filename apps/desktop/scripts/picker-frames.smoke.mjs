// Run explicitly with Chromium installed: node apps/desktop/scripts/picker-frames.smoke.mjs
// Optional arguments: live editor URL, evidence directory. Never launches the installed app.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { build } from "vite-plus";
import { chromium } from "playwright-core";
import { ensureElectronRuntime } from "./ensure-electron-runtime.mjs";

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
        globalThis.pickerWaiters = new Map();
        globalThis.pickerEmit = (channel, ...args) => {
          for (const fn of [...(listeners.get(channel) ?? [])]) fn({}, ...args);
        };
        globalThis.pickerWaitFor = (channel) => {
          const found = globalThis.pickerMessages.find((message) => message.channel === channel);
          if (found) return Promise.resolve(found);
          return new Promise((resolve) => {
            globalThis.pickerWaiters.set(channel, [
              ...(globalThis.pickerWaiters.get(channel) ?? []),
              resolve,
            ]);
          });
        };
        export const ipcRenderer = {
          on(channel, fn) { listeners.set(channel, [...(listeners.get(channel) ?? []), fn]); return this; },
          off(channel, fn) { listeners.set(channel, (listeners.get(channel) ?? []).filter(x => x !== fn)); return this; },
          send(channel, ...args) {
            const message = { channel, args };
            globalThis.pickerMessages.push(message);
            for (const resolve of globalThis.pickerWaiters.get(channel) ?? []) resolve(message);
            globalThis.pickerWaiters.delete(channel);
          }
        };`;
      },
    },
  ],
  build: { write: false, minify: false, lib: { entry, formats: ["iife"], name: "PickerSmoke" } },
});
const bundle = (Array.isArray(result) ? result[0] : result).output.find(
  (x) => x.type === "chunk",
).code;
const screenshotEntry = NodeURL.fileURLToPath(
  new URL("../src/preview/AnnotationScreenshot.ts", import.meta.url),
);
const screenshotResult = await build({
  configFile: false,
  logLevel: "error",
  build: {
    write: false,
    minify: false,
    lib: { entry: screenshotEntry, formats: ["es"] },
  },
});
const screenshotBundle = (
  Array.isArray(screenshotResult) ? screenshotResult[0] : screenshotResult
).output.find((output) => output.type === "chunk").code;
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

  // SVG graphics bounds can extend beyond their viewport, especially with a
  // viewBox. Verify the browser's clip and the captured rect in child documents.
  for (const { nested, percent } of [
    { nested: false, percent: false },
    { nested: true, percent: false },
    { nested: false, percent: true },
    { nested: true, percent: true },
  ]) {
    for (const fit of ["none", "xMidYMid meet", "xMaxYMin slice"]) {
      for (const scale of [1, 1.5]) {
        const svgPage = await browser.newPage({ viewport: { width: 800, height: 600 } });
        await svgPage.setContent(
          '<body style="margin:0"><iframe style="position:absolute;left:40px;top:40px;width:600px;height:500px;border:0"></iframe>',
        );
        await svgPage.locator("iframe").evaluate(
          (frame, { nested, percent, fit, scale }) => {
            const content = `<svg id="viewport" ${nested ? 'x="50" y="40"' : ""}
            width="200" height="100" viewBox="10 20 80 80" preserveAspectRatio="${fit}"
            style="overflow:hidden;${percent ? "width:50%;height:50%" : ""}"><g style="overflow:hidden"><rect id="svg-target"
            x="-500" y="-500" width="1000" height="1000" fill="lime"><title>SVG target</title></rect></g></svg>`;
            frame.srcdoc = `<body style="margin:0"><div style="padding:50px;width:400px;height:200px;transform:scale(${scale});transform-origin:0 0">
            ${nested ? `<svg width="400" height="200" viewBox="0 0 400 200">${content}</svg>` : content}</div>`;
          },
          { nested, percent, fit, scale },
        );
        const selected = svgPage.frameLocator("iframe").locator("#svg-target");
        await selected.waitFor();
        const local = {
          x: (50 + (nested ? 50 : 0)) * scale,
          y: (50 + (nested ? 40 : 0)) * scale,
          width: 200 * scale,
          height: 100 * scale,
        };
        for (const axis of ["x", "y"]) {
          for (const end of [false, true]) {
            for (const outside of [false, true]) {
              const point = { x: local.x + local.width / 2, y: local.y + local.height / 2 };
              point[axis] =
                local[axis] +
                (end ? local[axis === "x" ? "width" : "height"] : 0) +
                (outside ? 1 : -1) * (end ? 1 : -1);
              NodeAssert.equal(
                await selected.evaluate(
                  (element, point) =>
                    element.ownerDocument.elementFromPoint(point.x, point.y) === element,
                  point,
                ),
                !outside,
                `SVG ${nested}/${fit}/${scale}: ${axis} ${end ? "end" : "start"} clip`,
              );
            }
          }
        }
        await install(svgPage);
        await svgPage.mouse.click(40 + local.x + local.width / 2, 40 + local.y + local.height / 2);
        const svgRect = await attach(
          svgPage,
          /svg-target/,
          `svg-${nested}-${percent}-${fit.replaceAll(" ", "-")}-${scale}`,
        );
        NodeAssert.deepEqual(svgRect, { ...local, x: 40 + local.x, y: 40 + local.y });
        await svgPage.close();
      }
    }
  }
  console.log(
    "PASS: outer and nested SVG viewport clipping, viewBox fits, graphics groups and positive scale",
  );

  for (const scale of [1, 1.5]) {
    for (const percent of [false, true]) {
      const foreignPage = await browser.newPage({ viewport: { width: 800, height: 600 } });
      await foreignPage.setContent(
        '<body style="margin:0"><iframe style="position:absolute;left:40px;top:40px;width:700px;height:500px;border:0"></iframe>',
      );
      await foreignPage.locator("iframe").evaluate(
        (frame, { scale, percent }) => {
          frame.srcdoc = `<body style="margin:0"><div style="padding:50px;transform:scale(${scale});transform-origin:0 0">
          <svg width="400" height="200" viewBox="0 0 200 100"><foreignObject x="20" y="10" width="100" height="50"
          style="overflow:hidden;${percent ? "x:10%;y:10%;width:50%;height:50%" : ""}">
          <div xmlns="http://www.w3.org/1999/xhtml" id="foreign-target" style="position:relative;left:-20px;top:-20px;width:300px;height:200px;background:lime">Foreign target</div>
          </foreignObject></svg></div>`;
        },
        { scale, percent },
      );
      const selected = foreignPage.frameLocator("iframe").locator("#foreign-target");
      await selected.waitFor();
      const local = { x: 90 * scale, y: 70 * scale, width: 200 * scale, height: 100 * scale };
      for (const axis of ["x", "y"]) {
        for (const end of [false, true]) {
          for (const outside of [false, true]) {
            const point = { x: local.x + local.width / 2, y: local.y + local.height / 2 };
            point[axis] =
              local[axis] +
              (end ? local[axis === "x" ? "width" : "height"] : 0) +
              (outside ? 1 : -1) * (end ? 1 : -1);
            NodeAssert.equal(
              await selected.evaluate(
                (element, point) =>
                  element.ownerDocument.elementFromPoint(point.x, point.y) === element,
                point,
              ),
              !outside,
              `foreignObject ${scale}/${percent}: ${axis} ${end ? "end" : "start"} clip`,
            );
          }
        }
      }
      await install(foreignPage);
      await foreignPage.mouse.click(
        40 + local.x + local.width / 2,
        40 + local.y + local.height / 2,
      );
      const rect = await attach(
        foreignPage,
        /Foreign target/,
        `foreign-object-${scale}-${percent}`,
      );
      NodeAssert.deepEqual(rect, { ...local, x: 40 + local.x, y: 40 + local.y });
      await foreignPage.close();
    }
  }
  console.log(
    "PASS: foreignObject HTML clipping, viewBox, positive scaling and CSS percentage geometry",
  );

  // Positioned boxes (and their children) escape overflow before their containing
  // block. Verify Chromium actually paints/hit-tests the pixels that we capture.
  for (const scenario of [
    { name: "viewport-fixed", position: "fixed", blockStyle: "", width: 100 },
    {
      name: "transformed-fixed",
      position: "fixed",
      blockStyle: "transform:translateX(0)",
      width: 50,
    },
    { name: "outside-absolute", position: "absolute", blockStyle: "position:relative", width: 50 },
  ]) {
    for (const descendant of [false, true]) {
      const positionedPage = await browser.newPage({ viewport: { width: 800, height: 600 } });
      await positionedPage.setContent(
        '<body style="margin:0"><iframe id="positioned-frame" style="position:absolute;left:80px;top:80px;width:400px;height:350px;border:0"></iframe>',
      );
      await positionedPage.locator("iframe").evaluate(
        (frame, { scenario, descendant }) => {
          frame.srcdoc = `<style>
          body{margin:0}
          #block{width:200px;height:200px;overflow:hidden;${scenario.blockStyle}}
          #scroller{width:60px;height:60px;overflow:auto}
          #positioned{position:${scenario.position};left:150px;top:100px;width:100px;height:50px;
            padding:0;border:0;background:lime}
          #target{display:block;width:100%;height:100%}
          </style><div id="block"><div id="scroller">
          <div id="positioned">${descendant ? '<span id="target">Positioned child</span>' : "Positioned target"}</div>
          </div></div>`;
        },
        { scenario, descendant },
      );
      const selected = positionedPage
        .frameLocator("iframe")
        .locator(descendant ? "#target" : "#positioned");
      await selected.waitFor();
      NodeAssert.equal(
        await selected.evaluate(
          (element) => element.ownerDocument.elementFromPoint(175, 125) === element,
        ),
        true,
        `${scenario.name}: pixels outside intermediate scroller remain visible`,
      );
      NodeAssert.equal(
        await selected.evaluate(
          (element) => element.ownerDocument.elementFromPoint(225, 125) === element,
        ),
        scenario.width === 100,
        `${scenario.name}: real containing block determines visible right edge`,
      );
      await install(positionedPage);
      await positionedPage.mouse.click(80 + 175, 80 + 125);
      const positionedRect = await attach(
        positionedPage,
        /Positioned/,
        `${scenario.name}${descendant ? "-descendant" : ""}`,
      );
      NodeAssert.deepEqual(positionedRect, { x: 230, y: 180, width: scenario.width, height: 50 });
      await positionedPage.close();
    }
  }
  console.log(
    "PASS: viewport-fixed, transformed-fixed and absolute overflow escape, including ordinary descendants",
  );

  // HTML body overflow can belong to the viewport even when its box is short.
  // Root overflow and containment disable body propagation and retain its clip.
  for (const overflow of ["hidden", "auto", "clip"]) {
    for (const scenario of [
      { name: "body-propagated", rootStyle: "", bodyStyle: "", height: 50 },
      { name: "boxless-ancestor", rootStyle: "", bodyStyle: "", height: 50 },
      ...["inline", "inline-block", "inline-flex", "inline-grid"].map((display) => ({
        name: `${display}-ancestor`,
        rootStyle: "",
        bodyStyle: "",
        display,
        height: display === "inline" ? 50 : 20,
      })),
      { name: "root-overflow", rootStyle: "overflow:hidden", bodyStyle: "", height: 20 },
      ...["style", "size", "inline-size", "layout", "paint", "content", "strict"].flatMap(
        (contain) => [
          {
            name: `root-contain-${contain}`,
            rootStyle: `height:350px;contain:${contain}`,
            bodyStyle: "",
            height: 20,
          },
          {
            name: `body-contain-${contain}`,
            rootStyle: "",
            bodyStyle: `contain:${contain}`,
            height: 20,
          },
        ],
      ),
      {
        name: "root-propagated",
        rootStyle: `height:60px;overflow:${overflow}`,
        bodyStyle: "overflow:visible",
        height: 50,
      },
    ]) {
      const overflowPage = await browser.newPage({ viewport: { width: 800, height: 600 } });
      await overflowPage.setContent(
        '<body style="margin:0"><iframe style="position:absolute;left:80px;top:80px;width:400px;height:350px;border:0"></iframe>',
      );
      await overflowPage.locator("iframe").evaluate(
        (frame, { overflow, scenario }) => {
          frame.srcdoc = `<!doctype html><style>
          html{${scenario.rootStyle}}
          body{margin:0;height:120px;overflow:${overflow};${scenario.bodyStyle}}
          #target{position:relative;top:100px;left:100px;width:100px;height:50px;background:lime}
          </style><div style="${scenario.display ? `display:${scenario.display};overflow:${overflow};width:300px;height:120px` : scenario.name === "boxless-ancestor" ? `display:contents;overflow:${overflow};position:fixed` : ""}"><div id="target">Overflow target</div></div>`;
        },
        { overflow, scenario },
      );
      const selected = overflowPage.frameLocator("iframe").locator("#target");
      await selected.waitFor();
      NodeAssert.equal(
        await selected.evaluate(
          (element) => element.ownerDocument.elementFromPoint(150, 110) === element,
        ),
        true,
        `${scenario.name}-${overflow}: target starts within the visible area`,
      );
      NodeAssert.equal(
        await selected.evaluate(
          (element) => element.ownerDocument.elementFromPoint(150, 140) === element,
        ),
        scenario.height === 50,
        `${scenario.name}-${overflow}: browser hit testing confirms the clip boundary`,
      );
      await install(overflowPage);
      await overflowPage.mouse.click(80 + 150, 80 + 110);
      const overflowRect = await attach(
        overflowPage,
        /Overflow target/,
        `${scenario.name}-${overflow}`,
      );
      NodeAssert.deepEqual(overflowRect, { x: 180, y: 180, width: 100, height: scenario.height });
      await overflowPage.close();
    }
  }
  console.log("PASS: viewport overflow propagation and root/body containment clipping");

  // Compare captured bounds with Chromium hit testing, including reference boxes,
  // positive scaling and cases where Chromium ignores overflow-clip-margin.
  for (const scenario of [
    { overflow: "clip", margin: "20px", start: 85, end: 245 },
    { overflow: "clip", margin: "padding-box 20px", start: 85, end: 245 },
    { overflow: "clip", margin: "content-box 20px", start: 95, end: 235 },
    { overflow: "clip", margin: "border-box 20px", start: 80, end: 250 },
    { overflow: "hidden", margin: "20px", start: 105, end: 225 },
    { overflow: "clip visible", margin: "20px", start: 105, end: 225, yStart: 75, yEnd: 275 },
    { overflow: "visible clip", margin: "20px", start: 75, end: 275, yStart: 105, yEnd: 225 },
  ]) {
    for (const scale of [1, 1.5]) {
      const clipPage = await browser.newPage({ viewport: { width: 800, height: 700 } });
      await clipPage.setContent(
        '<body style="margin:0"><iframe style="width:600px;height:600px;border:0"></iframe>',
      );
      await clipPage.locator("iframe").evaluate(
        (frame, { scenario, scale }) => {
          frame.srcdoc = `<!doctype html><style>
          body{margin:0}
          #scaled{transform:scale(${scale});transform-origin:0 0;padding:100px}
          #box{width:100px;height:100px;padding:10px;border:5px solid;
            overflow:${scenario.overflow};overflow-clip-margin:${scenario.margin}}
          #target{position:relative;left:-40px;top:-40px;width:200px;height:200px;background:lime}
          </style><div id="scaled"><div id="box"><div id="target">Clip margin target</div></div></div>`;
        },
        { scenario, scale },
      );
      const selected = clipPage.frameLocator("iframe").locator("#target");
      await selected.waitFor();
      // The target extends beyond every reference box on all four sides.
      const expected = {
        x: Math.max(75, scenario.start) * scale,
        y: Math.max(75, scenario.yStart ?? scenario.start) * scale,
        width: (scenario.end - Math.max(75, scenario.start)) * scale,
        height:
          ((scenario.yEnd ?? scenario.end) - Math.max(75, scenario.yStart ?? scenario.start)) *
          scale,
      };
      for (const axis of ["x", "y"]) {
        for (const edge of ["start", "end"]) {
          for (const outside of [false, true]) {
            const boundary =
              expected[axis] + (edge === "end" ? expected[axis === "x" ? "width" : "height"] : 0);
            const offset = (outside ? 1 : -1) * (edge === "end" ? 1 : -1);
            const point =
              axis === "x"
                ? { x: boundary + offset, y: 150 * scale }
                : { x: 150 * scale, y: boundary + offset };
            NodeAssert.equal(
              await selected.evaluate(
                (element, point) =>
                  element.ownerDocument.elementFromPoint(point.x, point.y) === element,
                point,
              ),
              !outside,
              `${scenario.overflow}/${scenario.margin}/${scale}: ${axis} ${edge} clip edge`,
            );
          }
        }
      }
      await install(clipPage);
      await clipPage.mouse.click(150 * scale, 150 * scale);
      const clipRect = await attach(
        clipPage,
        /Clip margin target/,
        `clip-margin-${scenario.overflow.replaceAll(" ", "-")}-${scenario.margin.replaceAll(" ", "-")}-${scale}`,
      );
      NodeAssert.deepEqual(clipRect, expected);
      await clipPage.close();
    }
  }
  console.log(
    "PASS: overflow clip margins, reference boxes, positive scale and ignored-margin controls",
  );

  if (liveUrl) {
    const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "picker-electron-"));
    const bundlePath = NodePath.join(scratch, "picker-bundle.js");
    const screenshotBundlePath = NodePath.join(scratch, "annotation-screenshot.mjs");
    const userDataPath = NodePath.join(scratch, "user-data");
    await NodeFSP.writeFile(bundlePath, bundle);
    await NodeFSP.writeFile(screenshotBundlePath, screenshotBundle);
    await NodeFSP.mkdir(userDataPath);
    try {
      const childPath = NodeURL.fileURLToPath(
        new URL("./picker-electron-capture.smoke.mjs", import.meta.url),
      );
      const environment = { ...process.env };
      delete environment.ELECTRON_RUN_AS_NODE;
      const child = NodeChildProcess.spawnSync(
        ensureElectronRuntime(),
        [
          childPath,
          bundlePath,
          screenshotBundlePath,
          userDataPath,
          liveUrl,
          evidenceDir ?? "",
          liveTarget,
        ],
        { encoding: "utf8", env: environment, timeout: 30_000 },
      );
      if (child.stdout) process.stdout.write(child.stdout);
      if (child.stderr) process.stderr.write(child.stderr);
      NodeAssert.equal(child.error, undefined, child.error?.message);
      NodeAssert.equal(
        child.status,
        0,
        `Electron capture exited ${child.status ?? "without status"}`,
      );
    } finally {
      await NodeFSP.rm(scratch, { force: true, recursive: true });
    }
  }
} finally {
  await browser.close();
}
