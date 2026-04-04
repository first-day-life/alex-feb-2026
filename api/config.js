export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    shopifyDomain: process.env.SHOPIFY_URL || "",
    shopifyToken: process.env.SHOPIFY_TOKEN || "",
    sheetUrl: process.env.SHEET_URL || "",
  });
}
