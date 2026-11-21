import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, removeTempDir } from "../test-helpers.ts";
import { notebookWslPath } from "./environment.ts";
import { createNotebookRuntime, type NotebookRuntimeOptions } from "./runtime.ts";

const nativeHost = process.env.ODIN_TEST_JUPYTER_HOST_PYTHON;
const nativeKernel = process.env.ODIN_TEST_JUPYTER_KERNEL_PYTHON ?? nativeHost;
const wslDistro = process.env.ODIN_TEST_WSL_DISTRO;
const wslHost = process.env.ODIN_TEST_WSL_JUPYTER_HOST_PYTHON;
const wslKernel = process.env.ODIN_TEST_WSL_JUPYTER_KERNEL_PYTHON ?? wslHost;

async function exerciseRuntime(location: NotebookRuntimeOptions["location"], hostPython: string, interpreter: string) {
  const home = tempDir("odin-live-jupyter-");
  const stopped: string[] = [];
  const runtime = createNotebookRuntime({ home, project: "live-test", location, hostPython, idleTimeoutMs: 0, onStopped: ids => stopped.push(...ids) });
  try {
    const path = join(home, ".env");
    writeFileSync(path, "FRED_RUNTIME_FIXTURE_KEY=fake-fred-key\nJUPYTER_FIXTURE_UNSELECTED=do-not-inject\n");
    const kernel = await runtime.createKernel({
      id: "analysis", cwd: home, interpreter, environment: { path, names: ["FRED_RUNTIME_FIXTURE_KEY"] },
    });
    let output = "";
    const count = await runtime.execute(kernel, [
      "import os", "print(os.getcwd())", "value = 42",
      "assert os.environ.get('FRED_RUNTIME_FIXTURE_KEY') == 'fake-fred-key'",
      "assert 'JUPYTER_FIXTURE_UNSELECTED' not in os.environ",
    ].join("\n"), message => {
      if (message.type === "stream" && message.content.name === "stdout") output += message.content.text;
    });
    assert.equal(count, 1);
    assert.equal(output.trim(), location.kind === "wsl" ? notebookWslPath(home) : home);

    const mime = "application/vnd.plotly.v1+json";
    let figureBytes = 0;
    await runtime.execute(kernel, [
      "from IPython.display import display",
      "assert value == 42",
      "size = 220_000",
      "figure = {'data': [{'type': 'scattergl', 'x': list(range(size)), 'y': [i / 374583415173197 for i in range(size)]}], 'layout': {}}",
      "display({" + JSON.stringify(mime) + ": figure}, raw=True)",
    ].join("\n"), message => {
      if (message.type === "display_data") {
        const bundle = message.content.data as Record<string, unknown>;
        figureBytes = Buffer.byteLength(JSON.stringify(bundle[mime]));
      }
    });
    assert.ok(figureBytes > 5 * 1024 * 1024, "expected a full Plotly MIME bundle over 5 MiB");

    let notifyStarted!: () => void;
    const started = new Promise<void>(resolve => { notifyStarted = resolve; });
    const result = runtime.execute(kernel, "print('running', flush=True)\nwhile True:\n    pass", message => {
      if (message.type === "stream" && String(message.content.text).includes("running")) notifyStarted();
    });
    const failed = assert.rejects(result, /Python execution failed/);
    // Surface early failures immediately so the assertion cannot wait on a print that never arrived.
    await Promise.race([started, result.then(() => { throw new Error("kernel never started the interrupt fixture"); })]);
    await runtime.interrupt(kernel);
    await failed;
    await runtime.execute(kernel, "assert value == 42", () => {});

    await runtime.stop(kernel);
    const replacement = await runtime.createKernel({ id: "analysis", cwd: home, interpreter });
    assert.notEqual(replacement, kernel);
    assert.equal(await runtime.execute(replacement, "assert 'value' not in globals()", () => {}), 1);
    await assert.rejects(runtime.execute(replacement, "import os\nos._exit(1)", () => {}), /exited unexpectedly|disconnected/);
    assert.deepEqual(stopped, [replacement]);
  } finally {
    try { await runtime.close(); } finally { removeTempDir(home); }
  }
}

test("native Jupyter host carries a large Plotly MIME bundle and handles interrupt, restart and kernel exit", {
  skip: !nativeHost || !nativeKernel ? "set ODIN_TEST_JUPYTER_HOST_PYTHON and optionally ODIN_TEST_JUPYTER_KERNEL_PYTHON" : false,
  timeout: 120_000,
}, async () => {
  await exerciseRuntime({ kind: "native" }, nativeHost!, nativeKernel!);
});

test("WSL Jupyter host carries a large Plotly MIME bundle and handles interrupt, restart and kernel exit", {
  skip: !wslDistro || !wslHost || !wslKernel ? "set ODIN_TEST_WSL_DISTRO and ODIN_TEST_WSL_JUPYTER_HOST_PYTHON" : false,
  timeout: 120_000,
}, async () => {
  await exerciseRuntime({ kind: "wsl", distro: wslDistro! }, wslHost!, wslKernel!);
});
