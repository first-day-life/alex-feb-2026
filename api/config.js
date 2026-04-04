export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    shopifyConfigured: !!(process.env.SHOPIFY_URL && process.env.SHOPIFY_TOKEN),
    sheetUrl: process.env.SHEET_URL || "",
  });
}
