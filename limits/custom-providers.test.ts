// Hermetic collector tests for readOpencodeGoUsage (node:test, no network):
// fetch is replaced on globalThis and the key comes from a temporary
// OPENCODE_AUTH_FILE, so the live ~/.pi/agent/auth.json is never read.
// Run with: npm test (node --experimental-strip-types --test).
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readOpencodeGoUsage } from "./custom-providers.ts";

const USAGE_URL = "https://opencode.ai/inference/go/v1/usage";
const FAKE_KEY = "test-opencode-key";
const AUTH_JSON = JSON.stringify({
  "opencode-go": { type: "api_key", key: FAKE_KEY },
});

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
}

/**
 * Each case runs with OPENCODE_GO_API_KEY / OPENCODE_API_KEY removed,
 * OPENCODE_AUTH_FILE pointed at a temp file and global fetch replaced.
 * Env and fetch are restored in `finally` so cases stay independent even
 * though they share process.env (--test-concurrency=1).
 */
async function sandbox(
  authJson: string,
  respond: (call: FetchCall) => Response,
  run: () => Promise<void>,
): Promise<FetchCall[]> {
  const dir = await mkdtemp(join(tmpdir(), "limits-opencode-test-"));
  const calls: FetchCall[] = [];

  const savedEnv = {
    go: process.env.OPENCODE_GO_API_KEY,
    plain: process.env.OPENCODE_API_KEY,
    authFile: process.env.OPENCODE_AUTH_FILE,
  };
  const savedFetch = globalThis.fetch;
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };

  delete process.env.OPENCODE_GO_API_KEY;
  delete process.env.OPENCODE_API_KEY;
  process.env.OPENCODE_AUTH_FILE = join(dir, "auth.json");
  await writeFile(process.env.OPENCODE_AUTH_FILE, authJson, "utf8");

  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const call: FetchCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers:
        init?.headers === undefined || init.headers === null
          ? {}
          : Object.fromEntries(
              typeof init.headers.entries === "function"
                ? init.headers.entries()
                : Object.entries(init.headers as Record<string, string>),
            ),
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;

  try {
    await run();
  } finally {
    globalThis.fetch = savedFetch;
    restore("OPENCODE_GO_API_KEY", savedEnv.go);
    restore("OPENCODE_API_KEY", savedEnv.plain);
    restore("OPENCODE_AUTH_FILE", savedEnv.authFile);
    await rm(dir, { recursive: true, force: true });
  }
  return calls;
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("readOpencodeGoUsage", () => {
  it("parses all three windows and sends the documented request", async () => {
    const calls = await sandbox(
      AUTH_JSON,
      () =>
        jsonResponse(200, {
          usage: {
            rolling: {
              status: "ok",
              percent: 12.5,
              resetsAt: "2026-11-12T18:00:00.000Z",
            },
            weekly: {
              status: "ok",
              percent: 40,
              resetsAt: "2026-11-16T00:00:00.000Z",
            },
            monthly: {
              status: "ok",
              percent: 7,
              resetsAt: "2026-11-30T00:00:00.000Z",
            },
          },
        }),
      async () => {
        const usage = await readOpencodeGoUsage();
        assert.equal(usage.status, "ok");
        assert.equal(usage.message, null);
        assert.deepEqual(
          usage.windows.map((window) => window.label),
          ["5-hour", "Weekly", "Monthly"],
        );
        assert.deepEqual(
          usage.windows.map((window) => window.usedPercent),
          [12.5, 40, 7],
        );
        assert.deepEqual(
          usage.windows.map((window) => window.resetsAt),
          [
            "2026-11-12T18:00:00.000Z",
            "2026-11-16T00:00:00.000Z",
            "2026-11-30T00:00:00.000Z",
          ],
        );
      },
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, USAGE_URL);
    assert.equal(calls[0].method, "GET");
    assert.equal(calls[0].headers.Authorization, `Bearer ${FAKE_KEY}`);
    assert.equal(calls[0].headers.Accept, "application/json");
    assert.equal(calls[0].headers["User-Agent"], "bb-plugin-limits/1.1");
  });

  it("maps 401 to unauthenticated without windows", async () => {
    const calls = await sandbox(
      AUTH_JSON,
      () => jsonResponse(401, { error: "unauthorized" }),
      async () => {
        const usage = await readOpencodeGoUsage();
        assert.equal(usage.status, "unauthenticated");
        assert.deepEqual(usage.windows, []);
        assert.equal(usage.message, null);
      },
    );
    assert.equal(calls.length, 1);
  });

  it("maps 404 to the no-subscription error message", async () => {
    const calls = await sandbox(
      AUTH_JSON,
      () => jsonResponse(404, { error: "not found" }),
      async () => {
        const usage = await readOpencodeGoUsage();
        assert.equal(usage.status, "error");
        assert.equal(usage.message, "no OpenCode Go subscription on this key");
        assert.deepEqual(usage.windows, []);
      },
    );
    assert.equal(calls.length, 1);
  });

  it("reports not_installed when no key is available, without fetching", async () => {
    const calls = await sandbox(
      "{}",
      () => {
        throw new Error("network must not be touched without a key");
      },
      async () => {
        const usage = await readOpencodeGoUsage();
        assert.equal(usage.status, "not_installed");
        assert.deepEqual(usage.windows, []);
        assert.equal(usage.message, null);
      },
    );
    assert.equal(calls.length, 0);
  });

  it("treats a JSON `null` auth document as no key instead of crashing", async () => {
    const calls = await sandbox(
      "null",
      () => {
        throw new Error("network must not be touched without a key");
      },
      async () => {
        const usage = await readOpencodeGoUsage();
        assert.equal(usage.status, "not_installed");
        assert.deepEqual(usage.windows, []);
        assert.equal(usage.message, null);
      },
    );
    assert.equal(calls.length, 0);
  });

  it("clamps percent into 0..100, leaving in-range values untouched", async () => {
    await sandbox(
      AUTH_JSON,
      () =>
        jsonResponse(200, {
          usage: {
            rolling: { status: "ok", percent: -5, resetsAt: null },
            weekly: { status: "ok", percent: 250, resetsAt: null },
            monthly: { status: "ok", percent: 42, resetsAt: null },
          },
        }),
      async () => {
        const usage = await readOpencodeGoUsage();
        assert.equal(usage.status, "ok");
        assert.deepEqual(
          usage.windows.map((window) => window.usedPercent),
          [0, 100, 42],
        );
      },
    );
  });
});
