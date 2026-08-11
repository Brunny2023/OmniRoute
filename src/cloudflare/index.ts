import { Container, getContainer, switchPort } from "@cloudflare/containers";
import { DurableObject } from "cloudflare:workers";

const CONTAINER_PORT = 20128;
const LIVE_WS_PORT = 20132;
const INTERNAL_LIVE_WS_ORIGIN = "https://omniroute-worker.internal";
const REQUEST_ID_HEADER = "x-omniroute-request-id";
const DEFAULT_RATE_LIMIT_MAX = 120;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_MAX_REQUEST_BYTES = 52_428_800;

type RateLimitState = {
  count: number;
  windowStartedAt: number;
};

type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  resetAt: number;
};

export interface Env {
  OMNIROUTE_CONTAINER: DurableObjectNamespace<OmniRouteContainer>;
  OMNIROUTE_EDGE_RATE_LIMITER: DurableObjectNamespace<EdgeRateLimiter>;
  OMNIROUTE_EDGE_RATE_LIMIT_MAX?: string;
  OMNIROUTE_EDGE_RATE_LIMIT_WINDOW_MS?: string;
  OMNIROUTE_MAX_REQUEST_BYTES?: string;
  OMNIROUTE_CONTAINER_SLEEP_AFTER?: string;
  JWT_SECRET: string;
  API_KEY_SECRET: string;
  INITIAL_PASSWORD: string;
  STORAGE_ENCRYPTION_KEY: string;
  OMNIROUTE_WS_BRIDGE_SECRET: string;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clientIdentity(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown-client";
}

function isLiveWebSocketRequest(request: Request, url: URL): boolean {
  return (
    request.headers.get("Upgrade")?.toLowerCase() === "websocket" &&
    (url.pathname === "/live-ws" || url.pathname.startsWith("/live-ws/"))
  );
}

function isSameOrigin(request: Request, url: URL): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return false;

  try {
    const parsedOrigin = new URL(origin);
    return parsedOrigin.protocol === url.protocol && parsedOrigin.host === url.host;
  } catch {
    return false;
  }
}

function publicLiveWebSocketUrl(url: URL): string {
  const protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${url.host}/live-ws`;
}

function requestWithHeader(request: Request, name: string, value: string): Request {
  const headers = new Headers(request.headers);
  headers.set(name, value);
  return new Request(request, { headers });
}

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/json; charset=utf-8");
  responseHeaders.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

async function rateLimit(request: Request, env: Env): Promise<RateLimitResult> {
  const limiter = env.OMNIROUTE_EDGE_RATE_LIMITER.getByName(clientIdentity(request));
  const limit = positiveInteger(env.OMNIROUTE_EDGE_RATE_LIMIT_MAX, DEFAULT_RATE_LIMIT_MAX);
  const windowMs = positiveInteger(
    env.OMNIROUTE_EDGE_RATE_LIMIT_WINDOW_MS,
    DEFAULT_RATE_LIMIT_WINDOW_MS
  );
  const response = await limiter.fetch("https://rate-limiter.internal/check", {
    method: "POST",
    body: JSON.stringify({ limit, windowMs }),
    headers: { "content-type": "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Edge rate limiter returned HTTP ${response.status}`);
  }

  return response.json<RateLimitResult>();
}

async function rewriteHandshakeResponse(response: Response, url: URL): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok || !contentType.includes("application/json")) return response;

  const payload = await response.json<Record<string, unknown>>();
  const live =
    payload.live && typeof payload.live === "object" && !Array.isArray(payload.live)
      ? { ...(payload.live as Record<string, unknown>) }
      : {};
  live.publicUrl = publicLiveWebSocketUrl(url);
  live.path = "/live-ws";
  payload.live = live;

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(payload), { status: response.status, headers });
}

export class EdgeRateLimiter extends DurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return jsonResponse({ error: "method_not_allowed" }, 405, { allow: "POST" });
    }

    const input = await request.json<{ limit?: number; windowMs?: number }>();
    const limit = Math.max(1, Math.floor(input.limit ?? DEFAULT_RATE_LIMIT_MAX));
    const windowMs = Math.max(1_000, Math.floor(input.windowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS));
    const now = Date.now();
    const previous = await this.ctx.storage.get<RateLimitState>("window");
    const active =
      !previous || now - previous.windowStartedAt >= windowMs
        ? { count: 0, windowStartedAt: now }
        : previous;
    const nextCount = active.count + 1;
    const resetAt = active.windowStartedAt + windowMs;
    const allowed = nextCount <= limit;

    await this.ctx.storage.put("window", {
      count: nextCount,
      windowStartedAt: active.windowStartedAt,
    } satisfies RateLimitState);

    return jsonResponse({
      allowed,
      remaining: Math.max(0, limit - nextCount),
      resetAt,
    } satisfies RateLimitResult);
  }
}

