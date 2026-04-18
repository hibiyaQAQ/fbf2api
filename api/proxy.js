export const config = { runtime: "edge", regions: ["iad1"] };

const CODEBUFF_BASE = "https://www.codebuff.com";

async function getRunId(auth) {
  const res = await fetch(`${CODEBUFF_BASE}/api/v1/agent-runs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": auth,
    },
    body: JSON.stringify({
      action: "START",
      agentId: "base2-free",
      ancestorRunIds: [],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to get runId: ${res.status} ${text}`);
  }
  const data = await res.json();
  return data.runId;
}

async function finishRun(runId, auth) {
  try {
    await fetch(`${CODEBUFF_BASE}/api/v1/agent-runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": auth,
      },
      body: JSON.stringify({
        action: "FINISH",
        runId,
        status: "completed",
        totalSteps: 0,
        directCredits: 0,
        totalCredits: 0,
      }),
    });
  } catch (e) {
    console.error("finishRun error:", e);
  }
}

async function handleChatCompletions(request) {
  const auth = request.headers.get("authorization");
  if (!auth) {
    return new Response(JSON.stringify({ error: "Missing Authorization header" }), {
      status: 401,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  const body = await request.json();
  const runId = await getRunId(auth);
  const isStream = body.stream === true;

  const upstreamBody = {
    ...body,
    codebuff_metadata: {
      run_id: runId,
      cost_mode: "free",
    },
  };

  const upstreamRes = await fetch(`${CODEBUFF_BASE}/api/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": auth,
    },
    body: JSON.stringify(upstreamBody),
  });

  if (!isStream) {
    const resBody = await upstreamRes.text();
    await finishRun(runId, auth);
    return new Response(resBody, {
      status: upstreamRes.status,
      headers: {
        "Content-Type": upstreamRes.headers.get("Content-Type") || "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  (async () => {
    try {
      const reader = upstreamRes.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await writer.write(value);
      }
    } catch (e) {
      console.error("stream error:", e);
    } finally {
      try { await writer.close(); } catch {}
      await finishRun(runId, auth);
    }
  })();

  return new Response(readable, {
    status: upstreamRes.status,
    headers: {
      "Content-Type": upstreamRes.headers.get("Content-Type") || "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export default async function handler(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  const url = new URL(request.url);

  if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
    return handleChatCompletions(request);
  }

  if (url.pathname === "/" || url.pathname === "/health") {
    return new Response(JSON.stringify({ status: "ok" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response("Not Found", { status: 404 });
}
