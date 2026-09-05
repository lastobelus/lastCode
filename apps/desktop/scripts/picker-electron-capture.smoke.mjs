// Isolated offscreen Electron guest. Never launches or modifies the installed app.
import * as NodeAssert from "node:assert/strict";
import * as NodeHttp from "node:http";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const require = NodeModule.createRequire(import.meta.url);
const { app, BrowserWindow, nativeImage } = require("electron");
const [
  bundlePath,
  screenshotBundlePath,
  userDataPath,
  liveUrl,
  evidenceDir,
  liveTarget = ".document-title",
] = process.argv.slice(2);
NodeAssert.ok(
  bundlePath && screenshotBundlePath && userDataPath && liveUrl,
  "smoke arguments required",
);
app.setPath("userData", userDataPath);
app.on("window-all-closed", () => {});

async function waitForValue(guest, expression, label) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await guest.executeJavaScript(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function main() {
  app.dock?.hide();
  const bundle = await NodeFSP.readFile(bundlePath, "utf8");
  const { captureAnnotationImage } = await import(NodeURL.pathToFileURL(screenshotBundlePath).href);
  if (evidenceDir) await NodeFSP.mkdir(evidenceDir, { recursive: true });
  const guestCreated = new Promise((resolve) => {
    app.on("web-contents-created", (_event, contents) => {
      if (contents.getType() === "webview") resolve(contents);
    });
  });
  // Logical visibility enables offscreen painting without creating a visible OS window.
  const host = new BrowserWindow({
    show: true,
    width: 700,
    height: 500,
    webPreferences: { backgroundThrottling: false, offscreen: true, webviewTag: true },
  });
  let fixtureServer;
  try {
    await host.loadURL(
      `data:text/html,${encodeURIComponent(`<!doctype html><style>
      html,body{margin:0;overflow:hidden}webview{display:flex;width:1280px;height:800px;transform:scale(.49);transform-origin:top left}
      </style><webview webpreferences="backgroundThrottling=no" src="about:blank"></webview><script>document.querySelector("webview").addEventListener("dom-ready", () => document.querySelector("webview").setZoomFactor(.8));</script>`)}`,
    );
    const guest = await guestCreated;
    const results = [];

    async function install() {
      await guest.executeJavaScript(`(() => {
        const original = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function(options) {
          const root = original.call(this, options);
          if (this.hasAttribute("data-t3code-annotation-ui")) globalThis.pickerRoot = root;
          return root;
        };
      })()`);
      await guest.executeJavaScript(bundle);
    }

    async function captureCase(
      name,
      frameSelector,
      targetSelector,
      scroll = "none",
      synthetic = false,
    ) {
      const config = JSON.stringify({ frameSelector, targetSelector, scroll });
      await guest.executeJavaScript(`(() => {
        const c = ${config};
        const frame = document.querySelector(c.frameSelector);
        frame.contentWindow.scrollTo(0, 0);
        const stage = frame.closest(".transcript-document-workspace__stage");
        if (stage) stage.scrollTop = 0;
        globalThis.pickerMessages = [];
        pickerEmit("preview:start-pick");
        const target = frame.contentDocument.querySelector(c.targetSelector);
        const rect = target.getBoundingClientRect();
        const init = { bubbles:true, cancelable:true, button:0, clientX:rect.x + rect.width/2, clientY:rect.y + rect.height/2 };
        target.dispatchEvent(new frame.contentWindow.PointerEvent("pointerdown", init));
        target.dispatchEvent(new frame.contentWindow.PointerEvent("pointerup", init));
        target.dispatchEvent(new frame.contentWindow.MouseEvent("click", init));
      })()`);
      const geometry = await guest.executeJavaScript(`(() => {
        const c = ${config};
        const frame = document.querySelector(c.frameSelector);
        const target = frame.contentDocument.querySelector(c.targetSelector);
        const stage = frame.closest(".transcript-document-workspace__stage");
        if (c.scroll === "iframe") {
          frame.contentDocument.body.style.minHeight = "1600px";
          frame.contentWindow.scrollTo(0, target.getBoundingClientRect().top + 5);
        } else if (c.scroll === "panel") {
          stage.scrollTop += frame.getBoundingClientRect().top + target.getBoundingClientRect().top - stage.getBoundingClientRect().top + target.getBoundingClientRect().height / 2;
        }
        return {
          viewport: { width:innerWidth, height:innerHeight },
          target:target.getBoundingClientRect().toJSON(), frame:frame.getBoundingClientRect().toJSON(),
          stage:stage?.getBoundingClientRect().toJSON(), frameScrollY:frame.contentWindow.scrollY,
          stageScrollY:stage?.scrollTop ?? 0,
        };
      })()`);
      const picked = guest.executeJavaScript('pickerWaitFor("preview:element-picked")');
      await guest.executeJavaScript(`(() => {
        const attach = [...pickerRoot.querySelectorAll("button")].find(x => x.textContent === "Attach");
        if (!attach || attach.disabled) throw new Error("Target was not selected");
        pickerRoot.querySelector("textarea").value = "Iframe capture regression";
        attach.click();
      })()`);
      const {
        args: [annotation, crop, submission],
      } = await picked;
      NodeAssert.equal(submission, "attach", `${name}: submission`);
      NodeAssert.equal(annotation.comment, "Iframe capture regression");
      NodeAssert.equal(annotation.elements.length, 1);
      const selected = annotation.elements[0];
      NodeAssert.equal(selected.element.pageUrl, "about:srcdoc");
      NodeAssert.equal(selected.element.framePath.length, 1);
      NodeAssert.ok(
        selected.element.selector && selected.element.htmlPreview && selected.element.styles,
      );
      NodeAssert.ok(crop.x >= 0 && crop.y >= 0);
      NodeAssert.ok(crop.x + crop.width <= geometry.viewport.width + 0.01);
      NodeAssert.ok(crop.y + crop.height <= geometry.viewport.height + 0.01);
      if (scroll !== "none") {
        NodeAssert.ok(
          selected.rect.height > 0 && selected.rect.height < geometry.target.height,
          `${name}: partial clipping`,
        );
        if (scroll === "iframe") NodeAssert.ok(geometry.frameScrollY > 0 && geometry.target.y < 0);
        if (scroll === "panel")
          NodeAssert.ok(geometry.stageScrollY > 0 && selected.rect.y >= geometry.stage.y);
      }
      const full = await guest.capturePage();
      const fullSize = full.getSize();
      let directResult;
      try {
        // Exactly the integer crop previously passed by Manager.
        const direct = await guest.capturePage({
          x: Math.floor(crop.x),
          y: Math.floor(crop.y),
          width: Math.ceil(crop.width),
          height: Math.ceil(crop.height),
        });
        directResult = direct.getSize();
      } catch (cause) {
        directResult = { error: cause instanceof Error ? cause.message : String(cause) };
      }
      const screenshot = await captureAnnotationImage(guest, crop);
      const image = nativeImage.createFromDataURL(screenshot.dataUrl);
      NodeAssert.equal(image.isEmpty(), false);
      NodeAssert.deepEqual(image.getSize(), { width: screenshot.width, height: screenshot.height });
      for (const key of ["x", "y", "width", "height"]) {
        NodeAssert.ok(
          Math.abs(screenshot.cropRect[key] - crop[key]) < 1e-9,
          `${name}: CSS ${key} preserved`,
        );
      }
      NodeAssert.ok(screenshot.width < fullSize.width && screenshot.height < fullSize.height);
      if (synthetic) {
        NodeAssert.ok(
          "error" in directResult,
          "old native crop rejects the valid right-hand CSS crop",
        );
        // A known cyan target verifies image alignment, independently of its dimensions.
        const pixels = image.toBitmap();
        let cyan = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i] > 180 && pixels[i + 1] > 130 && pixels[i + 1] < 220 && pixels[i + 2] < 50)
            cyan++;
        }
        NodeAssert.ok(cyan > 100, "native crop contains the cyan iframe target");
      }
      const { dataUrl: _dataUrl, ...metadata } = screenshot;
      const result = {
        name,
        geometry,
        annotation,
        crop,
        fullSize,
        screenshot: metadata,
        directResult,
      };
      results.push(result);
      if (evidenceDir) {
        await NodeFSP.writeFile(NodePath.join(evidenceDir, `${name}.png`), image.toPNG());
        await NodeFSP.writeFile(
          NodePath.join(evidenceDir, `${name}.json`),
          JSON.stringify(result, null, 2),
        );
        if (synthetic)
          await NodeFSP.writeFile(
            NodePath.join(evidenceDir, "synthetic-fixture.png"),
            full.toPNG(),
          );
      }
      await guest.executeJavaScript('pickerEmit("preview:annotation-captured")');
      NodeAssert.equal(
        await guest.executeJavaScript(
          'document.querySelector("[data-t3code-annotation-ui]") === null',
        ),
        true,
      );
      console.log(
        `PASS: ${name}, native PNG ${screenshot.width}x${screenshot.height}, prior crop ${JSON.stringify(directResult)}`,
      );
    }

    const child = `<style>body{margin:0}.target{height:90px;background:rgb(0,180,240);font:18px sans-serif;padding:10px;box-sizing:border-box}</style><div class="target">Iframe capture</div>`;
    const fixtureHtml = `<!doctype html><style>body{margin:0;font:20px sans-serif}iframe{position:absolute;left:calc(100vw - 210px);top:200px;width:180px;height:140px;border:2px solid black}</style><h1>Same-origin iframe capture fixture</h1><iframe srcdoc="${child.replaceAll('"', "&quot;")}"></iframe>`;
    fixtureServer = NodeHttp.createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(fixtureHtml);
    });
    await new Promise((resolve) => fixtureServer.listen(0, "127.0.0.1", resolve));
    await guest.loadURL(`http://127.0.0.1:${fixtureServer.address().port}/`);
    await waitForValue(
      guest,
      'innerWidth === 1600 && document.querySelector("iframe")?.contentDocument?.querySelector(".target")',
      "synthetic iframe",
    );
    await install();
    await captureCase("synthetic-capture", "iframe", ".target", "none", true);

    await guest.loadURL(liveUrl);
    await waitForValue(
      guest,
      `(() => {
      const toggle = document.querySelector(".template-editor-switch input");
      if (!toggle) return false;
      if (toggle.checked) toggle.click();
      return innerWidth === 1600 && Boolean(document.querySelector('iframe[title$="editable English Facsimile"]')?.contentDocument?.querySelector(${JSON.stringify(liveTarget)}));
    })()`,
      "populated Template Editor",
    );
    await install();
    const frameSelector = 'iframe[title$="editable English Facsimile"]';
    await captureCase("facsimile-normal", frameSelector, liveTarget);
    await captureCase("facsimile-frame-scroll", frameSelector, liveTarget, "iframe");
    await captureCase("facsimile-panel-scroll", frameSelector, liveTarget, "panel");
    if (evidenceDir)
      await NodeFSP.writeFile(
        NodePath.join(evidenceDir, "capture-results.json"),
        JSON.stringify(
          results.map(({ annotation: _annotation, ...result }) => result),
          null,
          2,
        ),
      );
  } finally {
    fixtureServer?.close();
    host.destroy();
  }
}

// Awaiting readiness at ESM top level prevents Electron from finishing entry loading.
app
  .whenReady()
  .then(main)
  .then(
    () => app.quit(),
    (cause) => {
      console.error(cause);
      app.exit(1);
    },
  );
