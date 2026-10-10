/**
 * The only place in the codebase that talks to the Venice API. Server-side
 * only — nothing here may be reachable from client code.
 *
 * The API key is read lazily at call time, never at import time, never
 * logged, and never included in any error message or thrown object.
 */

export const VENICE_BASE_URL = 'https://api.venice.ai';

export const DEFAULT_TEXT_MODEL = 'z-ai-glm-5-3-flash';
export const DEFAULT_IMAGE_MODEL = 'venice-sd35';
export const DEFAULT_TTS_MODEL = 'tts-elevenlabs-turbo-v2-5';

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_BACKOFF_MS = 500;
/**
 * The health probe's completion budget. Deliberately not 1: a reasoning model given a
 * single token can spend it on reasoning and return `content: null`, and the probe
 * must not confuse that with an unreachable API.
 */
export const HEALTH_MAX_TOKENS = 16;

/** Resolved Venice settings. Never contains the API key. */
export interface VeniceConfig {
  baseUrl: string;
  textModel: string;
  imageModel: string;
  ttsModel: string;
}

/** Describes the resolved settings. Safe to log or serialize — no secrets. */
export function veniceConfig(): VeniceConfig {
  return {
    baseUrl: VENICE_BASE_URL,
    textModel: process.env.VENICE_TEXT_MODEL ?? DEFAULT_TEXT_MODEL,
    imageModel: process.env.VENICE_IMAGE_MODEL ?? DEFAULT_IMAGE_MODEL,
    ttsModel: process.env.VENICE_TTS_MODEL ?? DEFAULT_TTS_MODEL,
  };
}

/** The kind of Venice call that failed, for typed error handling. */
export type VeniceCapability = 'text' | 'image' | 'speech';

/** Error thrown for any Venice failure. Never carries the API key. */
export class VeniceError extends Error {
  readonly capability: VeniceCapability;
  /** HTTP status when the API answered, undefined for transport failures. */
  readonly status?: number;

  constructor(capability: VeniceCapability, message: string, status?: number) {
    super(message);
    this.name = 'VeniceError';
    this.capability = capability;
    if (status !== undefined) this.status = status;
  }
}

/** The environment is missing the key needed to call Venice at all. */
export class VeniceConfigError extends VeniceError {
  constructor(capability: VeniceCapability) {
    super(capability, 'VENICE_API_KEY is not set; set it in the server environment.');
    this.name = 'VeniceConfigError';
  }
}

/** The Venice call exceeded its timeout or was aborted. */
export class VeniceTimeoutError extends VeniceError {
  constructor(capability: VeniceCapability, timeoutMs: number) {
    super(capability, `Venice ${capability} call timed out after ${timeoutMs}ms.`);
    this.name = 'VeniceTimeoutError';
  }
}

export interface VeniceRequestOptions {
  /** Per-call timeout, defaulting to DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Retry budget for 429 and 5xx responses, defaulting to DEFAULT_MAX_RETRIES. */
  maxRetries?: number;
  /** Base delay for exponential backoff between retries. */
  backoffMs?: number;
  /** Test seam: how long to actually wait between retries. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionOptions extends VeniceRequestOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ChatCompletionResult {
  content: string;
  model: string;
  raw: unknown;
}

export interface ImageGenerationOptions extends VeniceRequestOptions {
  model?: string;
  width?: number;
  height?: number;
}

export interface ImageGenerationResult {
  /** Base64-encoded image payloads as returned by the API. */
  images: string[];
  model: string;
  raw: unknown;
}

export interface SpeechOptions extends VeniceRequestOptions {
  model?: string;
  voice?: string;
}

export interface SpeechResult {
  audio: Uint8Array;
  contentType: string;
}

/** Minimal structural interface so tests can inject a fake client. */
export interface VeniceClient {
  chat(messages: ChatMessage[], options?: ChatCompletionOptions): Promise<ChatCompletionResult>;
  generateImage(prompt: string, options?: ImageGenerationOptions): Promise<ImageGenerationResult>;
  synthesizeSpeech(text: string, options?: SpeechOptions): Promise<SpeechResult>;
  health(timeoutMs?: number): Promise<VeniceHealthResult>;
}

