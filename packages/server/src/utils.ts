import type { IncomingMessage, ServerResponse } from 'http';
import type { Http2ServerRequest, Http2ServerResponse } from 'http2';
import type { Socket } from 'net';
import type { Readable } from 'stream';
import type { FetchAPI, FetchEvent } from './types.js';

export function isAsyncIterable(body: any): body is AsyncIterable<any> {
  return (
    body != null && typeof body === 'object' && typeof body[Symbol.asyncIterator] === 'function'
  );
}

export interface NodeRequest {
  protocol?: string;
  hostname?: string;
  body?: any;
  url?: string;
  originalUrl?: string;
  method?: string;
  headers?: any;
  req?: IncomingMessage | Http2ServerRequest;
  raw?: IncomingMessage | Http2ServerRequest;
  socket?: Socket;
  query?: any;
  once?(event: string, listener: (...args: any[]) => void): void;
  aborted?: boolean;
}

export type NodeResponse = ServerResponse | Http2ServerResponse;

function getPort(nodeRequest: NodeRequest) {
  if (nodeRequest.socket?.localPort) {
    return nodeRequest.socket?.localPort;
  }
  const hostInHeader = nodeRequest.headers?.[':authority'] || nodeRequest.headers?.host;
  const portInHeader = hostInHeader?.split(':')?.[1];
  if (portInHeader) {
    return portInHeader;
  }
  return 80;
}

function getHostnameWithPort(nodeRequest: NodeRequest) {
  if (nodeRequest.headers?.[':authority']) {
    return nodeRequest.headers?.[':authority'];
  }
  if (nodeRequest.headers?.host) {
    return nodeRequest.headers?.host;
  }
  const port = getPort(nodeRequest);
  if (nodeRequest.hostname) {
    return nodeRequest.hostname + ':' + port;
  }
  const localIp = nodeRequest.socket?.localAddress;
  if (localIp && !localIp?.includes('::') && !localIp?.includes('ffff')) {
    return `${localIp}:${port}`;
  }
  return 'localhost';
}

function buildFullUrl(nodeRequest: NodeRequest) {
  const hostnameWithPort = getHostnameWithPort(nodeRequest);
  const protocol =
    nodeRequest.protocol || ((nodeRequest.socket as any)?.encrypted ? 'https' : 'http');
  const endpoint = nodeRequest.originalUrl || nodeRequest.url || '/graphql';

  return `${protocol}://${hostnameWithPort}${endpoint}`;
}

function isRequestBody(body: any): body is BodyInit {
  const stringTag = body[Symbol.toStringTag];
  if (
    typeof body === 'string' ||
    stringTag === 'Uint8Array' ||
    stringTag === 'Blob' ||
    stringTag === 'FormData' ||
    stringTag === 'URLSearchParams' ||
    isAsyncIterable(body)
  ) {
    return true;
  }
  return false;
}

export class ServerAdapterRequestAbortSignal extends EventTarget implements AbortSignal {
  aborted = false;
  private _onabort: ((this: AbortSignal, ev: Event) => any) | null = null;
  reason: any;

  throwIfAborted(): void {
    if (this.aborted) {
      throw this.reason;
    }
  }

  sendAbort() {
    this.reason = new DOMException('This operation was aborted', 'AbortError');
    this.aborted = true;
    this.dispatchEvent(new Event('abort'));
  }

  get onabort() {
    return this._onabort;
  }

  set onabort(value) {
    this._onabort = value;
    if (value) {
      this.addEventListener('abort', value);
    } else {
      this.removeEventListener('abort', value);
    }
  }

  any(signals: Iterable<AbortSignal>): AbortSignal {
    return AbortSignal.any([...signals]);
  }
}

let bunNodeCompatModeWarned = false;

export const nodeRequestResponseMap = new WeakMap<NodeRequest, NodeResponse>();

