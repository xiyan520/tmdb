/**
 * Vercel Edge Function - TMDB Proxy
 * 保留原有 Cloudflare Workers 的运行逻辑
 */

const API_ORIGIN = 'https://api.themoviedb.org';
const IMAGE_ORIGIN = 'https://image.tmdb.org';

export const config = {
  runtime: 'edge',
};

export default async function handler(request, context) {
  const url = new URL(request.url);
  let { pathname, search } = url;

  // 移除 /api/tmdb 前缀（因为 rewrites 会路由到这里）
  if (pathname.startsWith('/api/tmdb')) {
    pathname = pathname.replace('/api/tmdb', '');
  }

  // 如果路径为空，从查询参数获取（rewrites 传递的路径）
  if (!pathname || pathname === '/') {
    const pathParam = url.searchParams.get('path') || '';
    if (pathParam) {
      pathname = pathParam.startsWith('/') ? pathParam : '/' + pathParam;
      // 移除 path 参数，避免传递给上游
      const newSearchParams = new URLSearchParams(url.searchParams);
      newSearchParams.delete('path');
      search = newSearchParams.toString() ? '?' + newSearchParams.toString() : '';
    }
  }

  // 仅针对 TMDB 规范路径做透明转发
  if (pathname.startsWith('/3/') || pathname.startsWith('/4/')) {
    const target = `${API_ORIGIN}${pathname}${search}`;
    return proxy(request, target);
  }

  if (pathname.startsWith('/t/p/')) {
    const target = `${IMAGE_ORIGIN}${pathname}${search}`;
    return proxy(request, target);
  }

  // 其它路径返回简单说明，避免误用
  return new Response('OK: use /3/... or /4/... for API, /t/p/... for images', {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
}

/**
 * 透明代理：最大程度保持请求与响应与官方一致
 */
async function proxy(incomingRequest, targetUrl) {
  // 复制请求头（去除不该透传的 hop-by-hop 头部）
  const hopByHop = new Set([
    'connection',
    'keep-alive',
    'transfer-encoding',
    'proxy-connection',
    'upgrade',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailers'
  ]);

  const reqHeaders = new Headers();
  for (const [k, v] of incomingRequest.headers) {
    if (!hopByHop.has(k.toLowerCase()) && k.toLowerCase() !== 'host') {
      reqHeaders.append(k, v);
    }
  }

  // 构造新的上游请求，保持方法与主体
  const isImage = targetUrl.startsWith(IMAGE_ORIGIN);
  const init = {
    method: incomingRequest.method,
    headers: reqHeaders,
    body: needsBody(incomingRequest.method) ? incomingRequest.body : undefined,
    // 为兼容 Emby/Jellyfin 与浏览器显示，图片一律跟随重定向拿最终二进制
    redirect: isImage ? 'follow' : 'manual'
  };

  const upstreamRes = await fetch(targetUrl, init);

  // 复制上游响应头（同样去除 hop-by-hop 头）
  const resHeaders = new Headers();
  for (const [k, v] of upstreamRes.headers) {
    if (!hopByHop.has(k.toLowerCase())) {
      resHeaders.append(k, v);
    }
  }

  // 原样返回状态码、状态文本、响应体与大多数响应头
  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    statusText: upstreamRes.statusText,
    headers: resHeaders
  });
}

function needsBody(method) {
  const m = method.toUpperCase();
  return m !== 'GET' && m !== 'HEAD';
}

