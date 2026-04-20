export const onRequest = async (context: any) => {
  const url = new URL(context.request.url);

  if (url.pathname.startsWith('/api/')) {
    return context.next();
  }

  const assetResponse = await context.next();
  if (assetResponse.status !== 404) {
    return assetResponse;
  }

  url.pathname = '/index.html';
  return context.env.ASSETS.fetch(new Request(url.toString(), context.request));
};