export function normalizeNodeRequest(
  nodeRequest: NodeRequest,
  fetchAPI: FetchAPI,
  registerSignal?: (signal: ServerAdapterRequestAbortSignal) => void,
): Request {
  const rawRequest = nodeRequest.raw || nodeRequest.req || nodeRequest;
  let fullUrl = buildFullUrl(rawRequest);
  if (nodeRequest.query) {
    const url = new fetchAPI.URL(fullUrl);
    for (const key in nodeRequest.query) {
      url.searchParams.set(key, nodeRequest.query[key]);
    }
    fullUrl = url.toString();
  }

  let signal: AbortSignal | undefined;

  const nodeResponse = nodeRequestResponseMap.get(nodeRequest);
  nodeRequestResponseMap.delete(nodeRequest);
  let normalizedHeaders: Record<string, string> = nodeRequest.headers;
  if (nodeRequest.headers?.[':method']) {
    normalizedHeaders = {};
    for (const key in nodeRequest.headers) {
      if (!key.startsWith(':')) {
        normalizedHeaders[key] = nodeRequest.headers[key];
      }
    }
  }
  if (nodeResponse?.once) {
    let sendAbortSignal: VoidFunction;

    // If ponyfilled
    if (fetchAPI.Request !== globalThis.Request) {
      const newSignal = new ServerAdapterRequestAbortSignal();
      registerSignal?.(newSignal);
      signal = newSignal;
      sendAbortSignal = () => (signal as ServerAdapterRequestAbortSignal).sendAbort();
    } else {
      const controller = new AbortController();
      signal = controller.signal;
      sendAbortSignal = () => controller.abort();
    }

    const closeEventListener: EventListener = () => {
      if (signal && !signal.aborted) {
        (rawRequest as any).aborted = true;
        sendAbortSignal();
      }
    };

    nodeResponse.once('error', closeEventListener);
    nodeResponse.once('close', closeEventListener);

    nodeResponse.once('finish', () => {
      nodeResponse.removeListener('close', closeEventListener);
    });
  }

  if (nodeRequest.method === 'GET' || nodeRequest.method === 'HEAD') {
    return new fetchAPI.Request(fullUrl, {
      method: nodeRequest.method,
      headers: normalizedHeaders,
      signal,
    });
  }

  /**
   * Some Node server frameworks like Serverless Express sends a dummy object with body but as a Buffer not string
   * so we do those checks to see is there something we can use directly as BodyInit
   * because the presence of body means the request stream is already consumed and,
   * rawRequest cannot be used as BodyInit/ReadableStream by Fetch API in this case.
   */
  const maybeParsedBody = nodeRequest.body;
  if (maybeParsedBody != null && Object.keys(maybeParsedBody).length > 0) {
    if (isRequestBody(maybeParsedBody)) {
      return new fetchAPI.Request(fullUrl, {
        method: nodeRequest.method,
        headers: normalizedHeaders,
        body: maybeParsedBody,
        signal,
      });
    }
    const request = new fetchAPI.Request(fullUrl, {
      method: nodeRequest.method,
      headers: normalizedHeaders,
      signal,
    });
    if (!request.headers.get('content-type')?.includes('json')) {
      request.headers.set('content-type', 'application/json; charset=utf-8');
    }
    return new Proxy(request, {
      get: (target, prop: keyof Request, receiver) => {
        switch (prop) {
          case 'json':
            return async () => maybeParsedBody;
          case 'text':
            return async () => JSON.stringify(maybeParsedBody);
          default:
            return Reflect.get(target, prop, receiver);
        }
      },
    });
  }

  // Temporary workaround for a bug in Bun Node compat mode
  if (globalThis.process?.versions?.bun && isReadable(rawRequest)) {
    if (!bunNodeCompatModeWarned) {
      bunNodeCompatModeWarned = true;
      console.warn(
        `You use Bun Node compatibility mode, which is not recommended!
It will affect your performance. Please check our Bun integration recipe, and avoid using 'http' for your server implementation.`,
      );
    }
    return new fetchAPI.Request(fullUrl, {
      method: nodeRequest.method,
      headers: normalizedHeaders,
      duplex: 'half',
      body: new ReadableStream({
        start(controller) {
          rawRequest.on('data', chunk => {
            controller.enqueue(chunk);
          });
          rawRequest.on('error', e => {
            controller.error(e);
          });
          rawRequest.on('end', () => {
            controller.close();
          });
        },
        cancel(e) {
          rawRequest.destroy(e);
        },
      }),
      signal,
    } as RequestInit);
  }

  // perf: instead of spreading the object, we can just pass it as is and it performs better
  return new fetchAPI.Request(fullUrl, {
    method: nodeRequest.method,
    headers: normalizedHeaders,
    body: rawRequest as any,
    duplex: 'half',
    signal,
  } as RequestInit);
}