export interface VeniceHealthResult {
  ok: boolean;
  reachable: boolean;
  textModel: string;
  imageModel: string;
  ttsModel: string;
  /** Set when the key was missing before any network call was attempted. */
  configured: boolean;
  detail?: string;
  /**
   * Configured model ids that Venice does not advertise. Absent when the model
   * list could not be read — that is best-effort and never fails a health check.
   */
  missingModels?: string[];
}

/** Injectable fetch, so tests never touch the network. */
export type VeniceFetch = typeof fetch;

/** Read the key at call time, never earlier. The value never escapes. */
function readApiKey(capability: VeniceCapability): string {
  const key = process.env.VENICE_API_KEY;
  if (!key) throw new VeniceConfigError(capability);
  return key;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof Error && err.name === 'AbortError') ||
    (err instanceof Error && err.name === 'TimeoutError') ||
    (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 23)
  );
}

/** Venice's catalogue query values. Note `tts`, while the capability is `speech`. */
export type VeniceCatalogueType = 'text' | 'image' | 'tts';

/**
 * The model ids Venice advertises for one capability, or `undefined` if the list
 * cannot be read. Best-effort by design: it answers "is a configured model id real?",
 * which is a config check, not a reachability check — so it never fails a health probe.
 *
 * The catalogue is per-type: `/api/v1/models` with no query returns TEXT models only,
 * so image and TTS ids must be looked up with their own `?type=`.
 */
async function listModelIds(
  type: VeniceCatalogueType,
  fetchImpl: VeniceFetch,
  timeoutMs: number,
): Promise<string[] | undefined> {
  try {
    const key = readApiKey('text');
    const response = await fetchImpl(`${VENICE_BASE_URL}/api/v1/models?type=${type}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return undefined;
    const raw = (await response.json()) as { data?: { id?: unknown }[] };
    return (raw.data ?? [])
      .map((entry) => entry?.id)
      .filter((id): id is string => typeof id === 'string');
  } catch {
    return undefined;
  }
}

/**
 * One POST against Venice with a timeout and bounded retries on 429/5xx.
 * 4xx other than 429 fails immediately. The key goes into a header and
 * nowhere else.
 */
async function requestVenice(
  capability: VeniceCapability,
  path: string,
  body: Record<string, unknown>,
  options: VeniceRequestOptions,
  fetchImpl: VeniceFetch = fetch,
): Promise<Response> {
  const key = readApiKey(capability);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: VeniceError | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await sleep(backoffMs * 2 ** (attempt - 1));
    }
    let response: Response;
    try {
      response = await fetchImpl(`${VENICE_BASE_URL}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (isAbortError(err)) {
        throw new VeniceTimeoutError(capability, timeoutMs);
      }
      // Transport-level failure (DNS, refused connection, TLS). Retryable in
      // the same way a 5xx is: the service is unreachable, not the request.
      lastError = new VeniceError(
        capability,
        `Venice ${capability} call failed: ${err instanceof Error ? err.name : 'network error'}.`,
      );
      continue;
    }

    if (response.ok) return response;

    // Drain the body without ever surfacing it — provider error bodies can
    // echo request headers back, and this codebase never leaks the key.
    await response.arrayBuffer().catch(() => new ArrayBuffer(0));

    if (!isRetryableStatus(response.status)) {
      throw new VeniceError(
        capability,
        `Venice ${capability} call was rejected with HTTP ${response.status}.`,
        response.status,
      );
    }
    lastError = new VeniceError(
      capability,
      `Venice ${capability} call failed with HTTP ${response.status} after retries.`,
      response.status,
    );
  }
  // Every attempt either returned, threw, or set lastError.
  throw lastError ?? new VeniceError(capability, `Venice ${capability} call failed.`);
}

