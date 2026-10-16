import debug from "debug";

const DEBUG = debug("services:clients:zotero-stream");

const HEARTBEAT_INTERVAL = 5 * 60 * 1000;
const HEARTBEAT_TIMEOUT = 30 * 1000;
const MAX_RECONNECT_DELAY = 10 * 60 * 1000;

export interface ZoteroStreamHandlers {
  /** Subscribed and receiving events. Sync now, since changes may have been missed while disconnected. */
  onConnected(): void;
  /** The library changed and is now at this version. */
  onUpdated(version: number): void;
  /** No longer receiving events; will keep trying to reconnect. */
  onDisconnected(): void;
}

// Push notifications of library changes: https://www.zotero.org/support/dev/web_api/v3/streaming_api
export class ZoteroStream {
  private ws: WebSocket | null = null;
  private topic: string;
  private subscribed = false;
  private retryDelay = 10000;
  private failures = 0;
  private heartbeatInterval?: NodeJS.Timeout;
  private heartbeatTimeout?: NodeJS.Timeout;

  constructor(
    private apiKey: string,
    userId: string,
    private handlers: ZoteroStreamHandlers,
    private url = "wss://stream.zotero.org",
  ) {
    this.topic = `/users/${userId}`;
  }

  get connected() {
    return this.subscribed;
  }

  connect() {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    // Events from a connection we've already given up on are ignored.
    ws.onmessage = (e) => ws === this.ws && this.onMessage(JSON.parse(e.data.toString()));
    ws.onclose = (e) => ws === this.ws && this.disconnected(`closed (${e.code} ${e.reason})`);
    ws.onerror = () => ws === this.ws && this.disconnected("errored");
  }

  private subscribe() {
    this.ws?.send(JSON.stringify({
      action: "createSubscriptions",
      subscriptions: [{ apiKey: this.apiKey, topics: [this.topic] }],
    }));
  }

  private onMessage(msg: any) {
    switch (msg.event) {
      case "connected":
        if (msg.retry) this.retryDelay = msg.retry;
        this.subscribe();
        break;

      case "subscriptionsCreated": {
        clearTimeout(this.heartbeatTimeout);
        const ok = msg.subscriptions?.some((s: any) => s.topics?.includes(this.topic));
        if (!ok) {
          this.disconnected(`subscription failed: ${JSON.stringify(msg.errors)}`);
        } else if (!this.subscribed) {
          DEBUG(`Subscribed to ${this.topic}.`);
          this.subscribed = true;
          this.failures = 0;
          this.startHeartbeat();
          this.handlers.onConnected();
        }
        break;
      }

      case "topicUpdated":
        if (msg.topic === this.topic) this.handlers.onUpdated(msg.version);
        break;
    }
  }

  // A silently dropped connection never fires a close event, so periodically re-send the subscription (which the
  // server treats as a no-op) and give up on the connection if it doesn't answer.
  private startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      this.subscribe();
      this.heartbeatTimeout = setTimeout(() => this.disconnected("heartbeat timed out"), HEARTBEAT_TIMEOUT);
    }, HEARTBEAT_INTERVAL);
  }

  private disconnected(reason: string) {
    const wasSubscribed = this.subscribed;
    const ws = this.ws;
    this.ws = null;
    this.subscribed = false;
    clearInterval(this.heartbeatInterval);
    clearTimeout(this.heartbeatTimeout);
    try { ws?.close(); } catch (ex) {}

    const delay = Math.min(this.retryDelay * 2 ** this.failures++, MAX_RECONNECT_DELAY);
    DEBUG(`Stream ${reason}, reconnecting in ${delay / 1000}s.`);
    if (wasSubscribed) this.handlers.onDisconnected();
    setTimeout(() => this.connect(), delay);
  }
}