export function isReadable(stream: any): stream is Readable {
  return stream.read != null;
}

export function isNodeRequest(request: any): request is NodeRequest {
  return isReadable(request);
}

export function isServerResponse(stream: any): stream is NodeResponse {
  // Check all used functions are defined
  return (
    stream != null &&
    stream.setHeader != null &&
    stream.end != null &&
    stream.once != null &&
    stream.write != null
  );
}

export function isReadableStream(stream: any): stream is ReadableStream {
  return stream != null && stream.getReader != null;
}

export function isFetchEvent(event: any): event is FetchEvent {
  return event != null && event.request != null && event.respondWith != null;
}

function configureSocket(rawRequest: NodeRequest) {
  rawRequest?.socket?.setTimeout?.(0);
  rawRequest?.socket?.setNoDelay?.(true);
  rawRequest?.socket?.setKeepAlive?.(true);
}

function endResponse(serverResponse: NodeResponse) {
  // @ts-expect-error Avoid arguments adaptor trampoline https://v8.dev/blog/adaptor-frame
  serverResponse.end(null, null, null);
}

async function sendAsyncIterable(
  serverResponse: NodeResponse,
  asyncIterable: AsyncIterable<Uint8Array>,
) {
  let closed = false;
  const closeEventListener = () => {
    closed = true;
  };
  serverResponse.once('error', closeEventListener);
  serverResponse.once('close', closeEventListener);

  serverResponse.once('finish', () => {
    serverResponse.removeListener('close', closeEventListener);
  });
  for await (const chunk of asyncIterable) {
    if (closed) {
      break;
    }
    if (
      !serverResponse
        // @ts-expect-error http and http2 writes are actually compatible
        .write(chunk)
    ) {
      if (closed) {
        break;
      }
      await new Promise(resolve => serverResponse.once('drain', resolve));
    }
  }
  endResponse(serverResponse);
}

export function sendNodeResponse(
  fetchResponse: Response,
  serverResponse: NodeResponse,
  nodeRequest: NodeRequest,
) {
  if (serverResponse.closed || serverResponse.destroyed || serverResponse.writableEnded) {
    return;
  }
  if (!fetchResponse) {
    serverResponse.statusCode = 404;
    endResponse(serverResponse);
    return;
  }
  serverResponse.statusCode = fetchResponse.status;
  serverResponse.statusMessage = fetchResponse.statusText;

  let setCookiesSet = false;
  fetchResponse.headers.forEach((value, key) => {
    if (key === 'set-cookie') {
      if (setCookiesSet) {
        return;
      }
      setCookiesSet = true;
      const setCookies = fetchResponse.headers.getSetCookie?.();
      if (setCookies) {
        serverResponse.setHeader('set-cookie', setCookies);
        return;
      }
    }
    serverResponse.setHeader(key, value);
  });

  // Optimizations for node-fetch
  const bufOfRes = (fetchResponse as any)._buffer;
  if (bufOfRes) {
    // @ts-expect-error http and http2 writes are actually compatible
    serverResponse.write(bufOfRes);
    endResponse(serverResponse);
    return;
  }

  // Other fetch implementations
  const fetchBody = fetchResponse.body;
  if (fetchBody == null) {
    endResponse(serverResponse);
    return;
  }

  if ((fetchBody as any)[Symbol.toStringTag] === 'Uint8Array') {
    serverResponse
      // @ts-expect-error http and http2 writes are actually compatible
      .write(fetchBody);
    endResponse(serverResponse);
    return;
  }

  configureSocket(nodeRequest);

  if (isReadable(fetchBody)) {
    serverResponse.once('close', () => {
      fetchBody.destroy();
    });
    fetchBody.pipe(serverResponse);
    return;
  }

  if (isReadableStream(fetchBody)) {
    return sendReadableStream(serverResponse, fetchBody);
  }

  if (isAsyncIterable(fetchBody)) {
    return sendAsyncIterable(serverResponse, fetchBody);
  }
}

