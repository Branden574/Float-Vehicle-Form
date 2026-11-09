import type { Photo } from './types';
let csrfToken = '';
let sessionEpoch = 0;
const activeUploads = new Set<XMLHttpRequest>();
export function setCsrf(value: string) {
  if (csrfToken !== value) sessionEpoch += 1;
  csrfToken = value;
}
export function clearPrivateState() {
  sessionEpoch += 1;
  csrfToken = '';
  for (const xhr of activeUploads) xhr.abort();
  activeUploads.clear();
  sessionStorage.clear();
  navigator.serviceWorker?.controller?.postMessage('CLEAR_PRIVATE_DATA');
}
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const startedInSession = sessionEpoch;
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData))
    headers.set('Content-Type', 'application/json');
  if (options.method && !['GET', 'HEAD'].includes(options.method))
    headers.set('X-CSRF-Token', csrfToken);
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      signal: options.signal || AbortSignal.timeout(120000),
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(
      'Connection interrupted. A submission may have reached the server. Keep this draft open and retry the same request after reconnecting.',
      0,
    );
  }
  if (startedInSession !== sessionEpoch && path !== '/auth/logout') {
    throw new ApiError('The signed-in session changed. This older response was discarded.', 409);
  }
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    if (response.status === 401 && csrfToken && !path.startsWith('/auth/login'))
      window.dispatchEvent(new Event('session-expired'));
    throw new ApiError(
      typeof error.error === 'string' ? error.error : 'This request could not be completed.',
      response.status,
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json();
}
export const post = <T>(path: string, body: unknown, headers?: Record<string, string>) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body), headers });
export const patch = <T>(path: string, body: unknown) =>
  api<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
export async function uploadPhoto(
  data: FormData,
  progress: (value: number) => void,
): Promise<Photo> {
  const epoch = sessionEpoch;
  const file = data.get('file');
  if (!(file instanceof File)) throw new ApiError('Choose a photo first.', 400);
  const metadata = Object.fromEntries([...data.entries()].filter(([key]) => key !== 'file'));
  const ticket = await post<{
    direct: boolean;
    ticketId?: string;
    url?: string;
    headers?: Record<string, string>;
  }>('/photos/upload-ticket', { ...metadata, bytes: file.size });
  if (ticket.direct && ticket.url && ticket.ticketId) {
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', ticket.url!);
      activeUploads.add(xhr);
      xhr.onloadend = () => activeUploads.delete(xhr);
      xhr.onabort = () => reject(new ApiError('Upload cancelled when this session ended.', 0));
      xhr.timeout = 120000;
      for (const [key, value] of Object.entries(ticket.headers || {}))
        xhr.setRequestHeader(key, value);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) progress(Math.round((e.loaded / e.total) * 90));
      };
      xhr.onload = () =>
        xhr.status >= 200 && xhr.status < 300
          ? resolve()
          : reject(new ApiError('Photo upload failed. Tap Retry.', xhr.status));
      xhr.onerror = xhr.ontimeout = () =>
        reject(new ApiError('Upload interrupted. Reconnect, then tap Retry.', 0));
      xhr.send(file);
    });
    if (epoch !== sessionEpoch) throw new ApiError('The signed-in session changed.', 409);
    const result = await post<{ photo: Photo }>(
      `/photos/upload-ticket/${ticket.ticketId}/complete`,
      {},
    );
    progress(100);
    return result.photo;
  }
  return uploadLocalPhoto(data, progress);
}
function uploadLocalPhoto(data: FormData, progress: (value: number) => void): Promise<Photo> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/photos');
    xhr.withCredentials = true;
    activeUploads.add(xhr);
    xhr.onloadend = () => activeUploads.delete(xhr);
    xhr.onabort = () => reject(new ApiError('Upload cancelled when this session ended.', 0));
    xhr.setRequestHeader('X-CSRF-Token', csrfToken);
    xhr.timeout = 120000;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) progress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      let result: { photo?: Photo; error?: string } = {};
      try {
        result = JSON.parse(xhr.responseText);
      } catch {
        /* handled below */
      }
      if (xhr.status >= 200 && xhr.status < 300 && result.photo) resolve(result.photo);
      else {
        if (xhr.status === 401) window.dispatchEvent(new Event('session-expired'));
        reject(new ApiError(result.error || 'Upload failed. Please try again.', xhr.status));
      }
    };
    xhr.onerror = xhr.ontimeout = () =>
      reject(new ApiError('Upload interrupted. Reconnect, then tap Retry.', 0));
    xhr.send(data);
  });
}
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong. Please try again.';
export const formatDate = (value?: string, timezone = 'America/Los_Angeles') =>
  value
    ? new Intl.DateTimeFormat('en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: timezone,
      }).format(new Date(value))
    : '—';
export const humanize = (value: string) =>
  value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
export const miles = (value?: number) =>
  typeof value === 'number' ? value.toLocaleString('en-US') : '—';
