export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const domain = process.env.SHOPIFY_DOMAIN;
  const token = process.env.SHOPIFY_TOKEN;

  if (!domain || !token) {
    return res.status(500).json({
      error: "Shopify credentials not configured on server",
      debug: {
        hasDomain: !!domain,
        hasToken: !!token,
        domainPreview: domain ? domain.slice(0, 10) + "..." : null,
        tokenPreview: token ? token.slice(0, 8) + "..." : null,
      },
    });
  }

  const { query } = req.body;
  if (!query) {
    return res.status(400).json({ error: "Missing query in request body" });
  }

  const url = `https://${domain}/admin/api/2025-10/graphql.json`;

  try {
    const shopifyResp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({
        query: `query RunShopifyQL($q: String!) { shopifyqlQuery(query: $q) { tableData { columns { name dataType } rows } parseErrors } }`,
        variables: { q: query },
      }),
    });

    const rawText = await shopifyResp.text();
    let body;
    try {
      body = JSON.parse(rawText);
    } catch {
      body = null;
    }

    if (!shopifyResp.ok) {
      return res.status(shopifyResp.status).json({
        error: `Shopify returned HTTP ${shopifyResp.status}`,
        debug: {
          shopifyStatus: shopifyResp.status,
          shopifyStatusText: shopifyResp.statusText,
          requestUrl: url,
          domainUsed: domain,
          tokenPreview: token.slice(0, 8) + "...",
          responseHeaders: Object.fromEntries(shopifyResp.headers.entries()),
          responseBody: body || rawText.slice(0, 1000),
        },
      });
    }

    return res.status(200).json(body);
  } catch (err) {
    return res.status(502).json({
      error: `Proxy fetch failed: ${err.message}`,
      debug: {
        requestUrl: url,
        domainUsed: domain,
        tokenPreview: token.slice(0, 8) + "...",
        errorName: err.name,
        errorMessage: err.message,
      },
    });
  }
}