async function sendReadableStream(
  serverResponse: NodeResponse,
  readableStream: ReadableStream<Uint8Array>,
) {
  const reader = readableStream.getReader();
  serverResponse.req.once('error', err => {
    reader.cancel(err);
  });
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (
      !serverResponse
        // @ts-expect-error http and http2 writes are actually compatible
        .write(value)
    ) {
      await new Promise(resolve => serverResponse.once('drain', resolve));
    }
  }
  endResponse(serverResponse);
}

export function isRequestInit(val: unknown): val is RequestInit {
  return (
    val != null &&
    typeof val === 'object' &&
    ('body' in val ||
      'cache' in val ||
      'credentials' in val ||
      'headers' in val ||
      'integrity' in val ||
      'keepalive' in val ||
      'method' in val ||
      'mode' in val ||
      'redirect' in val ||
      'referrer' in val ||
      'referrerPolicy' in val ||
      'signal' in val ||
      'window' in val)
  );
}

// from https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/assign#copying_accessors
export function completeAssign(...args: any[]) {
  const [target, ...sources] = args.filter(arg => arg != null && typeof arg === 'object');
  sources.forEach(source => {
    // modified Object.keys to Object.getOwnPropertyNames
    // because Object.keys only returns enumerable properties
    const descriptors: any = Object.getOwnPropertyNames(source).reduce((descriptors: any, key) => {
      const descriptor = Object.getOwnPropertyDescriptor(source, key);
      if (descriptor) {
        descriptors[key] = Object.getOwnPropertyDescriptor(source, key);
      }
      return descriptors;
    }, {});

    // By default, Object.assign copies enumerable Symbols, too
    Object.getOwnPropertySymbols(source).forEach(sym => {
      const descriptor = Object.getOwnPropertyDescriptor(source, sym);
      if (descriptor?.enumerable) {
        descriptors[sym] = descriptor;
      }
    });

    Object.defineProperties(target, descriptors);
  });
  return target;
}

export function isPromise<T>(val: T | Promise<T>): val is Promise<T> {
  return (val as any)?.then != null;
}

export function iterateAsyncVoid<TInput>(
  iterable: Iterable<TInput>,
  callback: (input: TInput, stopEarly: () => void) => Promise<void> | void,
): Promise<void> | void {
  const iterator = iterable[Symbol.iterator]();
  let stopEarlyFlag = false;
  function stopEarlyFn() {
    stopEarlyFlag = true;
  }
  function iterate(): Promise<void> | void {
    const { done: endOfIterator, value } = iterator.next();
    if (endOfIterator) {
      return;
    }
    const result$ = callback(value, stopEarlyFn);
    if (isPromise(result$)) {
      return result$.then(() => {
        if (stopEarlyFlag) {
          return;
        }
        return iterate();
      });
    }
    if (stopEarlyFlag) {
      return;
    }
    return iterate();
  }
  return iterate();
}

export function handleErrorFromRequestHandler(error: any, ResponseCtor: typeof Response) {
  return new ResponseCtor(error.stack || error.message || error.toString(), {
    status: error.status || 500,
  });
}

export function isolateObject<TIsolatedObject extends object>(
  originalCtx: TIsolatedObject,
  waitUntilFn?: (promiseLike: PromiseLike<unknown>) => void,
): TIsolatedObject {
  if (originalCtx == null) {
    if (waitUntilFn == null) {
      return {} as TIsolatedObject;
    }
    return {
      waitUntil: waitUntilFn,
    } as TIsolatedObject;
  }
  return completeAssign(
    Object.create(originalCtx),
    {
      waitUntil: waitUntilFn,
    },
    originalCtx,
  );
}

export interface DeferredPromise<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: any) => void;
}

