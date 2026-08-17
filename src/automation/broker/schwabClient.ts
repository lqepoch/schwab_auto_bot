import {
  HttpClient,
  type HttpMethod,
  type HttpResponse,
  type RequestOptions,
} from "../../utils/httpClient.ts";
import { createNullLogger } from "../../utils/logger.ts";

const apiBase = "https://api.schwabapi.com";

export type SchwabResponse<T> = HttpResponse<T>;

export class SchwabRestClient {
  private readonly http: HttpClient;

  constructor(options: { fetch?: typeof fetch } = {}) {
    this.http = new HttpClient({
      baseUrl: apiBase,
      fetch: options.fetch,
      logger: createNullLogger(),
      timeoutMs: 15_000,
      // The application owns quota admission and all write-outcome decisions.
      retryConfig: { maxRetries: 0 },
    });
  }

  async request<T>(path: string, init: RequestInit, accessToken: string): Promise<SchwabResponse<T>> {
    const headers = headersToRecord(init.headers);
    if (init.body !== undefined && !hasHeader(headers, "content-type")) {
      headers["Content-Type"] = "application/json";
    }
    const options: RequestOptions<T> = {
      method: (init.method ?? "GET").toUpperCase() as HttpMethod,
      headers: { Accept: "application/json", ...headers },
      body: init.body,
      accessToken,
      maxRetries: 0,
      timeoutMs: 15_000,
    };
    return this.http.requestWithResponse<T>(path, options);
  }
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  return Object.fromEntries(new Headers(headers).entries());
}

function hasHeader(headers: Record<string, string>, expected: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === expected);
}
