export async function listPages(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) {
    throw new Error(`Cannot list CDP pages on port ${port}: ${response.status}`);
  }
  return response.json();
}

export async function firstPage(port) {
  const pages = await listPages(port);
  const page = pages.find((item) => item.type === "page" && item.url.startsWith("http"));
  if (!page) {
    throw new Error(`No web page found on port ${port}`);
  }
  return page;
}

export class CdpClient {
  constructor(webSocketDebuggerUrl) {
    this.webSocketDebuggerUrl = webSocketDebuggerUrl;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    const WebSocketImpl = globalThis.WebSocket || (await import("ws")).default;
    this.ws = new WebSocketImpl(this.webSocketDebuggerUrl);
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
    this.ws.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("CDP connection closed"));
      }
      this.pending.clear();
    });
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`CDP command timed out after ${CDP_COMMAND_TIMEOUT_MS}ms: ${method}`));
      }, CDP_COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timeout });
      try {
        this.ws.send(payload);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  close() {
    this.ws?.close();
  }
}

export async function withPage(port, callback) {
  const page = await firstPage(port);
  const client = new CdpClient(page.webSocketDebuggerUrl);
  await client.connect();
  try {
    return await callback(client, page);
  } finally {
    client.close();
  }
}
const CDP_COMMAND_TIMEOUT_MS = 30_000;
