// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import { expect } from "e2e";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { APP_DIR, T3_HOME } from "../e2e.config.ts";
import { run } from "./shell.ts";
import { runPromise, test, WEB } from "./t3.ts";

const DASHBOARD = `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Owner dashboard</title>
<style>
  body { margin:0; min-height:300vh; background:linear-gradient(#eef6ff,#bbd6fa); color:#183456; font:18px system-ui; }
  h1 { position:fixed; left:5vw; top:1vh; font-size:24px; }
  input,button { position:fixed; left:5vw; width:90vw; height:12vh; box-sizing:border-box; font:inherit; }
  input { top:18vh; padding:12px; } button { top:36vh; background:#183456; color:white; border:0; border-radius:8px; }
  output { position:fixed; left:5vw; right:5vw; bottom:5vh; padding:12px; background:white; border-radius:8px; }
  p { position:fixed; left:5vw; top:52vh; }
</style>
<h1>Owner dashboard</h1><input aria-label="Dashboard note" placeholder="Write a note">
<button>Save note</button><p>Scroll to explore the dashboard.</p><output>Ready</output>
<script>
  const note = document.querySelector('input');
  let clicks = 0, sequence = 0;
  const report = (event) => {
    document.querySelector('output').textContent = note.value + ' · saves: ' + clicks + ' · scroll: ' + Math.round(scrollY);
    void fetch('/event?' + new URLSearchParams({
      note:note.value, clicks:String(clicks), scrollY:String(scrollY),
      trusted:String(event.isTrusted), sequence:String(++sequence),
    }));
  };
  note.addEventListener('input', report);
  document.querySelector('button').addEventListener('click', (event) => { clicks++; report(event); });
  addEventListener('scroll', report);
</script></html>`;

