const API_VERSION = "2025-10";

const SHOPIFYQL_GQL = `
query RunShopifyQL($q: String!) {
  shopifyqlQuery(query: $q) {
    tableData {
      columns { name dataType }
      rows
    }
    parseErrors
  }
}
`;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  const shopifyUrl = process.env.SHOPIFY_URL;
  const shopifyToken = process.env.SHOPIFY_TOKEN;

  if (!shopifyUrl || !shopifyToken) {
    return res.status(500).json({ error: "SHOPIFY_URL or SHOPIFY_TOKEN not configured" });
  }

  const { query } = req.body || {};
  if (!query) {
    return res.status(400).json({ error: "Missing 'query' in request body" });
  }

  const domain = shopifyUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const endpoint = `https://${domain}/admin/api/${API_VERSION}/graphql.json`;

  try {
    const shopifyResp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": shopifyToken,
      },
      body: JSON.stringify({
        query: SHOPIFYQL_GQL,
        variables: { q: query },
      }),
    });

    const data = await shopifyResp.json();

    if (!shopifyResp.ok) {
      return res.status(shopifyResp.status).json({
        error: `Shopify returned HTTP ${shopifyResp.status}`,
        details: data,
      });
    }

    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
