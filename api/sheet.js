const SHEET_CSV_URL =
  "https://docs.google.com/spreadsheets/d/1HM_Jxv6zQzr-O5Spt06uq2HTyX1yFTVju2jzVjneL5M/export?format=csv&gid=172728277";

module.exports = async function handler(request, response) {
  try {
    const sheetResponse = await fetch(SHEET_CSV_URL);
    if (!sheetResponse.ok) throw new Error(`Google Sheet returned ${sheetResponse.status}`);

    response.setHeader("content-type", "text/csv; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.status(200).send(await sheetResponse.text());
  } catch (error) {
    response.setHeader("cache-control", "no-store");
    response.status(502).send(`Google Sheet load failed: ${error.message}`);
  }
};
