const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { platform, tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");

test("the APT action replaces both runner lists, rewrites Ubuntu sources, and preserves vendors", () => {
  const action = readFileSync(join(__dirname, "../actions/setup-apt-mirrors/action.yml"), "utf8");
  const run = action.match(/      run: \|\n((?:        .*\n|\n)+)/);
  assert.ok(run, "Could not find the APT action shell step");
  const root = mkdtempSync(join(tmpdir(), "t3-apt-mirrors-test-"));
  try {
    const apt = join(root, "apt");
    mkdirSync(join(apt, "sources.list.d"), { recursive: true });
    mkdirSync(join(apt, "apt.conf.d"));
    for (const name of ["blacksmith-ubuntu-mirrors.txt", "apt-mirrors.txt"]) {
      writeFileSync(join(apt, name), "http://azure.archive.ubuntu.com/ubuntu\n");
    }
    writeFileSync(
      join(apt, "sources.list"),
      "deb http://azure.archive.ubuntu.com/ubuntu/ noble main\n" +
        "deb https://security.ubuntu.com/ubuntu noble-security main\n",
    );
    const nativeSource = "Types: deb\nURIs: mirror+file:/etc/apt/apt-mirrors.txt\nSuites: noble\n";
    writeFileSync(join(apt, "sources.list.d", "ubuntu.sources"), nativeSource);
    const vendorSource =
      "Types: deb\nURIs: https://packages.vendor.example/linux\nSuites: stable\n";
    writeFileSync(join(apt, "sources.list.d", "vendor.sources"), vendorSource);

    // Redirect every filesystem operation into the fixture; sudo becomes a local call.
    let script = run[1].replace(/^        /gm, "").replaceAll("/etc/apt", apt);
    assert.equal(script.includes("/etc/apt"), false);
    // BSD sed requires an explicit empty backup suffix for the same in-place edit.
    if (platform() === "darwin") script = script.replace("sed -i -E", "sed -i '' -E");
    const result = spawnSync(
      "bash",
      ["-e", "-o", "pipefail", "-c", 'sudo() { "$@"; }\n' + script],
      {
        encoding: "utf8",
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);

    const mirrors =
      "https://archive.ubuntu.com/ubuntu\tpriority:1\n" +
      "https://mirrors.edge.kernel.org/ubuntu\tpriority:2\n" +
      "https://mirror.math.princeton.edu/pub/ubuntu\tpriority:3\n";
    for (const name of ["blacksmith-ubuntu-mirrors.txt", "apt-mirrors.txt"]) {
      assert.equal(readFileSync(join(apt, name), "utf8"), mirrors);
    }
    assert.equal(
      readFileSync(join(apt, "sources.list"), "utf8"),
      `deb mirror+file:${apt}/blacksmith-ubuntu-mirrors.txt noble main\n` +
        `deb mirror+file:${apt}/blacksmith-ubuntu-mirrors.txt noble-security main\n`,
    );
    assert.equal(readFileSync(join(apt, "sources.list.d", "ubuntu.sources"), "utf8"), nativeSource);
    assert.equal(readFileSync(join(apt, "sources.list.d", "vendor.sources"), "utf8"), vendorSource);
    assert.equal(
      readFileSync(join(apt, "apt.conf.d", "80-mirror-timeouts"), "utf8"),
      'Acquire::http::Timeout "15";\nAcquire::https::Timeout "15";\n',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
