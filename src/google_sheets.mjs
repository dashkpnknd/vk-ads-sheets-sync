import { getGoogleAccessToken } from "./google_service_account.mjs";

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function googleJson(token, url, options = {}) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(url, {
      ...options,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (response.ok) return data;

    lastError = new Error(`${options.method || "GET"} ${url} failed: ${response.status} ${JSON.stringify(data)}`);
    if (response.status !== 429 && response.status < 500) break;

    const retryAfter = Number(response.headers.get("retry-after")) || 0;
    const backoff = retryAfter > 0 ? retryAfter * 1000 : 5000 * (attempt + 1);
    await sleep(backoff);
  }

  throw lastError;
}

export class GoogleSheetsClient {
  constructor({ credentialsPath }) {
    this.credentialsPath = credentialsPath;
    this.token = null;
    this.tokenExpiresAt = 0;
    this.nextRequestAt = 0;
  }

  async accessToken({ force = false } = {}) {
    if (force || !this.token || Date.now() >= this.tokenExpiresAt) {
      this.token = await getGoogleAccessToken(this.credentialsPath, [SHEETS_SCOPE]);
      // Google service-account tokens are valid for one hour. Renew early during long VK scans.
      this.tokenExpiresAt = Date.now() + 50 * 60 * 1000;
    }
    return this.token;
  }

  async getSpreadsheet(spreadsheetId) {
    const token = await this.accessToken();
    return this.googleJson(
      token,
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=properties.title,sheets.properties(title,sheetId)`,
    );
  }

  async readValues(spreadsheetId, range) {
    const token = await this.accessToken();
    const data = await this.googleJson(
      token,
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`,
    );
    return data.values || [];
  }

  async batchUpdateValues(spreadsheetId, updates) {
    const token = await this.accessToken();
    return this.googleJson(
      token,
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`,
      {
        method: "POST",
        body: JSON.stringify({
          valueInputOption: "USER_ENTERED",
          data: updates,
        }),
      },
    );
  }

  async clearValues(spreadsheetId, ranges) {
    const token = await this.accessToken();
    return this.googleJson(
      token,
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchClear`,
      {
        method: "POST",
        body: JSON.stringify({ ranges }),
      },
    );
  }

  async batchUpdateSpreadsheet(spreadsheetId, requests) {
    const token = await this.accessToken();
    return this.googleJson(
      token,
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
      {
        method: "POST",
        body: JSON.stringify({ requests }),
      },
    );
  }


  async duplicateSheet(spreadsheetId, sourceSheetId, newSheetName) {
    const result = await this.batchUpdateSpreadsheet(spreadsheetId, [{
      duplicateSheet: {
        sourceSheetId,
        newSheetName,
      },
    }]);
    return result.replies?.[0]?.duplicateSheet?.properties || null;
  }

  async ensureSheet(spreadsheetId, sheetName) {
    const spreadsheet = await this.getSpreadsheet(spreadsheetId);
    if (spreadsheet.sheets.some((sheet) => sheet.properties.title === sheetName)) {
      return;
    }
    const token = await this.accessToken();
    await this.googleJson(
      token,
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
      {
        method: "POST",
        body: JSON.stringify({
          requests: [{ addSheet: { properties: { title: sheetName } } }],
        }),
      },
    );
  }

  async googleJson(token, url, options = {}) {
    const now = Date.now();
    if (now < this.nextRequestAt) {
      await sleep(this.nextRequestAt - now);
    }
    this.nextRequestAt = Date.now() + 1100;
    try {
      return await googleJson(token, url, options);
    } catch (error) {
      if (!String(error.message).includes("ACCESS_TOKEN_EXPIRED")) throw error;
      this.token = null;
      this.tokenExpiresAt = 0;
      return googleJson(await this.accessToken({ force: true }), url, options);
    }
  }
}