/** The real Venice client. Construct once per process and inject it. */
export function createVeniceClient(fetchImpl: VeniceFetch = fetch): VeniceClient {
  const client: VeniceClient = {
    async chat(messages, options = {}) {
      const model = options.model ?? veniceConfig().textModel;
      const response = await requestVenice(
        'text',
        '/api/v1/chat/completions',
        {
          model,
          messages,
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
        },
        options,
        fetchImpl,
      );
      const raw: unknown = await response.json();
      const choices = (raw as { choices?: { message?: { content?: unknown } }[] }).choices;
      const content = choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new VeniceError('text', 'Venice text response had no message content.');
      }
      return { content, model, raw };
    },

    async generateImage(prompt, options = {}) {
      const model = options.model ?? veniceConfig().imageModel;
      const response = await requestVenice(
        'image',
        '/api/v1/image/generate',
        {
          model,
          prompt,
          ...(options.width !== undefined ? { width: options.width } : {}),
          ...(options.height !== undefined ? { height: options.height } : {}),
        },
        options,
        fetchImpl,
      );
      const raw: unknown = await response.json();
      const images = (raw as { images?: unknown }).images;
      if (!Array.isArray(images) || images.some((img) => typeof img !== 'string')) {
        throw new VeniceError('image', 'Venice image response had no base64 images.');
      }
      return { images: images as string[], model, raw };
    },

    async synthesizeSpeech(text, options = {}) {
      const model = options.model ?? veniceConfig().ttsModel;
      const response = await requestVenice(
        'speech',
        '/api/v1/audio/speech',
        {
          model,
          input: text,
          ...(options.voice !== undefined ? { voice: options.voice } : {}),
        },
        options,
        fetchImpl,
      );
      const audio = new Uint8Array(await response.arrayBuffer());
      return {
        audio,
        contentType: response.headers.get('content-type') ?? 'application/octet-stream',
      };
    },

    async health(timeoutMs = 5_000) {
      const config = veniceConfig();
      const base: VeniceHealthResult = {
        ok: false,
        reachable: false,
        configured: true,
        ...config,
      };
      try {
        // Judge reachability on the TRANSPORT, never on the completion body. A
        // reasoning model handed a tiny max_tokens can spend the whole budget on
        // reasoning and return `content: null` from a perfectly healthy API, which
        // made this probe report "unreachable" about half the time in production.
        const response = await requestVenice(
          'text',
          '/api/v1/chat/completions',
          {
            model: config.textModel,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: HEALTH_MAX_TOKENS,
          },
          { timeoutMs, maxRetries: 0 },
          fetchImpl,
        );
        // Drain the body so the socket is released. Not `body.cancel()`: cancelling
        // the body of a cloned response never settles in undici, and draining is
        // deterministic. We do not care about the content — only that it arrived.
        await response.arrayBuffer().catch(() => undefined);

        // Best-effort: a typo'd model id should surface to an operator, not to a
        // party mid-game. A failure to read a catalogue never fails the check, and
        // each capability is checked against ITS OWN catalogue.
        const [textIds, imageIds, ttsIds] = await Promise.all([
          listModelIds('text', fetchImpl, timeoutMs),
          listModelIds('image', fetchImpl, timeoutMs),
          listModelIds('tts', fetchImpl, timeoutMs),
        ]);
        const missingModels = [
          ...(textIds && !textIds.includes(config.textModel) ? [config.textModel] : []),
          ...(imageIds && !imageIds.includes(config.imageModel) ? [config.imageModel] : []),
          ...(ttsIds && !ttsIds.includes(config.ttsModel) ? [config.ttsModel] : []),
        ];

        return {
          ...base,
          ok: true,
          reachable: true,
          ...(missingModels.length > 0 ? { missingModels } : {}),
        };
      } catch (err) {
        if (err instanceof VeniceConfigError) {
          return { ...base, configured: false, detail: err.message };
        }
        return {
          ...base,
          detail: err instanceof VeniceError ? err.message : 'Venice health check failed.',
        };
      }
    },
  };
  return client;
}