export class OmniRouteContainer extends Container<Env> {
  defaultPort = CONTAINER_PORT;
  sleepAfter = this.env.OMNIROUTE_CONTAINER_SLEEP_AFTER ?? "20m";
  enableInternet = true;
  pingEndpoint = "localhost/api/monitoring/health";
  envVars = {
    NODE_ENV: "production",
    PORT: String(CONTAINER_PORT),
    DASHBOARD_PORT: String(CONTAINER_PORT),
    DATA_DIR: "/tmp/omniroute",
    BASE_URL: `http://127.0.0.1:${CONTAINER_PORT}`,
    OMNIROUTE_DISABLE_REDIS: "1",
    AUTH_COOKIE_SECURE: "true",
    REQUIRE_API_KEY: "true",
    OMNIROUTE_ENABLE_LIVE_WS: "1",
    LIVE_WS_PORT: String(LIVE_WS_PORT),
    LIVE_WS_HOST: "0.0.0.0",
    LIVE_WS_ALLOWED_ORIGINS: INTERNAL_LIVE_WS_ORIGIN,
    OMNIROUTE_MITM_STUB: "1",
    JWT_SECRET: this.env.JWT_SECRET,
    API_KEY_SECRET: this.env.API_KEY_SECRET,
    INITIAL_PASSWORD: this.env.INITIAL_PASSWORD,
    STORAGE_ENCRYPTION_KEY: this.env.STORAGE_ENCRYPTION_KEY,
    OMNIROUTE_WS_BRIDGE_SECRET: this.env.OMNIROUTE_WS_BRIDGE_SECRET,
  };

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (isLiveWebSocketRequest(request, url)) {
      return super.fetch(switchPort(request, LIVE_WS_PORT));
    }
    return this.containerFetch(request);
  }

  override onStart(): void {
    console.log("OmniRoute Container started", { port: CONTAINER_PORT });
  }

  override onStop({ exitCode, reason }: { exitCode?: number; reason?: string }): void {
    console.log("OmniRoute Container stopped", { exitCode, reason });
  }

  override onError(error: unknown): never {
    console.error("OmniRoute Container failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const requestId = request.headers.get(REQUEST_ID_HEADER) ?? crypto.randomUUID();

    if (url.pathname === "/__cf/health") {
      const container = getContainer(env.OMNIROUTE_CONTAINER, "staging-singleton");
      const state = await container.getState();
      return jsonResponse({
        status: "ok",
        requestId,
        container: state.status,
      });
    }

    const declaredLength = Number.parseInt(request.headers.get("content-length") ?? "0", 10);
    const maxRequestBytes = positiveInteger(
      env.OMNIROUTE_MAX_REQUEST_BYTES,
      DEFAULT_MAX_REQUEST_BYTES
    );
    if (Number.isFinite(declaredLength) && declaredLength > maxRequestBytes) {
      return jsonResponse(
        {
          error: {
            message: "Request body exceeds the configured staging limit.",
            type: "request_too_large",
          },
          requestId,
        },
        413,
        { [REQUEST_ID_HEADER]: requestId }
      );
    }

    if (isLiveWebSocketRequest(request, url) && !isSameOrigin(request, url)) {
      return jsonResponse(
        {
          error: {
            message: "Live dashboard WebSocket requests must originate from this gateway.",
            type: "origin_forbidden",
          },
          requestId,
        },
        403,
        { [REQUEST_ID_HEADER]: requestId }
      );
    }

    let limit: RateLimitResult;
    try {
      limit = await rateLimit(request, env);
    } catch (error) {
      console.error("Edge rate limiter failed", {
        requestId,
        message: error instanceof Error ? error.message : String(error),
      });
      return jsonResponse(
        {
          error: {
            message: "Gateway rate-limit service is unavailable.",
            type: "service_unavailable",
          },
          requestId,
        },
        503,
        { [REQUEST_ID_HEADER]: requestId }
      );
    }

    if (!limit.allowed) {
      const retryAfter = Math.max(1, Math.ceil((limit.resetAt - Date.now()) / 1_000));
      return jsonResponse(
        {
          error: {
            message: "Staging gateway rate limit exceeded.",
            type: "rate_limit_exceeded",
          },
          requestId,
        },
        429,
        {
          [REQUEST_ID_HEADER]: requestId,
          "retry-after": String(retryAfter),
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(limit.resetAt),
        }
      );
    }

    const forwardedRequest = isLiveWebSocketRequest(request, url)
      ? requestWithHeader(request, "Origin", INTERNAL_LIVE_WS_ORIGIN)
      : request;
    const container = getContainer(env.OMNIROUTE_CONTAINER, "staging-singleton");

    try {
      const response = await container.fetch(forwardedRequest);
      const forwardedResponse =
        url.pathname === "/api/v1/ws" && url.searchParams.get("handshake") === "1"
          ? await rewriteHandshakeResponse(response, url)
          : response;
      const headers = new Headers(forwardedResponse.headers);
      headers.set(REQUEST_ID_HEADER, requestId);
      headers.set("x-ratelimit-remaining", String(limit.remaining));
      headers.set("x-ratelimit-reset", String(limit.resetAt));
      return new Response(forwardedResponse.body, {
        status: forwardedResponse.status,
        statusText: forwardedResponse.statusText,
        headers,
      });
    } catch (error) {
      console.error("Container request failed", {
        requestId,
        message: error instanceof Error ? error.message : String(error),
      });
      return jsonResponse(
        {
          error: {
            message: "The OmniRoute staging container is unavailable.",
            type: "container_unavailable",
          },
          requestId,
        },
        502,
        { [REQUEST_ID_HEADER]: requestId }
      );
    }
  },
} satisfies ExportedHandler<Env>;