export function createDeferredPromise<T = void>(): DeferredPromise<T> {
  let resolveFn: (value: T) => void;
  let rejectFn: (reason: any) => void;
  const promise = new Promise<T>(function deferredPromiseExecutor(resolve, reject) {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return {
    promise,
    get resolve() {
      return resolveFn;
    },
    get reject() {
      return rejectFn;
    },
  };
}

export function handleAbortSignalAndPromiseResponse(
  response$: Promise<Response> | Response,
  abortSignal?: AbortSignal | null,
) {
  if (isPromise(response$) && abortSignal) {
    const deferred$ = createDeferredPromise<Response>();
    abortSignal.addEventListener('abort', function abortSignalFetchErrorHandler() {
      deferred$.reject(abortSignal.reason);
    });
    response$
      .then(function fetchSuccessHandler(res) {
        deferred$.resolve(res);
      })
      .catch(function fetchErrorHandler(err) {
        deferred$.reject(err);
      });
    return deferred$.promise;
  }
  return response$;
}

export const decompressedResponseMap = new WeakMap<Response, Response>();

const supportedEncodingsByFetchAPI = new WeakMap<FetchAPI, CompressionFormat[]>();

export function getSupportedEncodings(fetchAPI: FetchAPI) {
  let supportedEncodings = supportedEncodingsByFetchAPI.get(fetchAPI);
  if (!supportedEncodings) {
    const possibleEncodings = ['deflate', 'gzip', 'deflate-raw', 'br'] as CompressionFormat[];
    if ((fetchAPI.DecompressionStream as any)?.['supportedFormats']) {
      supportedEncodings = (fetchAPI.DecompressionStream as any)[
        'supportedFormats'
      ] as CompressionFormat[];
    } else {
      supportedEncodings = possibleEncodings.filter(encoding => {
        // deflate-raw is not supported in Node.js >v20
        if (
          globalThis.process?.version?.startsWith('v2') &&
          fetchAPI.DecompressionStream === globalThis.DecompressionStream &&
          encoding === 'deflate-raw'
        ) {
          return false;
        }
        try {
          // eslint-disable-next-line no-new
          new fetchAPI.DecompressionStream(encoding);
          return true;
        } catch {
          return false;
        }
      });
    }

    supportedEncodingsByFetchAPI.set(fetchAPI, supportedEncodings);
  }
  return supportedEncodings;
}

export function handleResponseDecompression(response: Response, fetchAPI: FetchAPI) {
  const contentEncodingHeader = response?.headers.get('content-encoding');
  if (!contentEncodingHeader || contentEncodingHeader === 'none') {
    return response;
  }
  if (!response?.body) {
    return response;
  }
  let decompressedResponse = decompressedResponseMap.get(response);
  if (!decompressedResponse || decompressedResponse.bodyUsed) {
    let decompressedBody = response.body;
    const contentEncodings = contentEncodingHeader.split(',');
    if (
      !contentEncodings.every(encoding =>
        getSupportedEncodings(fetchAPI).includes(encoding as CompressionFormat),
      )
    ) {
      return new fetchAPI.Response(`Unsupported 'Content-Encoding': ${contentEncodingHeader}`, {
        status: 415,
        statusText: 'Unsupported Media Type',
      });
    }
    for (const contentEncoding of contentEncodings) {
      decompressedBody = decompressedBody.pipeThrough(
        new fetchAPI.DecompressionStream(contentEncoding as CompressionFormat),
      );
    }
    decompressedResponse = new fetchAPI.Response(decompressedBody, response);
    decompressedResponseMap.set(response, decompressedResponse);
  }
  return decompressedResponse;
}

const terminateEvents = ['SIGINT', 'exit', 'SIGTERM'] as const;
const disposableStacks = new Set<AsyncDisposableStack>();

let eventListenerRegistered = false;

function ensureEventListenerForDisposableStacks() {
  if (eventListenerRegistered) {
    return;
  }
  eventListenerRegistered = true;
  for (const event of terminateEvents) {
    globalThis.process.once(event, function terminateHandler() {
      return Promise.allSettled(
        [...disposableStacks].map(stack => !stack.disposed && stack.disposeAsync()),
      );
    });
  }
}

export function ensureDisposableStackRegisteredForTerminateEvents(
  disposableStack: AsyncDisposableStack,
) {
  if (globalThis.process) {
    ensureEventListenerForDisposableStacks();
    if (!disposableStacks.has(disposableStack)) {
      disposableStacks.add(disposableStack);
      disposableStack.defer(() => {
        disposableStacks.delete(disposableStack);
      });
    }
  }
}
