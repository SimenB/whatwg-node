import { createReadStream } from 'fs';
import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import { Readable } from 'stream';
import { fileURLToPath } from 'url';
import { PonyfillAbortError } from './AbortError';
import { PonyfillBlob } from './Blob';
import { PonyfillRequest, RequestPonyfillInit } from './Request';
import { PonyfillResponse } from './Response';
import { PonyfillURL } from './URL';
import { getHeadersObj } from './utils';

function getResponseForFile(url: string) {
  const path = fileURLToPath(url);
  const readable = createReadStream(path);
  return new PonyfillResponse(readable);
}

function getRequestFnForProtocol(protocol: string) {
  switch (protocol) {
    case 'http:':
      return httpRequest;
    case 'https:':
      return httpsRequest;
  }
  throw new Error(`Unsupported protocol: ${protocol}`);
}

const BASE64_SUFFIX = ';base64';

export function fetchPonyfill<TResponseJSON = any, TRequestJSON = any>(
  info: string | PonyfillRequest<TRequestJSON> | URL,
  init?: RequestPonyfillInit,
): Promise<PonyfillResponse<TResponseJSON>> {
  if (typeof info === 'string' || 'href' in info) {
    const ponyfillRequest = new PonyfillRequest(info, init);
    return fetchPonyfill(ponyfillRequest);
  }

  const fetchRequest = info;

  return new Promise((resolve, reject) => {
    try {
      const url = new PonyfillURL(fetchRequest.url, 'http://localhost');

      if (url.protocol === 'data:') {
        const [mimeType = 'text/plain', ...datas] = url.pathname.split(',');
        const data = decodeURIComponent(datas.join(','));
        if (mimeType.endsWith(BASE64_SUFFIX)) {
          const buffer = Buffer.from(data, 'base64url');
          const realMimeType = mimeType.slice(0, -BASE64_SUFFIX.length);
          const file = new PonyfillBlob([buffer], { type: realMimeType });
          const response = new PonyfillResponse(file, {
            status: 200,
            statusText: 'OK',
          });
          resolve(response);
          return;
        }
        const response = new PonyfillResponse(data, {
          status: 200,
          statusText: 'OK',
          headers: {
            'content-type': mimeType,
          },
        });
        resolve(response);
        return;
      }

      if (url.protocol === 'file:') {
        const response = getResponseForFile(fetchRequest.url);
        resolve(response);
        return;
      }

      const requestFn = getRequestFnForProtocol(url.protocol);

      const nodeReadable = (
        fetchRequest.body != null
          ? 'pipe' in fetchRequest.body
            ? fetchRequest.body
            : Readable.from(fetchRequest.body)
          : null
      ) as Readable | null;
      const nodeHeaders = getHeadersObj(fetchRequest.headers);

      const abortListener: EventListener = function abortListener(event: Event) {
        nodeRequest.destroy();
        const reason = (event as CustomEvent).detail;
        reject(new PonyfillAbortError(reason));
      };

      fetchRequest.signal.addEventListener('abort', abortListener);

      const nodeRequest = requestFn(fetchRequest.url, {
        // signal: fetchRequest.signal will be added when v14 reaches EOL
        method: fetchRequest.method,
        headers: nodeHeaders,
      });

      nodeRequest.once('response', nodeResponse => {
        if (nodeResponse.headers.location) {
          if (fetchRequest.redirect === 'error') {
            const redirectError = new Error('Redirects are not allowed');
            reject(redirectError);
            nodeResponse.resume();
            return;
          }
          if (fetchRequest.redirect === 'follow') {
            const redirectedUrl = new PonyfillURL(nodeResponse.headers.location, url);
            const redirectResponse$ = fetchPonyfill(redirectedUrl, info);
            resolve(
              redirectResponse$.then(redirectResponse => {
                redirectResponse.redirected = true;
                return redirectResponse;
              }),
            );
            nodeResponse.resume();
            return;
          }
        }
        const responseHeaders: Record<string, string | string[] | undefined> = nodeResponse.headers;
        const ponyfillResponse = new PonyfillResponse(nodeResponse, {
          status: nodeResponse.statusCode,
          statusText: nodeResponse.statusMessage,
          headers: responseHeaders,
          url: info.url,
        });
        resolve(ponyfillResponse);
      });
      nodeRequest.once('error', reject);

      if (nodeReadable) {
        nodeReadable.pipe(nodeRequest);
      } else {
        nodeRequest.end();
      }
    } catch (e) {
      reject(e);
    }
  });
}
