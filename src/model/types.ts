/**
 * ModelClient interface (NF-3).
 *
 * One interface, three implementations: AnthropicClient (real calls),
 * RecordingClient (wraps real, writes fixtures), ReplayClient (test harness).
 *
 * Every model call in the system goes through this interface so that
 * recorded responses can be replayed in the test suite without touching
 * loop logic.
 */

export interface ModelRequest {
  /** The task being performed (e.g. "retrieve", "decide", "plan"). */
  task: string;
  /** System prompt for the model. */
  system: string;
  /** User message content. */
  messages: MessagePart[];
}

export interface MessagePart {
  role: "user" | "assistant";
  content: string;
}

export interface ModelResponse {
  /** The model's text response. */
  content: string;
  /** Model identifier that produced the response. */
  model: string;
  /** Token usage, if available. */
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface ModelClient {
  complete(req: ModelRequest): Promise<ModelResponse>;
}
