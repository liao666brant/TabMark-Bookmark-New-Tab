// 共享 favicon URL 构造。
// MV3 的 _favicon/ 端点只读本地 favicon 数据库，仅 pageUrl 与 size 两个参数生效；
// 请求较大尺寸时 Chrome 优先选"缩小而非放大"的源位图，显示端（24px、DPR≤2）需要 ≤48px 源。
export function createFaviconUrl(pageUrl: string): string {
  const url = new URL(chrome.runtime.getURL('/_favicon/'));
  url.searchParams.set('pageUrl', pageUrl);
  url.searchParams.set('size', '64');
  return url.toString();
}
