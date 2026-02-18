import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import EventEmitter from "eventemitter3";

interface GatewayClientConfig {
	url: string;
	token: string;
	reconnectInterval: number;
	maxRetries: number;
}

type Pending = {
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
};

interface GatewayFrame {
	type: "req" | "res" | "event";
	id?: string;
	method?: string;
	params?: unknown;
	ok?: boolean;
	result?: unknown;
	error?: unknown;
	payload?: unknown;
	event?: string;
}

/**
 * WebSocket client for OpenClaw Gateway
 * - Connects to ws://127.0.0.1:18789
 * - Handles JSON-RPC requests/responses
 * - Emits events: agent, health, cron, chat
 * - Auto-reconnects on disconnect
 */
export class GatewayClient extends EventEmitter {
	private ws: WebSocket | null = null;
	private config: Required<GatewayClientConfig>;
	private pending = new Map<string, Pending>();
	private backoffMs = 1000;
	private closed = false;
	private connectTimer: NodeJS.Timeout | null = null;
	private ready = false;

	constructor(config?: Partial<GatewayClientConfig>) {
		super();
		this.config = {
			url: config?.url ?? "ws://127.0.0.1:18789",
			token: config?.token ?? "",
			reconnectInterval: config?.reconnectInterval ?? 1000,
			maxRetries: config?.maxRetries ?? 60,
		};
	}

	start(): void {
		if (this.closed) {
			return;
		}
		this.doConnect();
	}

	stop(): void {
		this.closed = true;
		if (this.connectTimer) {
			clearTimeout(this.connectTimer);
			this.connectTimer = null;
		}
		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}
	}

	isReady(): boolean {
		return this.ready;
	}

	private doConnect(): void {
		if (this.closed || this.ws) {
			return;
		}

		this.ws = new WebSocket(this.config.url, {
			maxPayload: 25 * 1024 * 1024,
		});

		this.ws.on("open", () => {
			this.backoffMs = 1000;
			// Gateway sends 'connect.challenge' event first
		});

		this.ws.on("message", (data: Buffer) => {
			this.handleMessage(data.toString());
		});

		this.ws.on("error", (err) => {
			this.emit("error", err);
		});

		this.ws.on("close", () => {
			this.ws = null;
			this.ready = false;
			this.emit("disconnected");
			if (!this.closed) {
				this.scheduleReconnect();
			}
		});
	}

	private sendConnectHandshake(): void {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			return;
		}

		const id = randomUUID();

		const frame: GatewayFrame = {
			type: "req",
			id,
			method: "connect",
			params: {
				minProtocol: 3,
				maxProtocol: 3,
				client: {
					id: "cli",
					displayName: "OpenAlerts Monitor",
					version: "0.1.0",
					platform: process.platform,
					mode: "cli",
				},
				role: "operator",
				scopes: ["operator.read"],
				caps: [],
				commands: [],
				permissions: {},
				locale: "en-US",
				userAgent: "openalerts-monitor/0.1.0",
				auth: this.config.token ? { token: this.config.token } : undefined,
			},
		};

		this.pending.set(id, {
			resolve: (result: unknown) => {
				this.ready = true;
				this.emit("ready", result);
			},
			reject: (err: Error) => {
				this.emit(
					"error",
					new Error(`Connect handshake failed: ${err.message}`),
				);
			},
		});

		this.ws.send(JSON.stringify(frame));
	}

	private handleMessage(raw: string): void {
		try {
			const frame: GatewayFrame = JSON.parse(raw);

			// Handle challenge-response auth (like crabwalk)
			if (frame.type === "event" && frame.event === "connect.challenge") {
				this.sendConnectHandshake();
				return;
			}

			if (frame.type === "res") {
				const pending = this.pending.get(frame.id!);
				if (pending) {
					if (frame.error || frame.ok === false) {
						const errMsg =
							typeof frame.error === "string"
								? frame.error
								: typeof frame.payload === "object" &&
									  frame.payload &&
									  "message" in frame.payload
									? String((frame.payload as Record<string, unknown>).message)
									: JSON.stringify(frame.error ?? frame.payload);
						pending.reject(new Error(errMsg));
					} else {
						pending.resolve(frame.payload ?? frame.result);
					}
					this.pending.delete(frame.id!);
				}
			} else if (frame.type === "event") {
				// Emit the event for subscribers: agent, health, cron, chat
				this.emit(frame.event!, frame.payload);
			}
		} catch (err) {
			this.emit("error", new Error(`Failed to parse frame: ${err}`));
		}
	}

	/**
	 * Send RPC request to gateway
	 * @example
	 * const cost = await client.request("usage.cost", { period: "day" });
	 * const sessions = await client.request("sessions.list");
	 */
	request<T = unknown>(method: string, params?: unknown): Promise<T> {
		if (!this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
			return Promise.reject(new Error("Gateway not ready"));
		}

		const id = randomUUID();

		return new Promise<T>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Request timeout: ${method}`));
			}, 10000);

			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timeout);
					resolve(value as T);
				},
				reject: (err) => {
					clearTimeout(timeout);
					reject(err);
				},
			});

			const frame: GatewayFrame = {
				type: "req",
				id,
				method,
				params,
			};

			if (!this.ws) {
				this.pending.delete(id);
				clearTimeout(timeout);
				reject(new Error("WebSocket not connected"));
				return;
			}
			this.ws.send(JSON.stringify(frame));
		});
	}

	private scheduleReconnect(): void {
		if (this.connectTimer) {
			clearTimeout(this.connectTimer);
		}

		this.connectTimer = setTimeout(() => {
			this.backoffMs = Math.min(this.backoffMs * 2, 60000);
			this.doConnect();
		}, this.backoffMs);
	}
}
