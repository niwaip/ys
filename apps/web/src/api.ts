export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  token: string,
  options: RequestInit = {},
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new ApiError(body.message ?? "请求失败，请稍后重试", response.status);
  return body as T;
}