test(
  "an agent opens a dashboard the user can operate before and after reopening its panel",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const fs = await runPromise(FileSystem.FileSystem);
    const path = await runPromise(Path.Path);
    const project = await t3.project("owner-preview");
    const fixture = await runPromise(
      fs.makeTempDirectory({ directory: T3_HOME, prefix: "owner-preview-" }),
    );
    let registered = false;
    let observed = { note: "", clicks: 0, scrollY: 0, trusted: false, sequence: 0 };
    const dashboard = NodeHttp.createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://fixture.invalid");
      if (url.pathname === "/event") {
        const sequence = Number(url.searchParams.get("sequence"));
        if (sequence > observed.sequence) {
          observed = {
            note: url.searchParams.get("note") ?? "",
            clicks: Number(url.searchParams.get("clicks")),
            scrollY: Number(url.searchParams.get("scrollY")),
            trusted: url.searchParams.get("trusted") === "true",
            sequence,
          };
        }
        response.writeHead(204).end();
      } else {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(DASHBOARD);
      }
    });
    try {
      await new Promise<void>((resolve, reject) => {
        dashboard.once("error", reject);
        dashboard.listen(0, "127.0.0.1", resolve);
      });
      const address = dashboard.address();
      if (address === null || typeof address === "string") throw new Error("No dashboard port");
      const dashboardUrl = `http://127.0.0.1:${address.port}`;
      const wrapper = path.join(fixture, "replay-with-preview.mjs");
      // The proof always loads this wrapper from the scenario, including when the app is on base.
      // It uses only the thread-scoped MCP bridge the real ACP adapter gives its provider.
      await runPromise(
        fs.writeFileString(
          wrapper,
          `import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
const agent = spawn(process.execPath, [${JSON.stringify(path.join(APP_DIR, "apps/server/scripts/dev-replay-agent.ts"))}], { stdio:['pipe','pipe','inherit'] });
agent.stdout.pipe(process.stdout);
agent.on('exit', (code) => process.exit(code ?? 1));
process.stdin.on('end', () => agent.stdin.end());
let bridge, opened = false;
const call = (tool, args) => new Promise((resolve, reject) => {
  if (!bridge?.args.includes('acp-mcp-bridge')) return reject(Error('Replay received no thread-scoped MCP bridge'));
  const child = spawn(bridge.command, [
    ...bridge.args.map((arg) => arg === 'acp-mcp-bridge' ? 'acp-mcp-call' : arg), tool, JSON.stringify(args),
  ], { env:{...process.env,...Object.fromEntries(bridge.env.map(({name,value}) => [name,value]))}, stdio:['ignore','pipe','pipe'] });
  let out = '', err = '';
  child.stdout.on('data', (data) => { out += data; });
  child.stderr.on('data', (data) => { err += data; });
  child.on('error', reject);
  child.on('close', (code) => {
    try {
      if (code !== 0) throw Error(err || 'Thread MCP call failed');
      const result = JSON.parse(out);
      if (result.isError) throw Error(JSON.stringify(result));
      resolve(result.structuredContent ?? JSON.parse(result.content.find((part) => part.type === 'text').text));
    } catch (error) { reject(error); }
  });
});
createInterface({input:process.stdin,crlfDelay:Infinity}).on('line', async (line) => {
  const message = JSON.parse(line);
  if (message.method === 'session/new' || message.method === 'session/load') {
    bridge = message.params.mcpServers.find((server) => server.name === 't3-code');
  }
  try {
    if (message.method === 'session/prompt' && !opened && JSON.stringify(message.params.prompt).includes('OPEN_OWNER_DASHBOARD')) {
      opened = true;
      const before = await call('preview_status', {});
      if (before.tabs?.length) throw Error('The scenario must start without a browser tab');
      try {
        await call('preview_open', {purpose:'user',open:true,browserHost:'environment',url:${JSON.stringify(dashboardUrl)}});
      } catch (error) { console.error('Owner preview open failed:', error); }
    }
    agent.stdin.write(line + '\\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:-32603,message:String(error)}}) + '\\n');
  }
});
`,
        ),
      );
      await t3.open();
      await screen.getByRole("button", "New thread in owner-preview").waitFor({ state: "visible" });
      await browser.evaluate(
        `async ({wrapper,node}) => {
          const {serverEnvironment} = await import('/src/state/server.ts');
          const {appAtomRegistry} = await import('/src/rpc/atomRegistry.ts');
          const {updateClientSettings} = await import('/src/hooks/useSettings.ts');
          await updateClientSettings({browserAutoShowFloatingPreview:false});
          const {environmentId} = await (await fetch('/.well-known/t3/environment')).json();
          const result = await serverEnvironment.updateSettings.run(appAtomRegistry, {environmentId,input:{
            patch:{},providerInstanceMutation:{operation:'create',instanceId:'ownerPreviewReplay',instance:{
              driver:'acpRegistry',displayName:'Owner preview replay',enabled:true,
              config:{source:'local',commandPath:node,commandArgs:[wrapper]},
            }},
          }});
          if (result._tag !== 'Success') throw Error('Could not register the scenario Replay wrapper');
          const atom = serverEnvironment.providersValueAtom(environmentId);
          await new Promise((resolve) => {
            const ready = (providers) => providers?.some((provider) => provider.instanceId === 'ownerPreviewReplay' && provider.status === 'ready');
            if (ready(appAtomRegistry.get(atom))) return resolve();
            const unsubscribe = appAtomRegistry.subscribe(atom, (providers) => {
              if (ready(providers)) { unsubscribe(); resolve(); }
            });
          });
        }`,
        { wrapper, node: process.execPath },
      );
      registered = true;
      const cli = (...args: string[]) =>
        runPromise(
          run(process.execPath, ["apps/server/src/bin.ts", ...args, "--base-dir", T3_HOME], {
            cwd: APP_DIR,
          }),
        );
      const thread: { threadId: string } = JSON.parse(
        (
          await cli(
            "thread",
            "start",
            project,
            "Prepare the dashboard",
            "--title",
            "Owner dashboard",
            "--provider",
            "ownerPreviewReplay",
            "--model",
            "multi-turn",
            "--wait",
            "--json",
          )
        ).stdout,
      );
      await t3.open(thread);
      await browser.evaluate(
        `async ({threadId}) => {
          const {previewStateAtom} = await import('/src/previewStateStore.ts');
          const {appAtomRegistry} = await import('/src/rpc/atomRegistry.ts');
          const {environmentId} = await (await fetch('/.well-known/t3/environment')).json();
          const atom = previewStateAtom(environmentId + ':' + threadId);
          await new Promise((resolve) => {
            if (appAtomRegistry.get(atom).listLoaded) return resolve();
            const unsubscribe = appAtomRegistry.subscribe(atom, (state) => {
              if (state.listLoaded) { unsubscribe(); resolve(); }
            });
          });
          if (Object.keys(appAtomRegistry.get(atom).sessions).length) throw Error('A browser tab already exists');
        }`,
        thread,
      );
      await browser
        .locator('[data-right-panel-toggle][aria-pressed="false"]')
        .waitFor({ state: "visible" });
      await cli("thread", "send", thread.threadId, "OPEN_OWNER_DASHBOARD", "--wait", "--json");
      const browserPage = browser.locator(
        "[data-right-panel-surface-content] [data-server-browser-surface] textarea",
      );
      try {
        await expect(browserPage).toBeEnabled();
        await expect(browserPage).toBeVisible();
        await expect(screen.getByRole("button", "Take control")).not.toBeVisible();
      } finally {
        await app.screenshot("dashboard-control");
      }
      const point = (y: number) =>
        browser.evaluate<{ x: number; y: number }, number>(
          `(fraction) => {
          const canvas = document.querySelector('[data-right-panel-surface-content] [data-server-browser-surface] canvas');
          if (!canvas) throw new Error("No dashboard canvas");
          const rect = canvas.getBoundingClientRect();
          const fit = Math.min(rect.width / canvas.width, rect.height / canvas.height);
          return {
            x: rect.left + rect.width / 2,
            y: rect.top + (rect.height - canvas.height * fit) / 2 + canvas.height * fit * fraction,
          };
        }`,
          y,
        );
      const interact = async (suffix: string, clicks: number) => {
        await browser
          .locator(
            "[data-right-panel-surface-content] [data-server-browser-surface] canvas[width][height]",
          )
          .waitFor({ state: "visible" });
        await screen.tapAt(await point(0.24));
        await browser.keyboard.press("End");
        await browser.keyboard.type(suffix);
        await expect
          .poll(() => observed)
          .toMatchObject({
            note: clicks === 1 ? "Before reopening" : "Before reopening and after reopening",
            trusted: true,
          });
        await screen.tapAt(await point(0.42));
        await expect.poll(() => observed).toMatchObject({ clicks, trusted: true });
        const previousScroll = observed.scrollY;
        const scrollPoint = await point(0.75);
        await browser.mouse.move(scrollPoint.x, scrollPoint.y);
        await browser.mouse.wheel(0, 400);
        await expect.poll(() => observed.scrollY).toBeGreaterThan(previousScroll);
      };
      await interact("Before reopening", 1);
      await app.screenshot("dashboard-interaction");
      await screen.getByRole("button", "Toggle right panel").tap();
      await expect(browserPage).not.toBeVisible();
      await screen.getByRole("button", "Toggle right panel").tap();
      await expect(browserPage).toBeEnabled();
      await expect(browserPage).toBeVisible();
      await expect(screen.getByRole("button", "Take control")).not.toBeVisible();
      await interact(" and after reopening", 2);
      await app.screenshot("dashboard-reopened");
    } finally {
      try {
        if (registered) {
          await browser.evaluate(`async () => {
            const {serverEnvironment} = await import('/src/state/server.ts');
            const {appAtomRegistry} = await import('/src/rpc/atomRegistry.ts');
            const {environmentId} = await (await fetch('/.well-known/t3/environment')).json();
            const result = await serverEnvironment.updateSettings.run(appAtomRegistry, {environmentId,input:{
              patch:{},providerInstanceMutation:{operation:'remove',instanceId:'ownerPreviewReplay'},
            }});
            if (result._tag !== 'Success') throw Error('Could not remove the scenario Replay wrapper');
          }`);
        }
      } finally {
        await new Promise<void>((resolve, reject) =>
          dashboard.close((error) => (error ? reject(error) : resolve())),
        );
        await runPromise(fs.remove(fixture, { recursive: true, force: true }));
      }
    }
  },
);
